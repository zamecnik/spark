import { TslNode } from './packedSplatsTsl';
import { SplatNodeMaterial } from './SplatNodeMaterial';
import type * as THREE from "three";
type SplatEncodingLike = {
    rgbMin?: number;
    rgbMax?: number;
    lnScaleMin?: number;
    lnScaleMax?: number;
    sh1Max?: number;
    sh2Max?: number;
    sh3Max?: number;
    lodOpacity?: boolean;
};
type PackedSplatsLike = {
    numSplats: number;
    packedArray: Uint32Array | null;
    lodSplats?: PackedSplatsLike;
    splatEncoding?: SplatEncodingLike;
    getTexture(): THREE.DataArrayTexture;
    getNumSh(): number;
    ensureShTextures(): {
        sh1Texture?: {
            value: THREE.DataArrayTexture;
        };
        sh2Texture?: {
            value: THREE.DataArrayTexture;
        };
        sh3Texture?: {
            value: THREE.DataArrayTexture;
        };
    };
};
type SplatPagerLike = {
    packedTexture: {
        value: THREE.DataArrayTexture;
    };
    sh1Texture: {
        value: THREE.DataArrayTexture;
    };
    sh2Texture: {
        value: THREE.DataArrayTexture;
    };
    sh3Texture: {
        value: THREE.DataArrayTexture;
    };
    maxSh: number;
};
type PagedSplatsLike = {
    numSplats: number;
    numSh: number;
    maxSh: number;
    pager?: SplatPagerLike;
    splatEncoding?: SplatEncodingLike;
    dynoIndices: {
        value: THREE.DataTexture;
    };
};
type SplatMeshLike = THREE.Object3D & {
    packedSplats?: PackedSplatsLike;
    paged?: PagedSplatsLike;
    maxSh?: number;
    mappingVersion?: number;
    context?: {
        numSplats?: {
            value: number;
        };
        enableLod?: {
            value: boolean;
        };
        lodIndices?: {
            value: unknown;
        };
    };
};
type LodInstanceLike = {
    numSplats: number;
    indices: Uint32Array;
    texture: THREE.DataTexture;
};
type SparkRendererLike = THREE.Mesh & {
    renderer: {
        compute(nodes: TslNode | TslNode[], dispatchSize?: unknown): void;
    };
    activeSplats: number;
    sortRadial?: boolean;
    maxStdDev: number;
    minPixelRadius: number;
    maxPixelRadius: number;
    ssogFillV2: boolean;
    ssogMinContribution: number;
    pickMode?: number;
    pickNear?: number;
    pickFar?: number;
    minAlpha: number;
    preBlurAmount: number;
    blurAmount: number;
    falloff: number;
    clipXY: number;
    focalAdjustment: number;
    renderSize: THREE.Vector2;
    setDirty?: () => void;
    lodInstances?: Map<unknown, LodInstanceLike>;
};
type SourceKind = "static" | "lodPacked" | "paged";
/** What prepare() did (telemetry + the harness). */
export type WebGpuSplatPrepareReport = {
    /** true when every step ran; false = skipped or failed (see reason/error) */
    ok: boolean;
    reason?: "busy" | "empty" | "no-renderer" | "failed";
    error?: string;
    /** texture layers uploaded one per step (static sources) */
    uploadedLayers: number;
    /** compute pipelines created through createComputePipelineAsync */
    asyncComputePipelines: number;
    /** ... of which fell back to the synchronous path (async rejected / timed out) */
    syncFallbacks: number;
    /** the draw pipeline went through renderer.compileAsync */
    renderCompiled: boolean;
    ms: {
        state: number;
        bounds: number;
        upload: number;
        compute: number;
        render: number;
        total: number;
    };
};
export declare class WebGpuSplatBackend {
    placeholderMaterial: THREE.Material;
    sortRadial: boolean;
    sortKeyLog: boolean;
    freezeOrder: boolean;
    vsMinimal: number;
    parityQuantize: boolean;
    batchSize: number;
    projectorEnabled: boolean;
    sortBits: number;
    sortDigits: number;
    sortTpw: number;
    sortVisible: boolean;
    cachePack: number;
    frames: number;
    sorts: number;
    lastSortFrame: number;
    rebuilds: number;
    prepareNewStates: boolean;
    onPrepared: ((report: WebGpuSplatPrepareReport) => void) | null;
    lastPrepareReport: WebGpuSplatPrepareReport | null;
    private state;
    private autoPrepareBroken;
    private prepareScheduled;
    private sortedOnce;
    private warnedMultiMesh;
    private preparing;
    private needsRebuild;
    constructor();
    update({ spark, scene, camera, viewChanged, }: {
        spark: SparkRendererLike;
        scene: THREE.Scene;
        camera: THREE.Camera;
        viewChanged: boolean;
    }): boolean;
    /**
     * [full-3] Get `mesh` ready for its first frame WITHOUT freezing the
     * browser. Optional: a host that never calls it renders exactly as before.
     *
     * The first frame of a new state creates ~12 compute pipelines (keygen or
     * projector + the radix passes) and the draw pipeline through three's
     * SYNCHRONOUS entry points. Chrome compiles those (DXC on D3D12) on the GPU
     * process MAIN thread - the thread that also draws the browser's own UI.
     * Measured 2026-09-27 on a 4.6M-splat static scene: ~1.1 s of compiles in
     * 621 + 659 ms blocks, during which the whole browser froze (tabs could
     * not be switched), plus a 684 ms main-thread first render. The ASYNC
     * entry points compile on GPU-process worker threads, in parallel
     * (measured: 8 heavy shaders 7.5 s serial on the main thread vs 1.4 s with
     * the GPU main thread busy for 1 ms).
     *
     * So, before the mesh is shown, prepare():
     *   1. builds the state for `mesh` (as the first update() would),
     *   2. runs the static bounds scan in chunks (update() then skips it),
     *   3. dry-runs every compute node the first frame dispatches through
     *      three's own renderer.compute() - bindings, uploads, node building,
     *      dispose bookkeeping all exactly as a real first dispatch - with the
     *      dispatch disabled and each new pipeline's descriptor handed to
     *      createComputePipelineAsync instead of the synchronous create,
     *   4. compiles the draw pipeline through renderer.compileAsync,
     * yielding to the page between steps. While it runs, update() dispatches
     * and draws nothing; the SparkRenderer draws its placeholder material so
     * the host's render loop cannot create the draw pipeline synchronously.
     *
     * Never rejects, never strands a loading screen, and its worst case is the
     * old behaviour: a compute pipeline whose async creation rejects or does
     * not settle within PREPARE_PIPELINE_TIMEOUT_MS is created the synchronous
     * way (errors surface as before); a compute step that fails or leaves a
     * pipeline slot empty makes the next update() rebuild the state the old
     * way; a texture whose layered upload broke off gets one full upload on
     * its next bind; the draw pipeline's compile is awaited for at most the
     * same timeout (a pipeline already being created is waited for by three's
     * isReady check; a compile that hung before that point is created
     * synchronously by the first frame). report.ok is false on any of it.
     */
    prepare(options: {
        spark: SparkRendererLike;
        mesh: SplatMeshLike;
        scene: THREE.Scene;
        camera: THREE.Camera;
        onProgress?: (done: number, total: number) => void;
        /** per pipeline step (compute settle, draw compile); default 30 s */
        timeoutMs?: number;
    }): Promise<WebGpuSplatPrepareReport>;
    /** [full-3b] a prepare() is scheduled or running: nothing is drawn yet. */
    get isPreparing(): boolean;
    private drawNothing;
    private schedulePrepare;
    private prepareOnce;
    private sortDispatchPlan;
    private firstFrameComputeNodes;
    private staticUploadLayers;
    private prepareBounds;
    private dryRunCompute;
    private settleJobs;
    applyPerFrame(spark: SparkRendererLike, camera: THREE.Camera): void;
    private syncUniforms;
    getState(): {
        kind: SourceKind;
        numSplats: number;
        capacity: number;
        numShBound: number;
        material: SplatNodeMaterial;
        sortedValues: TslNode;
        keysNode: TslNode;
        visCountAttr: THREE.BufferAttribute | null;
    } | null;
    private findSplatMesh;
    private currentEncoding;
    private resolveSource;
    private stateMatches;
    private buildState;
    private updateBounds;
    private updateKeygenUniforms;
}
export {};

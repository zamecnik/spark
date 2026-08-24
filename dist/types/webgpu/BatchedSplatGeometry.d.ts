import * as THREE from "three";
export declare class BatchedSplatGeometry extends THREE.InstancedBufferGeometry {
    readonly batchSize: number;
    constructor(batchSize: number);
}

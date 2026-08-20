
precision highp float;
precision highp int;

#include <splatDefines>

uniform float near;
uniform float far;
uniform bool encodeLinear;
uniform float time;
uniform bool debugFlag;
uniform float maxStdDev;
uniform float minAlpha;
uniform bool disableFalloff;
uniform float falloff;
// Kroscloud fork [ssog-9]: expected-depth PICK mode (Viewme splat-measurement
// precision plan, Track A). Runtime-uniform gated — pickMode 0 (default) is
// the unchanged premultiplied color output (byte-identical, P4 floor);
// pickMode 1 emits premultiplied (normDepth·a, 0, 0, a) so the existing
// ONE/ONE_MINUS_SRC_ALPHA blend over a (0,0,0,0)-cleared RGBA16F target
// accumulates R = Σ aᵢdᵢ·Tᵢ, A = 1−T and the reader recovers the
// transmittance-weighted expected depth as R/A (supersplat picker.ts
// semantics). pickNear/pickFar are DEDICATED normalization bounds for the
// fp16 quantization window — the camera's own near/far (and every vertex
// cull) stay untouched, so the pick footprint equals the displayed one.
// The identity holds BECAUSE both legs draw back-to-front under this blend
// (P0c); a sort-direction change must re-verify it. TSL twin:
// webgpu/SplatNodeMaterial.ts.
uniform float pickMode;
uniform float pickNear;
uniform float pickFar;

out vec4 fragColor;

in vec4 vRgba;
in vec2 vSplatUv;
in vec3 vNdc;
flat in uint vSplatIndex;
flat in float adjustedStdDev;
in float vViewZ;

#include <logdepthbuf_pars_fragment>

void main() {
    vec4 rgba = vRgba;

    float z2 = dot(vSplatUv, vSplatUv);
    if (z2 > (adjustedStdDev * adjustedStdDev)) {
        discard;
    }

    if (false) {
    // if (debugFlag) {
        float a = rgba.a;
        float shifted = sqrt(z2) - max(0.0, a - 1.0);
        float exponent = -0.5 * max(1.0, a) * sqr(max(0.0, shifted));
        float min1a = min(1.0, a);
        rgba.a = mix(min1a, min1a * exp(exponent), falloff);
    } else {
        // New falloff function, more or less equivalent
        if (rgba.a <= 1.0) {
            rgba.a = mix(rgba.a, rgba.a * exp(-0.5 * z2), falloff);
        } else {
            float a = exp((rgba.a*rgba.a - 1.0) / 2.718281828459045);
            float alpha = 1.0 - pow(1.0 - exp(-0.5 * z2), a);
            rgba.a = mix(1.0, alpha, falloff);
        }
    }

    if (rgba.a < minAlpha) {
        discard;
    }
    if (encodeLinear) {
        rgba.rgb = srgbToLinear(rgba.rgb);
    }

    #ifdef PREMULTIPLIED_ALPHA
        // [ssog-9] pick branch lives ONLY in the premultiplied arm: the
        // #else arm pairs with SRC_ALPHA/OMSA blending, under which a·d
        // would be alpha-multiplied a second time and R/A breaks silently.
        if (pickMode > 0.5) {
            float normDepth = (-vViewZ - pickNear) / (pickFar - pickNear);
            fragColor = vec4(normDepth * rgba.a, 0.0, 0.0, rgba.a);
        } else {
            fragColor = vec4(rgba.rgb * rgba.a, rgba.a);
        }
    #else
        fragColor = rgba;
    #endif

    #include <logdepthbuf_fragment>
}

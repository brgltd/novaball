/**
 * NOVABALL render-world — custom post effects (merged into the single EffectPass).
 *
 * NovaHDREffect (before bloom/tone mapping, HDR linear):
 *   radial chromatic aberration (supersonic only), supersonic radial speed lines, ZERO-G SURGE violet grade,
 *   full-screen flash (exposure punch + coloured lift), exposure.
 * NovaLDREffect (after tone mapping):
 *   replay look (letterbox bars + film grain + slight split-tone), pause (dim + desaturate), surge vignette pulse.
 */
import { BlendFunction, Effect } from 'postprocessing';
import { Color, Uniform } from 'three';
import { GLSL_HASH } from './glsl';

const HDR_FRAG = /* glsl */ `
uniform float uCA;
uniform float uLines;
uniform float uSurge;
uniform vec3 uFlashColor;
uniform float uFlash;
uniform float uExposure;
uniform float uTime;
uniform float uSaturation;
${GLSL_HASH}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = inputColor.rgb;
  vec2 dc = uv - 0.5;
  // radial chromatic aberration (supersonic only, stronger toward the edges). inputColor is already
  // anti-aliased by SMAA while inputBuffer is not: add only the fringe DELTA of the shifted taps so the red/blue
  // channels keep their SMAA edges (replacing them outright brought the jaggies back in R and B).
  if (uCA > 0.00005) {
    vec2 off = dc * uCA * (0.35 + 2.4 * dot(dc, dc));
    vec3 raw = texture2D(inputBuffer, uv).rgb;
    c.r = max(c.r + texture2D(inputBuffer, uv - off).r - raw.r, 0.0);
    c.b = max(c.b + texture2D(inputBuffer, uv + off).b - raw.b, 0.0);
  }
  // supersonic speed lines: thin radial dashes streaming outward
  if (uLines > 0.002) {
    vec2 d = dc * vec2(aspect, 1.0);
    float r = length(d);
    // atan(0, 0) is undefined: the exact centre pixel exists on odd-sized buffers (render scale)
    float ang = r > 1e-5 ? atan(d.y, d.x) : 0.0;
    float N = 120.0;
    float a = (ang / 6.2831853 + 0.5) * N;
    float id = floor(a);
    float f = fract(a) - 0.5;
    float rnd = nbHash11(id * 1.73 + 3.1);
    float lineOn = step(0.72, rnd);
    float w = 0.04 + 0.08 * nbHash11(id + 7.7);
    float streak = 1.0 - smoothstep(w * 0.3, w, abs(f));
    float speed = 1.6 + 2.6 * nbHash11(id + 1.1);
    float ph = fract(r * 0.9 - uTime * speed + rnd * 13.0);
    float dash = smoothstep(0.0, 0.05, ph) * (1.0 - smoothstep(0.08, 0.32, ph));
    float mask = smoothstep(0.42, 0.95, r);
    c += vec3(0.7, 0.85, 1.0) * lineOn * streak * dash * mask * uLines * 0.38;
  }
  // saturation (pre tone mapping)
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = max(mix(vec3(l), c, uSaturation), 0.0);
  // ZERO-G SURGE grade: shift toward violet, lift shadows. Saturated and bright emitters (team goals, trims, lights)
  // are protected so VOLT stays cyan and BLAZE stays orange while the dark mood (sky, stands, floor) turns violet.
  if (uSurge > 0.001) {
    vec3 violet = vec3(0.56, 0.30, 1.0);
    vec3 g = mix(c * vec3(0.9, 0.82, 1.12), l * violet * 1.6, 0.3) + violet * 0.008;
    float mx = max(c.r, max(c.g, c.b));
    float sat = mx > 1e-4 ? (mx - min(c.r, min(c.g, c.b))) / mx : 0.0;
    float protect = clamp(0.6 * sat + smoothstep(0.8, 3.0, l), 0.0, 0.9);
    c = mix(c, g, uSurge * (1.0 - protect));
  }
  // full-screen flash: mostly an exposure punch (lights flare through bloom) + a coloured lift that only
  // applies to lit pixels (lifting the blacks turned the frame into a flat wash)
  c = c * (1.0 + uFlash * 1.6) + uFlashColor * uFlash * 0.55 * smoothstep(0.0, 0.4, l);
  c *= uExposure;
  // NaN / Inf guard (last, so nothing computed above can leak a bad pixel): one bad pixel from any material must
  // not poison the frame
  if (any(isnan(c)) || any(isinf(c)) || !(c.r <= 1e4 && c.g <= 1e4 && c.b <= 1e4)) c = vec3(0.0);
  outputColor = vec4(c, inputColor.a);
}
`;

export class NovaHDREffect extends Effect {
  constructor() {
    super('NovaHDREffect', HDR_FRAG, {
      blendFunction: BlendFunction.SRC,
      uniforms: new Map<string, Uniform>([
        ['uCA', new Uniform(0)],
        ['uLines', new Uniform(0)],
        ['uSurge', new Uniform(0)],
        ['uFlashColor', new Uniform(new Color(1, 1, 1))],
        ['uFlash', new Uniform(0)],
        ['uExposure', new Uniform(1)],
        ['uTime', new Uniform(0)],
        ['uSaturation', new Uniform(1.04)],
      ]),
    });
  }

  u(name: string): Uniform {
    return this.uniforms.get(name) as Uniform;
  }
}

const LDR_FRAG = /* glsl */ `
uniform float uPause;
uniform float uGrain;
uniform float uLetterbox;
uniform float uPulse;
uniform float uTime;
${GLSL_HASH}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = inputColor.rgb;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  // pause: dim + desaturate
  c = mix(c, vec3(l) * 0.4 + c * 0.08, uPause * 0.88);
  // replay: film grain + subtle split tone
  if (uGrain > 0.001) {
    float n = nbHash12(uv * resolution + fract(uTime * 13.7) * 311.0) - 0.5;
    c += n * 0.075 * uGrain * (0.35 + l);
    c = mix(c, c * vec3(1.04, 1.0, 0.94) + vec3(0.0, 0.003, 0.012), uGrain * 0.7);
  }
  // surge vignette pulse
  vec2 d = uv - 0.5;
  c *= 1.0 - uPulse * smoothstep(0.06, 0.5, dot(d, d)) * 0.7;
  // letterbox
  float bar = 0.105 * uLetterbox;
  float px = 1.5 / resolution.y;
  float lb = (1.0 - smoothstep(bar - px, bar, uv.y)) + smoothstep(1.0 - bar, 1.0 - bar + px, uv.y);
  c = mix(c, vec3(0.0), clamp(lb, 0.0, 1.0) * step(0.001, uLetterbox));
  outputColor = vec4(c, inputColor.a);
}
`;

export class NovaLDREffect extends Effect {
  constructor() {
    super('NovaLDREffect', LDR_FRAG, {
      blendFunction: BlendFunction.SRC,
      uniforms: new Map<string, Uniform>([
        ['uPause', new Uniform(0)],
        ['uGrain', new Uniform(0)],
        ['uLetterbox', new Uniform(0)],
        ['uPulse', new Uniform(0)],
        ['uTime', new Uniform(0)],
      ]),
    });
  }

  u(name: string): Uniform {
    return this.uniforms.get(name) as Uniform;
  }
}

/**
 * Last effect of the chain: linear → sRGB. The renderer's output colour space is LINEAR (see PostFX), so the merged
 * EffectPass program is the same whether it renders to the canvas or into the dynamic-resolution upscale buffer.
 */
const OUT_FRAG = /* glsl */ `
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  outputColor = sRGBTransferOETF(vec4(max(inputColor.rgb, 0.0), inputColor.a));
}
`;

export class NovaOutputEffect extends Effect {
  constructor() {
    super('NovaOutputEffect', OUT_FRAG, { blendFunction: BlendFunction.SRC });
  }
}

/** Dynamic-resolution upscale to the canvas (input is already sRGB-encoded LDR). */
export const UPSCALE_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`;

/**
 * Bilinear upscale + light contrast-adaptive sharpening (CAS-like: strongest on soft, low-contrast detail such as
 * holo text and field-line edges, clamped to the local min/max so it never rings).
 */
export const UPSCALE_FRAG = /* glsl */ `
uniform sampler2D inputBuffer;
uniform vec2 uTexel;
uniform float uSharp;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(inputBuffer, vUv).rgb;
  if (uSharp > 0.001) {
    vec3 n = texture2D(inputBuffer, vUv + vec2(0.0, uTexel.y)).rgb;
    vec3 s = texture2D(inputBuffer, vUv - vec2(0.0, uTexel.y)).rgb;
    vec3 e = texture2D(inputBuffer, vUv + vec2(uTexel.x, 0.0)).rgb;
    vec3 w = texture2D(inputBuffer, vUv - vec2(uTexel.x, 0.0)).rgb;
    vec3 mn = min(c, min(min(n, s), min(e, w)));
    vec3 mx = max(c, max(max(n, s), max(e, w)));
    vec3 amp = sqrt(clamp(min(mn, 1.0 - mx) / max(mx, vec3(1e-4)), 0.0, 1.0)) * uSharp;
    c = clamp(c + (4.0 * c - n - s - e - w) * amp * 0.25, mn, mx);
  }
  gl_FragColor = vec4(c, 1.0);
}
`;

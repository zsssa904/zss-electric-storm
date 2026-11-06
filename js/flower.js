/**
 * 雷电花 · Electric Storm
 * ---------------------------------------------------------------------------
 * 每片“花瓣”不再是一块平滑曲面，而是由若干条折线电弧组成的放电束：
 *   · 主电弧沿花瓣中轴向外爬行，侧枝在末端炸开；
 *   · 花苞状态是一颗由同样粒子收束而成的电离球；
 *   · 顶点着色器在 aBud / aOpen 之间插值，并叠加高频电颤与爆闪；
 *   · 额外的 LineSegments 电弧层每帧重生成，负责“电击”的实时感。
 * 花体仍然只有一个 Points draw call；电弧层额外两个 draw call。
 */
import * as THREE from '../vendor/three.module.js';
import { CONFIG, clamp, smoothstep } from './config.js';

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const UP = new THREE.Vector3(0, 1, 0);

const COLORS = {
  abyss: new THREE.Color('#080b3f'),
  indigo: new THREE.Color('#2a24a8'),
  violet: new THREE.Color('#7458ff'),
  electric: new THREE.Color('#2f86ff'),
  cyan: new THREE.Color('#53e8ff'),
  ice: new THREE.Color('#c2f8ff'),
  white: new THREE.Color('#f4ffff'),
  spark: new THREE.Color('#ff6fe8'),
};

const ARC_CYAN = new THREE.Color('#9ff8ff');
const ARC_WHITE = new THREE.Color('#ffffff');
const ARC_VIOLET = new THREE.Color('#9f8cff');

/* ========================================================================== *
 *  工具
 * ========================================================================== */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2(a, b) {
  const x = Math.sin(a * 127.1 + b * 311.7) * 43758.5453123;
  return x - Math.floor(x);
}

let glowTexture = null;
/** 柔和的圆形光斑贴图，供花晕 / 星尘 / 电弧共用 */
export function getGlowTexture() {
  if (glowTexture) return glowTexture;
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0.0, 'rgba(255,255,255,1)');
  g.addColorStop(0.14, 'rgba(255,255,255,0.95)');
  g.addColorStop(0.38, 'rgba(230,250,255,0.34)');
  g.addColorStop(0.7, 'rgba(160,225,255,0.07)');
  g.addColorStop(1.0, 'rgba(120,200,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  glowTexture = new THREE.CanvasTexture(canvas);
  glowTexture.colorSpace = THREE.SRGBColorSpace;
  return glowTexture;
}

let shockTexture = null;
/** 爆闪用的锯齿电环贴图 */
function getShockTexture() {
  if (shockTexture) return shockTexture;
  const size = 512;
  const c = size / 2;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.translate(c, c);
  ctx.globalCompositeOperation = 'lighter';

  const ring = ctx.createRadialGradient(0, 0, c * 0.46, 0, 0, c * 0.92);
  ring.addColorStop(0, 'rgba(70,170,255,0)');
  ring.addColorStop(0.45, 'rgba(110,215,255,0.16)');
  ring.addColorStop(0.67, 'rgba(225,252,255,0.9)');
  ring.addColorStop(0.76, 'rgba(95,190,255,0.34)');
  ring.addColorStop(1, 'rgba(40,90,255,0)');
  ctx.fillStyle = ring;
  ctx.beginPath();
  ctx.arc(0, 0, c * 0.94, 0, Math.PI * 2);
  ctx.fill();

  for (let i = 0; i < 150; i++) {
    const a = Math.random() * Math.PI * 2;
    const inner = c * (0.56 + Math.random() * 0.1);
    const outer = c * (0.72 + Math.random() * 0.2);
    ctx.strokeStyle = `rgba(220,250,255,${0.08 + Math.random() * 0.3})`;
    ctx.lineWidth = 0.7 + Math.random() * 1.8;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * inner, Math.sin(a) * inner);
    ctx.lineTo(Math.cos(a + 0.012) * outer, Math.sin(a + 0.012) * outer);
    ctx.stroke();
  }

  shockTexture = new THREE.CanvasTexture(canvas);
  shockTexture.colorSpace = THREE.SRGBColorSpace;
  return shockTexture;
}

/* ========================================================================== *
 *  Shader
 * ========================================================================== */

const BOLT_VERT = /* glsl */ `
  uniform float uTime;
  uniform float uSpread;
  uniform float uPixelRatio;
  uniform vec2  uResolution;
  uniform vec2  uPointer;
  uniform float uPointerStrength;
  uniform float uSurge;
  uniform vec3  uFlashPos;
  uniform float uFlashPower;

  attribute vec3  aOpen;
  attribute vec3  aBud;
  attribute vec3  aVelocity;
  attribute vec3  aColor;
  attribute vec3  aBudColor;
  attribute float aScale;
  attribute float aAlpha;
  attribute float aDelay;
  attribute float aSeed;
  attribute float aGroup;
  attribute float aHot;
  attribute float aBudBoost;

  varying vec3  vColor;
  varying float vAlpha;
  varying float vHot;

  float easeInOutSine(float t) {
    return -(cos(3.141592653589793 * t) - 1.0) * 0.5;
  }

  void main() {
    float s = clamp(uSpread, 0.0, 1.0);

    // 每颗粒子有自己的开场时间：外层先炸，花心最后
    float local = (s - aDelay * 0.48) / max(1.0 - aDelay * 0.48, 0.001);
    local = easeInOutSine(clamp(local, 0.0, 1.0));

    vec3 pos = mix(aBud, aOpen, local);

    // ---- 初速度过冲：张开时先炸出去，再回弹；收拢时轻微挤压 ----------------
    float e = clamp(uSpread, 0.0, 1.0);
    float overshoot = 4.0 * e * (1.0 - e);
    float rebound = (smoothstep(0.72, 1.0, e) - 1.0)
      * smoothstep(0.0, 0.2, e); // e=0 时把 -1 关掉，保证几何逐像素复位
    pos += aVelocity * (overshoot * 0.28 + rebound * 0.28);
    float squeeze = 4.0 * (1.0 - e) * e;
    pos *= 1.0 - squeeze * 0.06;

    // ---- 电颤：同一根电弧共用一个 aGroup，所以弯曲是连贯的 ----------------
    float budMix = 1.0 - smoothstep(0.05, 0.45, s);
    float wobble = sin(uTime * (9.0 + aGroup * 11.0) + aGroup * 43.0 + aSeed * 3.0);
    float jitter = (0.006 + 0.022 * s + 0.014 * budMix) * wobble;
    pos.x += jitter * cos(aSeed * 51.0 + uTime * 4.0);
    pos.y += jitter * sin(aSeed * 37.0 + uTime * 3.2);
    pos.z += jitter * cos(aSeed * 29.0 + uTime * 2.7);

    // 雷球表面高频爆裂：低 spread 时粒子抖得更凶，像被电流撑开
    float crackle = sin(uTime * (31.0 + aSeed * 47.0) + aSeed * 91.0);
    pos.x += crackle * budMix * 0.012 * cos(aSeed * 17.0);
    pos.y += crackle * budMix * 0.012 * sin(aSeed * 23.0);
    pos.z += crackle * budMix * 0.012 * cos(aSeed * 29.0);

    // 稀疏的游离火花，向外飘
    float stray = smoothstep(0.72, 1.0, aSeed) * s;
    pos += normalize(vec3(
      cos(aSeed * 73.0),
      sin(aSeed * 59.0) * 0.7 + 0.25,
      cos(aSeed * 41.0)
    )) * stray * (0.05 + 0.11 * sin(uTime * 3.0 + aSeed * 20.0));

    // 绽放途中轻微旋开
    float swirl = sin(local * 3.14159265) * (aSeed - 0.5) * 0.42;
    float cs = cos(swirl);
    float sn = sin(swirl);
    pos.xz = mat2(cs, -sn, sn, cs) * pos.xz;

    vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mvPosition;

    // ---- 指尖斥力：电花在指尖附近会炸开 --------------------------------
    vec2 ndc = gl_Position.xy / max(gl_Position.w, 0.0001);
    float aspect = uResolution.x / max(uResolution.y, 1.0);
    vec2 d = vec2((ndc.x - uPointer.x) * aspect, ndc.y - uPointer.y);
    float dist = length(d);
    float influence = exp(-dist * dist * 9.0) * uPointerStrength * (0.35 + 0.65 * s);
    vec2 dir = dist > 0.0001 ? d / dist : vec2(0.0);
    gl_Position.xy += vec2(dir.x / aspect, dir.y) * influence * 0.32 * gl_Position.w;

    // ---- 闪烁 / 爆闪 -----------------------------------------------------
    float crack = 0.74 + 0.26 * sin(uTime * 25.0 + aGroup * 30.0 + aSeed * 9.0);
    float sizeBoost = 1.0 + uSurge * 0.6;
    gl_PointSize = aScale * uPixelRatio * crack
      * mix(1.28, 0.82 + 0.34 * s, smoothstep(0.0, 0.5, s))
      * sizeBoost * (1.0 + aBudBoost * budMix * 0.55);

    vColor = mix(aBudColor, aColor, smoothstep(0.0, 0.38, local));

    // ---- 虚拟照亮：强闪时从雷球中心向外照亮粒子内侧 ----------------------
    // pos 是 group 局部坐标，uFlashPos 也由 JS 写入局部中心 (0, 0.1, 0)
    vec3 toLight = uFlashPos - pos;
    float dL = length(toLight);
    vec3 dirL = toLight / max(dL, 0.001);
    vec3 nrm = normalize(pos + vec3(0.0001, 0.0, 0.0));
    float ndotl = max(dot(nrm, dirL), 0.0);
    float fall2 = 1.0 / (1.0 + dL * dL * 0.35);
    vColor += vec3(0.55, 0.85, 1.0) * (ndotl * fall2 * uFlashPower * 1.6);

    vHot = aHot * mix(0.5, 1.0, smoothstep(0.1, 0.7, s));
    // 电离球更紧、更亮；绽放后把普通粒子稍微压一点，避免过曝
    vAlpha = aAlpha
      * mix(0.76, 1.0, smoothstep(0.06, 0.52, s))
      * (0.72 + 0.28 * crack)
      * (1.0 + 0.9 * uSurge)
      * (1.0 + aBudBoost * budMix * 0.42);
  }
`;

const BOLT_FRAG = /* glsl */ `
  varying vec3  vColor;
  varying float vAlpha;
  varying float vHot;

  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float r = length(uv) * 2.0;
    if (r > 1.0) discard;

    float soft = pow(1.0 - r, 1.8);
    float core = pow(1.0 - r, 7.0);

    // 白色只留给电弧核心，粒子本体保留蓝紫色相
    vec3 tint = mix(vColor, vec3(0.86, 0.98, 1.0), clamp(core * (0.55 + 0.6 * vHot), 0.0, 1.0));
    vec3 color = tint * (1.35 + 2.2 * core) + vec3(0.12, 0.34, 0.6) * core * vHot;
    float alpha = (soft * 0.55 + core * 0.95) * vAlpha;

    gl_FragColor = vec4(color, alpha);

    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const SPARK_VERT = /* glsl */ `
  uniform float uTime;
  uniform float uSpread;
  uniform float uPixelRatio;
  uniform float uSurge;

  attribute vec3  aColor;
  attribute float aSeed;
  attribute float aScale;
  attribute float aAlpha;

  varying vec3  vColor;
  varying float vAlpha;
  varying float vHot;

  void main() {
    vec3 p = position;

    float angle = uTime * (0.05 + 0.16 * aSeed) + aSeed * 6.2831;
    float c = cos(angle);
    float s = sin(angle);
    p.xz = mat2(c, -s, s, c) * p.xz;
    p.y += sin(uTime * 0.6 + aSeed * 17.0) * 0.2;
    p *= mix(0.9, 1.18, uSpread);

    vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mvPosition;

    float flicker = 0.62 + 0.38 * sin(uTime * 18.0 + aSeed * 44.0);
    gl_PointSize = aScale * uPixelRatio * flicker * (1.0 + uSurge * 0.5);
    vColor = aColor;
    vHot = 0.2;
    vAlpha = aAlpha * mix(0.38, 1.0, uSpread) * (0.55 + 0.45 * flicker) * (1.0 + uSurge * 0.7);
  }
`;

const CORONA_VERT = /* glsl */ `
  uniform float uTime;
  uniform float uSpread;
  uniform float uPixelRatio;
  uniform float uSurge;

  attribute vec3  aColor;
  attribute float aSeed;
  attribute float aScale;

  varying vec3  vColor;
  varying float vAlpha;
  varying float vHot;

  void main() {
    float s = clamp(uSpread, 0.0, 1.0);
    float ang = atan(position.z, position.x)
      + uTime * (2.2 + aSeed * 6.0) * mix(1.0, 0.22, s);
    float rad = length(position.xz) * mix(1.0, 2.35, s) + s * 0.55;
    float flicker = 0.5 + 0.5 * sin(uTime * (26.0 + aSeed * 44.0) + aSeed * 71.0);
    flicker = pow(flicker, 2.2);

    vec3 p = vec3(
      cos(ang) * rad,
      position.y * mix(1.0, 1.45, s) + sin(uTime * 9.0 + aSeed * 33.0) * 0.035,
      sin(ang) * rad
    );
    p *= 1.0 + (flicker - 0.5) * 0.1;

    vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mvPosition;

    gl_PointSize = aScale * uPixelRatio * (0.7 + 0.8 * flicker) * (1.0 + uSurge * 0.65);
    vColor = aColor;
    vHot = aSeed;
    vAlpha = mix(0.9, 0.36, s) * (0.24 + 0.76 * flicker) * (1.0 + uSurge * 0.8);
  }
`;

const ARC_VERT = /* glsl */ `  attribute vec3  color;
  attribute float aAlpha;

  varying vec3  vColor;
  varying float vAlpha;

  void main() {
    vColor = color;
    vAlpha = aAlpha;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const ARC_FRAG = /* glsl */ `
  uniform float uOpacity;
  varying vec3  vColor;
  varying float vAlpha;

  void main() {
    gl_FragColor = vec4(vColor * 1.72, vAlpha * uOpacity);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const SKELETON_VERT = /* glsl */ `
  uniform float uTime;
  attribute float aAlpha;
  attribute float aSeed;
  attribute vec3  color;

  varying vec3  vColor;
  varying float vAlpha;

  void main() {
    float flicker = 0.68 + 0.32 * sin(uTime * (13.0 + aSeed * 21.0) + aSeed * 57.0);
    vColor = color;
    vAlpha = aAlpha * flicker;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/* ========================================================================== *
 *  Flower
 * ========================================================================== */

export class Flower {
  constructor(scene, particleCount = CONFIG.particles) {
    this.scene = scene;
    this.count = clamp(Math.round(particleCount), CONFIG.minParticles, CONFIG.maxParticles);
    this.rand = mulberry32(0x3f2a91d7);

    this.group = new THREE.Group();
    this.group.position.y = -0.16;
    this.scene.add(this.group);

    this.tips = [];
    this.petalMeta = [];
    this._skel = { pos: [], col: [], alpha: [], seed: [] };
    this._spread = 0;
    this._lastSpread = 0;
    this._surge = 0;
    this._shock = 0;
    this.flashPower = 0;

    this._buildAura();
    this._buildShockwave();
    this._buildFlower();
    this._buildArcs();
    this._buildSparks();
    this._buildCorona();

    this.uniforms = this.material.uniforms;
  }

  /* ------------------------------------------------------------------------ */
  _buildAura() {
    const tex = getGlowTexture();

    this.aura = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex,
      color: new THREE.Color('#1d4dff'),
      transparent: true,
      opacity: 0.12,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
    }));
    this.aura.scale.setScalar(6.6);
    this.aura.position.set(0, 0.22, -0.9);
    this.aura.renderOrder = -3;
    this.group.add(this.aura);

    this.auraCore = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex,
      color: new THREE.Color('#68e9ff'),
      transparent: true,
      opacity: 0.2,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
    }));
    this.auraCore.scale.setScalar(2.7);
    this.auraCore.position.set(0, 0.06, -0.8);
    this.auraCore.renderOrder = -2;
    this.group.add(this.auraCore);
  }

  /* ------------------------------------------------------------------------ */
  _buildShockwave() {
    const make = (color, opacity) => {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: getShockTexture(),
        color: new THREE.Color(color),
        transparent: true,
        opacity,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: false,
      }));
      sprite.position.set(0, 0.12, -0.5);
      sprite.renderOrder = -1;
      this.group.add(sprite);
      return sprite;
    };

    this.shockA = make('#bfefff', 0);
    this.shockA.scale.setScalar(1.4);
    this.shockB = make('#6aa8ff', 0);
    this.shockB.scale.setScalar(0.9);
    this.shockB.material.rotation = Math.PI * 0.21;
  }

  /* ------------------------------------------------------------------------ */
  _buildFlower() {
    const total = this.count;
    const layers = CONFIG.flower.layers;
    const layerCount = layers.length;
    const coreCount = Math.max(160, Math.round(total * CONFIG.flower.coreRatio));
    const petalTotal = total - coreCount;
    const weights = layers.map((l) => l.petals * l.length * l.width);
    const weightSum = weights.reduce((a, b) => a + b, 0);

    const open = new Float32Array(total * 3);
    const bud = new Float32Array(total * 3);
    const colors = new Float32Array(total * 3);
    const budColors = new Float32Array(total * 3);
    const scales = new Float32Array(total);
    const alphas = new Float32Array(total);
    const delays = new Float32Array(total);
    const seeds = new Float32Array(total);
    const groups = new Float32Array(total);
    const hots = new Float32Array(total);
    const budBoosts = new Float32Array(total);
    const velocities = new Float32Array(total * 3);

    const color = new THREE.Color();
    const budColor = new THREE.Color();
    let cursor = 0;

    // ---- 花瓣：每片由 5 条主电弧 + 4 条分叉电弧组成 ----------------------
    let allocated = 0;
    for (let li = 0; li < layerCount; li++) {
      const layer = layers[li];
      const layerShare = li === layerCount - 1
        ? petalTotal - allocated
        : Math.round((petalTotal * weights[li]) / weightSum);
      allocated += layerShare;

      const perPetal = Math.floor(layerShare / layer.petals);
      let spare = layerShare - perPetal * layer.petals;
      const layerRatio = lyri(li, layerCount);

      for (let pi = 0; pi < layer.petals; pi++) {
        const petalPts = perPetal + (spare > 0 ? 1 : 0);
        if (spare > 0) spare--;

        const angleBase = (pi / layer.petals) * TAU
          + layerRatio * 1.7
          + (this.rand() - 0.5) * 0.08;
        const lengthScale = 0.92 + this.rand() * 0.16;
        const widthScale = 0.9 + this.rand() * 0.18;
        const petalLength = layer.length * lengthScale;
        const petalWidth = layer.width * widthScale;

        // 每片花瓣补一条闭合的“叶形”折线轮廓，让粒子云有可读的花瓣形
        this._addPetalSpine(layer, angleBase, lengthScale, widthScale, li, pi);

        for (let k = 0; k < petalPts; k++) {
          const i = cursor++;

          // t 从花心到瓣尖；宽度在中段鼓起，两端收成尖
          const t = Math.pow(this.rand(), 0.72);
          const profile = Math.pow(Math.sin(Math.PI * Math.pow(t, 0.82)), 0.78);
          const halfW = petalWidth * 0.5 * profile;

          // 54% 沿左右轮廓，12% 在主脉，其余做内部稀疏填充
          const roll = this.rand();
          let lateral = 0;
          let edge = 0;
          let interior = false;
          if (roll < 0.62) {
            edge = 1;
            lateral = (this.rand() < 0.5 ? -1 : 1) * halfW * (0.88 + this.rand() * 0.12);
          } else if (roll < 0.72) {
            edge = 0.55;
            lateral = (this.rand() - 0.5) * halfW * 0.24;
          } else {
            interior = true;
            lateral = (this.rand() * 2 - 1) * halfW * 0.82;
          }

          // 同一层同一片的缺口用 hash 固定，折线不会每帧乱抖
          const jag = (hash2(li * 17.1 + pi * 5.7, Math.floor(t * 9)) - 0.5) * halfW * 0.12;
          lateral += jag * (edge ? 1 : 0.4);

          const radial = 0.18 + (petalLength - 0.18) * t;
          const height = layer.lift + 0.12 * Math.sin(Math.PI * t) + 0.07 * t * t;
          const px = Math.cos(angleBase) * radial - Math.sin(angleBase) * lateral;
          const pz = Math.sin(angleBase) * radial + Math.cos(angleBase) * lateral;
          const py = height + (edge ? (this.rand() - 0.5) * 0.024 : (this.rand() - 0.5) * 0.04);

          set3(open, i, px, py, pz);

          // ---- 花苞：收束成一颗带尖刺的电离球 --------------------------
          // 82% 填充球体，18% 沿 56 根放射细丝拉出短尖刺：
          // 球体负责“团”，细丝负责“雷电”的毛刺感。
          let bx;
          let by;
          let bz;
          let filament = false;
          if (this.rand() < 0.2) {
            filament = true;
            const strandIndex = i % 56;
            const az = hash2(strandIndex * 3.1, 7.7) * TAU;
            const yy = hash2(strandIndex * 5.7, 13.1) * 2 - 1;
            const horiz = Math.sqrt(Math.max(0, 1 - yy * yy));
            const rr = 0.46 + Math.pow(this.rand(), 0.55) * 0.7;
            const wobble = (hash2(i, Math.floor(rr * 9)) - 0.5) * 0.1;
            bx = Math.cos(az) * horiz * rr + wobble;
            by = 0.06 + yy * rr + wobble * 0.45;
            bz = Math.sin(az) * horiz * rr + wobble;
          } else {
            const rr = 0.28 + Math.pow(this.rand(), 0.48) * 0.52;
            const theta = this.rand() * TAU;
            const yy = this.rand() * 2 - 1;
            const horiz = Math.sqrt(Math.max(0, 1 - yy * yy));
            bx = Math.cos(theta) * horiz * rr;
            by = 0.06 + yy * rr;
            bz = Math.sin(theta) * horiz * rr;
          }
          set3(bud, i, bx, by, bz);
          budBoosts[i] = filament ? 0.95 : 0;

          // ---- 颜色：边缘电光更白，内部保留深蓝紫 ----------------------
          color.copy(COLORS.abyss)
            .lerp(COLORS.indigo, smoothstep(0.0, 0.2, t))
            .lerp(COLORS.electric, smoothstep(0.16, 0.55, t))
            .lerp(COLORS.cyan, smoothstep(0.5, 0.9, t));
          if (edge) color.lerp(COLORS.white, 0.16 + 0.34 * t);
          else if (interior) color.multiplyScalar(0.66);
          if (this.rand() < 0.04) color.lerp(COLORS.spark, 0.45);
          const shade = 0.84 + this.rand() * 0.28;
          set3(colors, i, color.r * shade, color.g * shade, color.b * shade);

          budColor.copy(COLORS.indigo)
            .lerp(COLORS.electric, this.rand() * 0.6)
            .lerp(COLORS.ice, 0.45 + this.rand() * 0.4);
          if (filament) budColor.lerp(COLORS.white, 0.55);
          set3(budColors, i,
            budColor.r * shade, budColor.g * shade, budColor.b * shade);

          const isHalo = edge && this.rand() < 0.025;
          const isTip = t > 0.9;
          const rootFade = 0.4 + 0.6 * smoothstep(0.04, 0.28, t);

          scales[i] = isHalo
            ? 12 + this.rand() * 14
            : edge
              ? 4.1 + this.rand() * 4.3 + (isTip ? 2.4 : 0)
              : 2.2 + this.rand() * 2.8;
          alphas[i] = (isHalo
            ? 0.05 + this.rand() * 0.05
            : edge
              ? 0.82 + this.rand() * 0.18
              : 0.24 + this.rand() * 0.3) * rootFade;
          hots[i] = isHalo ? 0.05 : edge ? 0.55 + this.rand() * 0.45 : 0.08;
          delays[i] = clamp(0.5 * layerRatio + 0.3 * t + 0.08 * this.rand(), 0, 0.92);
          seeds[i] = this.rand();
          groups[i] = this.rand();
        }

        // 记下一枚真实花瓣尖端，供动态电弧瞄准
        this.tips.push(new THREE.Vector3(
          Math.cos(angleBase) * petalLength,
          layer.lift + 0.19,
          Math.sin(angleBase) * petalLength));
        this.petalMeta.push({
          angle: angleBase,
          length: petalLength,
          width: petalWidth,
          lift: layer.lift,
        });
      }
    }

    // ---- 花心：一颗电离核心 ------------------------------------------------
    for (let c = 0; c < coreCount; c++) {
      const i = cursor++;
      const roll = this.rand();
      let px;
      let py;
      let pz;

      if (roll < 0.62) {
        const t = (c + 0.5) / coreCount;
        const theta = c * GOLDEN_ANGLE;
        const r = 0.3 * Math.sqrt(t);
        px = Math.cos(theta) * r;
        pz = Math.sin(theta) * r;
        py = 0.08 + (this.rand() - 0.5) * 0.26;
      } else if (roll < 0.86) {
        const theta = this.rand() * TAU;
        const r = 0.4 + this.rand() * 0.16;
        px = Math.cos(theta) * r;
        pz = Math.sin(theta) * r;
        py = 0.1 + (this.rand() - 0.5) * 0.08;
      } else {
        const theta = this.rand() * TAU;
        const r = 0.18 + this.rand() * 0.36;
        px = Math.cos(theta) * r;
        pz = Math.sin(theta) * r;
        py = 0.08 + (this.rand() - 0.5) * 0.58;
      }
      set3(open, i, px, py, pz);

      const br = 0.05 + this.rand() * 0.24;
      const ba = this.rand() * TAU;
      set3(bud, i, Math.cos(ba) * br, 0.06 + (this.rand() - 0.5) * br * 1.8, Math.sin(ba) * br);

      color.copy(COLORS.ice)
        .lerp(COLORS.white, 0.55 + this.rand() * 0.4)
        .lerp(COLORS.electric, this.rand() * 0.25);
      set3(colors, i, color.r, color.g, color.b);
      budColor.copy(COLORS.electric).lerp(COLORS.white, 0.65 + this.rand() * 0.3);
      set3(budColors, i, budColor.r, budColor.g, budColor.b);

      scales[i] = 3.5 + this.rand() * 4.8;
      alphas[i] = 0.82 + this.rand() * 0.18;
      hots[i] = 1;
      delays[i] = 0.94;
      seeds[i] = this.rand();
      groups[i] = this.rand();
      budBoosts[i] = 0.45;
    }

    const geometry = new THREE.BufferGeometry();
    // 每颗粒子从花苞指向绽放位置的方向，作为爆发初速度；零长度时退回随机方向
    for (let i = 0; i < total; i++) {
      const o = i * 3;
      const dx = open[o] - bud[o];
      const dy = open[o + 1] - bud[o + 1];
      const dz = open[o + 2] - bud[o + 2];
      let len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      let vx;
      let vy;
      let vz;
      if (len < 1e-5) {
        const a = this.rand() * TAU;
        const y = this.rand() * 2 - 1;
        const s = Math.sqrt(Math.max(0, 1 - y * y));
        vx = Math.cos(a) * s;
        vy = y;
        vz = Math.sin(a) * s;
        len = 1;
      } else {
        vx = dx / len;
        vy = dy / len;
        vz = dz / len;
      }
      const boost = 0.8 + this.rand() * 0.8;
      velocities[o] = vx * boost;
      velocities[o + 1] = vy * boost;
      velocities[o + 2] = vz * boost;
    }
    geometry.setAttribute('position', new THREE.BufferAttribute(open.slice(), 3));
    geometry.setAttribute('aOpen', new THREE.BufferAttribute(open, 3));
    geometry.setAttribute('aBud', new THREE.BufferAttribute(bud, 3));
    geometry.setAttribute('aVelocity', new THREE.BufferAttribute(velocities, 3));
    geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('aBudColor', new THREE.BufferAttribute(budColors, 3));
    geometry.setAttribute('aScale', new THREE.BufferAttribute(scales, 1));
    geometry.setAttribute('aAlpha', new THREE.BufferAttribute(alphas, 1));
    geometry.setAttribute('aDelay', new THREE.BufferAttribute(delays, 1));
    geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
    geometry.setAttribute('aGroup', new THREE.BufferAttribute(groups, 1));
    geometry.setAttribute('aHot', new THREE.BufferAttribute(hots, 1));
    geometry.setAttribute('aBudBoost', new THREE.BufferAttribute(budBoosts, 1));
    geometry.computeBoundingSphere();

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uSpread: { value: 0 },
        uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uPointer: { value: new THREE.Vector2(10, 10) },
        uPointerStrength: { value: 0 },
        uSurge: { value: 0 },
        uFlashPos: { value: new THREE.Vector3(0, 0.1, 0) },
        uFlashPower: { value: 0 },
      },
      vertexShader: BOLT_VERT,
      fragmentShader: BOLT_FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.points = new THREE.Points(geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 1;
    this.group.add(this.points);

    this._buildSkeleton();
  }

  /* ------------------------------------------------------------------------ */
  /* 每片花瓣的外轮廓：两条叶缘 + 一条主脉，给粒子云一个可读的形。 */
  _addPetalSpine(layer, angleBase, lengthScale, widthScale, layerIndex, petalIndex) {
    const length = layer.length * lengthScale;
    const width = layer.width * widthScale;
    const segs = 12;

    const widthAt = (t) => width * 0.5 * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.82)), 0.78);
    const pointAt = (t, lateral) => {
      const radial = 0.18 + (length - 0.18) * t;
      const height = layer.lift + 0.12 * Math.sin(Math.PI * t) + 0.07 * t * t;
      return [
        Math.cos(angleBase) * radial - Math.sin(angleBase) * lateral,
        height,
        Math.sin(angleBase) * radial + Math.cos(angleBase) * lateral,
      ];
    };
    const colorAt = (t, edge) => {
      const c = new THREE.Color();
      c.copy(COLORS.indigo)
        .lerp(COLORS.electric, smoothstep(0.1, 0.5, t))
        .lerp(COLORS.cyan, smoothstep(0.45, 0.86, t));
      if (edge) c.lerp(COLORS.white, 0.22 + 0.34 * t);
      return c.multiplyScalar(0.72 + 0.5 * Math.sin(Math.PI * t));
    };
    const pushSeg = (p0, p1, c, alpha) => {
      this._skel.pos.push(...p0, ...p1);
      this._skel.col.push(c.r, c.g, c.b, c.r, c.g, c.b);
      this._skel.alpha.push(alpha, alpha);
      const seed = hash2(p0[0] * 131.7 + p1[2] * 57.1, p0[1] * 91.3 + p1[0] * 13.7);
      this._skel.seed.push(seed, seed);
    };

    // 左右两条叶缘，从花心一直合拢到瓣尖
    for (const side of [-1, 1]) {
      let prev = pointAt(0, 0);
      for (let j = 1; j <= segs; j++) {
        const t = j / segs;
        const jitter = (hash2(layerIndex * 19.1 + petalIndex * 7.3, j + side * 11) - 0.5) * width * 0.035;
        const p = pointAt(t, side * widthAt(t) * 0.97 + jitter);
        const alpha = 0.18 + 0.62 * Math.sin(Math.PI * t);
        pushSeg(prev, p, colorAt(t, true), alpha);
        prev = p;
      }
    }

    // 中央主脉，让每片花瓣有一根明确的中轴
    let prev = pointAt(0.02, 0);
    for (let j = 1; j <= 8; j++) {
      const t = 0.02 + (0.96 * j) / 8;
      const p = pointAt(t, (hash2(layerIndex + petalIndex * 2.1, j) - 0.5) * width * 0.06);
      pushSeg(prev, p, colorAt(t, false), 0.14 + 0.36 * Math.sin(Math.PI * t));
      prev = p;
    }

    // 两条向内分叉的侧脉
    for (const [t0, side] of [[0.46, 1], [0.62, -1]]) {
      let from = pointAt(t0, 0);
      for (let j = 1; j <= 4; j++) {
        const k = j / 4;
        const t = t0 + 0.24 * k;
        const p = pointAt(t, side * widthAt(t) * 0.72 * k);
        pushSeg(from, p, colorAt(t, true), 0.16 + 0.3 * k);
        from = p;
      }
    }
  }

  _buildSkeleton() {
    const { pos, col, alpha } = this._skel;
    if (!pos.length) return;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geometry.setAttribute('aAlpha', new THREE.Float32BufferAttribute(alpha, 1));
    geometry.setAttribute('aSeed', new THREE.Float32BufferAttribute(this._skel.seed, 1));
    geometry.computeBoundingSphere();

    this.skeletonMaterial = new THREE.ShaderMaterial({
      uniforms: { uOpacity: { value: 0 }, uTime: { value: 0 } },
      vertexShader: SKELETON_VERT,
      fragmentShader: ARC_FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.skeleton = new THREE.LineSegments(geometry, this.skeletonMaterial);
    this.skeleton.frustumCulled = false;
    this.skeleton.renderOrder = 2;
    this.group.add(this.skeleton);
  }

  /* ------------------------------------------------------------------------ */
  _buildArcs() {
    this.arcMax = 72;
    this.arcSegments = 12;
    this.arcBranchCount = 2;
    this.arcBranchSegments = 4;
    const segPerArc = this.arcSegments + this.arcBranchCount * this.arcBranchSegments;
    const vertices = this.arcMax * segPerArc * 2;

    this.arcPositions = new Float32Array(vertices * 3);
    this.arcColors = new Float32Array(vertices * 3);
    this.arcAlphas = new Float32Array(vertices);

    this.arcs = [];
    for (let i = 0; i < this.arcMax; i++) {
      const arc = {
        age: this.rand() * 0.6,
        life: 0.22 + this.rand() * 0.5,
        alpha: 0.45 + this.rand() * 0.55,
        seed: this.rand(),
        amp: 0.08,
        length: 1,
        start: new THREE.Vector3(),
        end: new THREE.Vector3(),
        dir: new THREE.Vector3(),
        perp: new THREE.Vector3(),
        perp2: new THREE.Vector3(),
        color: new THREE.Color(),
        pts: Array.from({ length: this.arcSegments + 1 }, () => new THREE.Vector3()),
        branches: Array.from({ length: this.arcBranchCount }, () => ({
          anchor: 0.4,
          length: 0.3,
          side: 1,
          seed: 0,
          pts: Array.from({ length: this.arcBranchSegments + 1 }, () => new THREE.Vector3()),
        })),
      };
      this._respawnArc(arc, true);
      this.arcs.push(arc);
    }

    this.arcGeometry = new THREE.BufferGeometry();
    this.arcGeometry.setAttribute('position',
      new THREE.BufferAttribute(this.arcPositions, 3).setUsage(THREE.DynamicDrawUsage));
    this.arcGeometry.setAttribute('color',
      new THREE.BufferAttribute(this.arcColors, 3).setUsage(THREE.DynamicDrawUsage));
    this.arcGeometry.setAttribute('aAlpha',
      new THREE.BufferAttribute(this.arcAlphas, 1).setUsage(THREE.DynamicDrawUsage));
    this.arcGeometry.setDrawRange(0, vertices);

    this.arcMaterial = new THREE.ShaderMaterial({
      uniforms: { uOpacity: { value: 1.0 } },
      vertexShader: ARC_VERT,
      fragmentShader: ARC_FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.arcLine = new THREE.LineSegments(this.arcGeometry, this.arcMaterial);
    this.arcLine.frustumCulled = false;
    this.arcLine.renderOrder = 3;
    this.group.add(this.arcLine);

    this.arcGlow = new THREE.Points(this.arcGeometry, new THREE.PointsMaterial({
      map: getGlowTexture(),
      size: 0.095,
      vertexColors: true,
      transparent: true,
      opacity: 0.75,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      sizeAttenuation: true,
    }));
    this.arcGlow.frustumCulled = false;
    this.arcGlow.renderOrder = 4;
    this.group.add(this.arcGlow);
  }

  _respawnArc(arc, initial = false) {
    const s = this._spread;
    const rand = this.rand;
    arc.hero = false;

    if (s < 0.28) {
      // 电离球：一部分是贴着球面乱窜的短弧，一部分是向外炸开的长电枝
      if (rand() < 0.5) {
        const a0 = rand() * TAU;
        const y0 = (rand() * 2 - 1) * 0.34;
        const r0 = 0.18 + rand() * 0.3;
        arc.start.set(Math.cos(a0) * r0, 0.06 + y0 * r0, Math.sin(a0) * r0);
        const a1 = rand() * TAU;
        const yy = (rand() * 2 - 1) * 0.9;
        const rr = 1.2 + rand() * 0.8;
        arc.end.set(Math.cos(a1) * rr, 0.06 + yy * rr * 0.86, Math.sin(a1) * rr);
        arc.amp = 0.08 + rand() * 0.11;
        arc.hero = true;
      } else {
        const a0 = rand() * TAU;
        const y0 = (rand() * 2 - 1) * 0.36;
        const r0 = 0.08 + rand() * 0.34;
        arc.start.set(Math.cos(a0) * r0, 0.06 + y0 * r0, Math.sin(a0) * r0);
        const a1 = rand() * TAU;
        const yy = (rand() * 2 - 1) * 0.82;
        const rr = 0.58 + rand() * 0.62;
        arc.end.set(Math.cos(a1) * rr, 0.06 + yy * rr * 0.92, Math.sin(a1) * rr);
        arc.amp = 0.045 + rand() * 0.075;
      }
    } else {
      const meta = this.petalMeta.length
        ? this.petalMeta[Math.floor(rand() * this.petalMeta.length)]
        : null;
      const roll = rand();

      if (meta && roll < 0.78) {
        // 沿着某片花瓣的叶缘爬行，让电弧勾出花瓣的边
        const side = rand() < 0.5 ? -1 : 1;
        const t0 = 0.22 + rand() * 0.42;
        const t1 = Math.min(0.99, t0 + 0.18 + rand() * 0.28);
        const edgePoint = (t, out) => {
          const half = meta.width * 0.5
            * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.82)), 0.78);
          const radial = 0.18 + (meta.length - 0.18) * t;
          const height = meta.lift + 0.12 * Math.sin(Math.PI * t) + 0.07 * t * t;
          out.set(
            Math.cos(meta.angle) * radial - Math.sin(meta.angle) * side * half,
            height,
            Math.sin(meta.angle) * radial + Math.cos(meta.angle) * side * half,
          );
          return out;
        };
        edgePoint(t0, arc.start);
        edgePoint(t1, arc.end);
        arc.start.x += (rand() - 0.5) * 0.05;
        arc.start.z += (rand() - 0.5) * 0.05;
        arc.end.x += (rand() - 0.5) * 0.06;
        arc.end.z += (rand() - 0.5) * 0.06;
        arc.amp = 0.03 + rand() * 0.055;
      } else if (roll < 0.9 && this.tips.length > 1) {
        // 两片花瓣尖端之间的短促跳电
        const tip = this.tips[Math.floor(rand() * this.tips.length)];
        const tip2 = this.tips[Math.floor(rand() * this.tips.length)] || tip;
        arc.start.copy(tip).multiplyScalar(0.92);
        arc.end.copy(tip).lerp(tip2, 0.12 + rand() * 0.18).multiplyScalar(0.96);
        arc.start.y += (rand() - 0.5) * 0.12;
        arc.end.y += (rand() - 0.5) * 0.2;
        arc.amp = 0.05 + rand() * 0.1;
      } else {
        // 少量长电击：从花心劈向瓣尖，制造偶发的强放电
        const tip = this.tips.length
          ? this.tips[Math.floor(rand() * this.tips.length)]
          : new THREE.Vector3(0, 1, 0);
        arc.start.set(
          (rand() - 0.5) * 0.3,
          0.08 + (rand() - 0.5) * 0.3,
          (rand() - 0.5) * 0.3,
        );
        arc.end.copy(tip).multiplyScalar(0.9 + rand() * 0.1);
        arc.end.y += (rand() - 0.5) * 0.16;
        arc.amp = 0.11 + rand() * 0.08;
      }
    }

    arc.life = (arc.hero ? 0.12 : 0.16) + rand() * 0.36;
    arc.age = initial ? rand() * arc.life : 0;
    arc.alpha = (arc.hero ? 0.92 : 0.68) + rand() * (arc.hero ? 0.08 : 0.32);
    arc.color.copy(rand() < (this._spread < 0.28 ? 0.7 : 0.32) ? ARC_WHITE : ARC_CYAN)
      .lerp(ARC_VIOLET, rand() * 0.22);

    arc.dir.copy(arc.end).sub(arc.start);
    const len = arc.dir.length() || 1;
    arc.length = len;
    arc.dir.multiplyScalar(1 / len);
    arc.perp.crossVectors(arc.dir, UP);
    if (arc.perp.lengthSq() < 1e-5) arc.perp.set(1, 0, 0);
    arc.perp.normalize();
    arc.perp2.crossVectors(arc.dir, arc.perp).normalize();

    for (const branch of arc.branches) {
      branch.anchor = 0.18 + rand() * 0.6;
      branch.length = 0.24 + rand() * 0.42;
      branch.side = rand() < 0.5 ? -1 : 1;
      branch.seed = rand();
    }
  }

  _updateArcs(time, dt) {
    const n = this.arcSegments;
    const pos = this.arcPositions;
    const cols = this.arcColors;
    const alps = this.arcAlphas;
    let vi = 0;

    for (let a = 0; a < this.arcs.length; a++) {
      const arc = this.arcs[a];
      arc.age += dt;
      if (arc.age > arc.life) this._respawnArc(arc);

      const flick = 0.62 + 0.38 * Math.sin(time * (20 + arc.seed * 26) + arc.seed * 40);
      const alpha = arc.alpha * flick * (this._spread < 0.28 ? 1.28 : 1)
        * (arc.hero ? 1.18 : 1);
      const dx = arc.end.x - arc.start.x;
      const dy = arc.end.y - arc.start.y;
      const dz = arc.end.z - arc.start.z;

      for (let j = 0; j <= n; j++) {
        const t = j / n;
        const env = Math.pow(Math.sin(Math.PI * t), 0.62);
        const n1 = (hash2(arc.seed * 77.7, j + 3) - 0.5) * 2;
        const n2 = Math.sin(t * 21 + arc.seed * 40 + time * 26) * 0.42;
        const off = (n1 + n2) * arc.amp * env;
        const off2 = (hash2(arc.seed * 31.1, j + 17) - 0.5) * arc.amp * env * 0.8;
        arc.pts[j].set(
          arc.start.x + dx * t + arc.perp.x * off + arc.perp2.x * off2,
          arc.start.y + dy * t + arc.perp.y * off + arc.perp2.y * off2,
          arc.start.z + dz * t + arc.perp.z * off + arc.perp2.z * off2);
      }

      for (let j = 0; j < n; j++) {
        const p0 = arc.pts[j];
        const p1 = arc.pts[j + 1];
        const e0 = 0.18 + 0.82 * Math.pow(Math.sin(Math.PI * (j / n)), 0.62);
        const e1 = 0.18 + 0.82 * Math.pow(Math.sin(Math.PI * ((j + 1) / n)), 0.62);

        pos[vi * 3] = p0.x;
        pos[vi * 3 + 1] = p0.y;
        pos[vi * 3 + 2] = p0.z;
        cols[vi * 3] = arc.color.r;
        cols[vi * 3 + 1] = arc.color.g;
        cols[vi * 3 + 2] = arc.color.b;
        alps[vi] = alpha * e0;
        vi++;

        pos[vi * 3] = p1.x;
        pos[vi * 3 + 1] = p1.y;
        pos[vi * 3 + 2] = p1.z;
        cols[vi * 3] = arc.color.r;
        cols[vi * 3 + 1] = arc.color.g;
        cols[vi * 3 + 2] = arc.color.b;
        alps[vi] = alpha * e1;
        vi++;
      }

      // ---- 分叉：从主电弧上随机一点斜向劈出，形成树状闪电 ----------------
      for (const branch of arc.branches) {
        const bs = this.arcBranchSegments;
        const anchor = Math.max(1, Math.min(n - 1, Math.round(branch.anchor * n)));
        const origin = arc.pts[anchor];
        const bx = arc.dir.x * 0.55
          + arc.perp.x * branch.side * 0.95
          + arc.perp2.x * (branch.seed - 0.5) * 0.35;
        const by = arc.dir.y * 0.55
          + arc.perp.y * branch.side * 0.95
          + arc.perp2.y * (branch.seed - 0.5) * 0.35;
        const bz = arc.dir.z * 0.55
          + arc.perp.z * branch.side * 0.95
          + arc.perp2.z * (branch.seed - 0.5) * 0.35;
        const bl = Math.hypot(bx, by, bz) || 1;
        const branchLen = arc.length * branch.length;

        branch.pts[0].copy(origin);
        for (let j = 1; j <= bs; j++) {
          const t = j / bs;
          const env = Math.sin(Math.PI * t);
          const j1 = (hash2(branch.seed * 91.3, j + 11) - 0.5) * 2 * arc.amp * 1.3 * env;
          const j2 = (hash2(branch.seed * 57.7, j + 29) - 0.5) * 2 * arc.amp * 0.9 * env;
          branch.pts[j].set(
            origin.x + (bx / bl) * branchLen * t + arc.perp.x * j1 + arc.perp2.x * j2,
            origin.y + (by / bl) * branchLen * t + arc.perp.y * j1 + arc.perp2.y * j2,
            origin.z + (bz / bl) * branchLen * t + arc.perp.z * j1 + arc.perp2.z * j2,
          );
        }

        for (let j = 0; j < bs; j++) {
          const q0 = branch.pts[j];
          const q1 = branch.pts[j + 1];
          const fade0 = 1 - (j / bs) * 0.62;
          const fade1 = 1 - ((j + 1) / bs) * 0.62;
          const br = arc.color.r * 0.72 + 0.26;
          const bg = arc.color.g * 0.72 + 0.26;
          const bb = arc.color.b * 0.72 + 0.26;

          pos[vi * 3] = q0.x;
          pos[vi * 3 + 1] = q0.y;
          pos[vi * 3 + 2] = q0.z;
          cols[vi * 3] = br;
          cols[vi * 3 + 1] = bg;
          cols[vi * 3 + 2] = bb;
          alps[vi] = alpha * 0.72 * fade0;
          vi++;

          pos[vi * 3] = q1.x;
          pos[vi * 3 + 1] = q1.y;
          pos[vi * 3 + 2] = q1.z;
          cols[vi * 3] = br;
          cols[vi * 3 + 1] = bg;
          cols[vi * 3 + 2] = bb;
          alps[vi] = alpha * 0.72 * fade1;
          vi++;
        }
      }
    }

    this.arcGeometry.attributes.position.needsUpdate = true;
    this.arcGeometry.attributes.color.needsUpdate = true;
    this.arcGeometry.attributes.aAlpha.needsUpdate = true;

    const s = this._spread;
    this.arcMaterial.uniforms.uOpacity.value =
      (0.72 + 0.42 * s) * (0.85 + 0.6 * this._surge);
    this.arcGlow.material.opacity = 0.55 - 0.17 * s + 0.2 * this._surge;
    this.arcGlow.material.size = 0.09 - 0.025 * s;
  }

  /* ------------------------------------------------------------------------ */
  _buildSparks() {
    const n = CONFIG.pollen;
    const positions = new Float32Array(n * 3);
    const colors = new Float32Array(n * 3);
    const seeds = new Float32Array(n);
    const scales = new Float32Array(n);
    const alphas = new Float32Array(n);
    const color = new THREE.Color();

    for (let i = 0; i < n; i++) {
      const angle = this.rand() * TAU;
      const radius = 1.2 + Math.pow(this.rand(), 0.55) * 2.0;
      const y = (this.rand() * 2 - 1) * (0.4 + this.rand() * 1.25);
      set3(positions, i, Math.cos(angle) * radius, y, Math.sin(angle) * radius);

      const roll = this.rand();
      if (roll < 0.46) color.copy(COLORS.electric);
      else if (roll < 0.7) color.copy(COLORS.cyan);
      else if (roll < 0.9) color.copy(COLORS.violet);
      else color.copy(COLORS.white);
      const shade = 0.72 + this.rand() * 0.5;
      set3(colors, i, color.r * shade, color.g * shade, color.b * shade);

      seeds[i] = this.rand();
      scales[i] = 1.4 + Math.pow(this.rand(), 2) * 3.2 + (this.rand() < 0.08 ? 4 : 0);
      alphas[i] = 0.25 + this.rand() * 0.55;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
    geometry.setAttribute('aScale', new THREE.BufferAttribute(scales, 1));
    geometry.setAttribute('aAlpha', new THREE.BufferAttribute(alphas, 1));

    this.sparkMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uSpread: { value: 0 },
        uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
        uSurge: { value: 0 },
      },
      vertexShader: SPARK_VERT,
      fragmentShader: BOLT_FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.sparks = new THREE.Points(geometry, this.sparkMaterial);
    this.sparks.frustumCulled = false;
    this.sparks.renderOrder = 2;
    this.group.add(this.sparks);
  }

  /* ------------------------------------------------------------------------ */
  _buildCorona() {
    const n = 840;
    const positions = new Float32Array(n * 3);
    const colors = new Float32Array(n * 3);
    const seeds = new Float32Array(n);
    const scales = new Float32Array(n);
    const color = new THREE.Color();

    for (let i = 0; i < n; i++) {
      const a = this.rand() * TAU;
      const radius = 0.42 + Math.pow(this.rand(), 0.65) * 0.62;
      const y = (this.rand() * 2 - 1) * 0.55;
      set3(positions, i, Math.cos(a) * radius, y, Math.sin(a) * radius);

      const roll = this.rand();
      if (roll < 0.5) color.copy(COLORS.ice);
      else if (roll < 0.76) color.copy(COLORS.cyan);
      else if (roll < 0.9) color.copy(COLORS.electric);
      else color.copy(COLORS.white);
      const shade = 0.62 + this.rand() * 0.55;
      set3(colors, i, color.r * shade, color.g * shade, color.b * shade);

      seeds[i] = this.rand();
      scales[i] = 1.8 + Math.pow(this.rand(), 2) * 3.8;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
    geometry.setAttribute('aScale', new THREE.BufferAttribute(scales, 1));

    this.coronaMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uSpread: { value: 0 },
        uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
        uSurge: { value: 0 },
      },
      vertexShader: CORONA_VERT,
      fragmentShader: BOLT_FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.corona = new THREE.Points(geometry, this.coronaMaterial);
    this.corona.frustumCulled = false;
    this.corona.renderOrder = 2;
    this.group.add(this.corona);
  }

  /** 外部强闪（指尖层触发）叠加到雷花爆闪 */
  addSurge(amount = 1) {
    this._surge = Math.min(1.8, (this._surge || 0) + amount);
    this._shock = Math.min(1, (this._shock || 0) + amount * 0.75);
  }

  /** 由 main.js 的 FlashController 每帧写入虚拟照亮强度 */
  setFlashPower(v) {
    this.flashPower = clamp(Number(v) || 0, 0, 1);
  }

  /* ------------------------------------------------------------------------ */
  update(dt, time, spread, tension) {
    const s = clamp(spread, 0, 1);

    // 张力变化越快，电离爆闪越强
    const delta = Math.abs(s - this._lastSpread);
    this._surge = Math.min(1.5, this._surge + delta * 4.2);
    this._surge *= Math.exp(-dt * 3.1);
    this._shock = Math.min(1, this._shock + delta * 9.0);
    this._shock *= Math.exp(-dt * 3.4);
    this._lastSpread = s;
    this._spread = s;

    this.uniforms.uTime.value = time;
    this.uniforms.uSpread.value = s;
    this.uniforms.uSurge.value = this._surge;
    this.uniforms.uFlashPos.value.set(0, 0.1, 0);
    this.uniforms.uFlashPower.value = this.flashPower || 0;
    this.sparkMaterial.uniforms.uTime.value = time;
    this.sparkMaterial.uniforms.uSpread.value = s;
    this.sparkMaterial.uniforms.uSurge.value = this._surge;
    this.coronaMaterial.uniforms.uTime.value = time;
    this.coronaMaterial.uniforms.uSpread.value = s;
    this.coronaMaterial.uniforms.uSurge.value = this._surge;

    this._updateArcs(time, dt);

    if (this.skeletonMaterial) {
      const reveal = smoothstep(0.3, 0.66, s);
      this.skeletonMaterial.uniforms.uTime.value = time;
      this.skeletonMaterial.uniforms.uOpacity.value =
        reveal * (0.62 + 0.28 * s + 0.3 * this._surge);
    }

    const pulse = 1 + 0.04 * Math.sin(time * 2.2) + 0.12 * this._surge;
    const flicker = 0.9 + 0.1 * Math.sin(time * 31.0);
    const bud = 1 - smoothstep(0.08, 0.55, s);
    this.aura.scale.setScalar((1.5 + 4.6 * s + 0.4 * bud) * pulse);
    this.aura.material.opacity = (0.08 + 0.08 * s + 0.08 * this._surge + 0.06 * bud) * flicker;
    this.auraCore.scale.setScalar((0.8 + 2.4 * s + 0.2 * bud) * pulse);
    this.auraCore.material.opacity =
      (0.1 + 0.24 * s + 0.12 * this._surge + 0.28 * bud) * flicker;

    const shock = this._shock;
    this.shockA.material.opacity = shock * 0.34;
    this.shockA.scale.setScalar(1.5 + (1 - shock) * 3.6);
    this.shockB.material.opacity = shock * 0.2;
    this.shockB.scale.setScalar(0.9 + (1 - shock) * 2.4);
    this.shockB.material.rotation += dt * 0.8;

    this.group.scale.setScalar(1 + 0.012 * Math.sin(time * 2.4) + 0.025 * s + 0.025 * this._surge);
  }

  setViewport(pixelRatio, width, height) {
    this.material.uniforms.uPixelRatio.value = pixelRatio;
    this.material.uniforms.uResolution.value.set(width, height);
    this.sparkMaterial.uniforms.uPixelRatio.value = pixelRatio;
    this.coronaMaterial.uniforms.uPixelRatio.value = pixelRatio;
  }

  setPointer(x, y, strength) {
    this.material.uniforms.uPointer.value.set(x, y);
    this.material.uniforms.uPointerStrength.value = strength;
  }

  dispose() {
    this.group.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        // 光晕贴图是全局共享的，不能在这里销毁
        obj.material.dispose();
      }
    });
    this.scene.remove(this.group);
  }
}

/* ========================================================================== *
 *  星尘背景
 * ========================================================================== */

export function createStarfield(count = CONFIG.stars) {
  const group = new THREE.Group();
  const tex = getGlowTexture();
  const rand = mulberry32(0x51ed270b);
  const color = new THREE.Color();

  const build = (n, size, opacity, spread) => {
    const positions = new Float32Array(n * 3);
    const colors = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const angle = rand() * TAU;
      const radius = 11 + rand() * 17;
      const z = -4 - rand() * 26;
      set3(positions, i,
        Math.cos(angle) * radius * (0.4 + spread * 0.6),
        (rand() * 2 - 1) * 13,
        z);
      const roll = rand();
      if (roll < 0.55) color.set('#9fd8ff');
      else if (roll < 0.82) color.set('#c7b8ff');
      else color.set('#f4ffff');
      const shade = 0.3 + rand() * 0.7;
      set3(colors, i, color.r * shade, color.g * shade, color.b * shade);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const mat = new THREE.PointsMaterial({
      size,
      map: tex,
      vertexColors: true,
      transparent: true,
      opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      sizeAttenuation: true,
    });
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    points.renderOrder = -4;
    return points;
  };

  group.add(build(count, 0.075, 0.68, 0.6));
  group.add(build(Math.round(count * 0.12), 0.16, 0.82, 1.0));
  return group;
}

/* ========================================================================== *
 *  小工具
 * ========================================================================== */

function makeStrands(rand) {
  const strands = [];
  for (let i = 0; i < 5; i++) {
    strands.push({
      base: (i - 2) * 0.46 + (rand() - 0.5) * 0.1,
      u0: 0.04 + rand() * 0.06,
      u1: 1.0 + rand() * 0.05,
      group: rand(),
      branch: 0,
    });
  }
  for (let i = 0; i < 3; i++) {
    const side = i % 2 ? 1 : -1;
    strands.push({
      base: side * (0.35 + rand() * 0.34),
      u0: 0.36 + rand() * 0.3,
      u1: 1.03 + rand() * 0.2,
      group: rand(),
      branch: side * (0.65 + rand() * 0.95),
    });
  }
  return strands;
}

function lyri(i, n) {
  return n <= 1 ? 0 : i / (n - 1);
}

function set3(arr, i, x, y, z) {
  arr[i * 3] = x;
  arr[i * 3 + 1] = y;
  arr[i * 3 + 2] = z;
}

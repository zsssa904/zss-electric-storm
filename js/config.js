/**
 * 指尖雷花 · 全局配置
 * ---------------------------------------------------------------------------
 * 所有核心参数集中在这里，可以直接改，也可以运行时通过 URL 查询参数覆盖：
 *   ?particles=18000   粒子数量（5000 ~ 20000）
 *   ?spread=0.8        跳过手势，固定绽放程度（调试 / 截图用）
 *   ?demo=1            直接进入演示模式（不显示开场卡片）
 *   ?cam=1             载入后自动申请摄像头
 *   ?debug=1           显示调试面板
 *
 * 控制台里也可以通过 window.BLOOM 实时调整，例如：
 *   BLOOM.setParticleCount(20000)
 *   BLOOM.setSpread(0.5)
 */
export const CONFIG = {
  // ---- 粒子 ---------------------------------------------------------------
  particles: 18000,
  minParticles: 5000,
  maxParticles: 20000,
  pollen: 760,                 // 花瓣之外飘浮的电离火花（额外开销很小）
  stars: 900,

  // ---- 手势 -> 绽放 -------------------------------------------------------
  thresholds: {
    closed: 0.32,              // tension < 0.32  : 花苞
    open: 0.66,                // tension > 0.66  : 绽放
  },

  // 逐帧平滑系数（按 60fps 标定，内部会做 deltaTime 归一化）
  smoothing: {
    tension: 0.18,             // 手势张力平滑
    spreadOut: 0.62,           // 张开爆发：近乎瞬时（约 0.1s）
    spreadIn: 0.12,            // 收回握拳：慢速凝聚
    follow: 0.075,             // 花朵跟随手部位置
  },

  // ---- 指尖雷电 / 电弧视觉 ------------------------------------------------
  lightning: {
    beatMin: 8,                // 放电节拍 8~15Hz
    beatMax: 15,
    beatBlend: 0.075,          // 两次节拍之间的形状插值时长（秒）
    maxBolts: 72,              // 电弧池容量（预分配，不在帧内 new）
    mainIterations: 5,         // 中点位移递归层数（2^5 段）
    branchDepth: 2,            // 主弧 -> 分支 -> 子分支
    roughness: 0.26,           // 抖动幅度 / 弧长
    kinkChance: 0.22,          // 折返点的概率
    trailSeconds: 0.16,        // Canvas 余辉时间常数
    flashMin: 0.4,             // 强闪间隔（秒）
    flashMax: 1.5,
    flashDecay: 8.5,           // 指尖层的强闪衰减速度
    flashOnsets: [0, 0.06, 0.13], // 一次三连击的三个脉冲时刻
    flashAmps: [1.0, 0.62, 0.38],
    flashSigma: 0.028,         // 每个高斯脉冲的宽度（秒）
    flashTint: 0.12,           // DOM 全屏泛白最大透明度
    shakeAmp: 0.004,           // 强闪相机震动幅度（世界单位）
    bloom: true,               // 低分辨率降采样 bloom
    bloomScale: 0.5,
    shake: 0.018,              // 相机震动世界单位
    colors: {
      inner: '#f2ffff',
      mid: '#7fe6ff',
      outer: '#3a6bff',
    },
  },

  // ---- 音效：用户采样 + 手势映射 ------------------------------------------
  audio: {
    sampleUrl: './assets/audio/electric-arc.mp3',
    masterVolume: 0.7,
    crackGain: 0.55,
    strokeDuration: 0.42,       // 主放电采样时长（秒）
    strokeRateClosed: 0.78,     // 握拳：降速、变闷
    strokeRateOpen: 1.12,       // 张开：升速、变亮
    strokeCutClosed: 900,       // 握拳低通截止（Hz）
    strokeCutOpen: 4200,        // 张开低通截止（Hz）
    humGainClosed: 0.10,
    humGainOpen: 0.05,
    humCutClosed: 180,
    humCutOpen: 900,
    humRateClosed: 0.52,
    humRateOpen: 0.68,
  },

  // ---- 摄像头 / MediaPipe -------------------------------------------------
  camera: {
    targetWidth: 1280,
    targetHeight: 720,
    detectFps: 26,             // 每秒钟送入模型的帧数（渲染仍是 60fps）
    maxHands: 1,
    complexity: 1,             // 0 = lite, 1 = full（21 点精度更好）
    minDetection: 0.6,
    minTracking: 0.6,
  },

  model: {
    local: './vendor/hands/',
    cdn: 'https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/',
  },

  // ---- 渲染 ---------------------------------------------------------------
  render: {
    fov: 42,
    maxDpr: 2,
    fitRadius: 1.92,           // 需要完整显示的半径（世界单位）
    fitMargin: 1.16,
  },

  // ---- 花体比例（可整体缩放，不动几何代码）--------------------------------
  flower: {
    coreRatio: 0.075,
    haloRatio: 0.035,
    layers: [
      // petals 花瓣数 | length 长度 | width 宽度 | tilt 基部仰角(°) |
      // curl 尖端上卷(°) | cup 边缘内扣 | lift 花心抬升
      { petals: 7, length: 2.05, width: 0.88, tilt: 72, curl: -25, cup: 0.55, lift: 0.00 },
      { petals: 7, length: 1.52, width: 0.74, tilt: 55, curl: -19, cup: 0.64, lift: 0.06 },
      { petals: 6, length: 1.10, width: 0.60, tilt: 38, curl: -13, cup: 0.75, lift: 0.14 },
    ],
  },
};

/** 数值夹紧 */
export const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

/** GLSL smoothstep 同款 */
export function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * 与帧率无关的指数阻尼。
 * lambda 以“每 1/60 秒执行一次”为基准：dt = 1/60 时正好等于 lambda。
 * 这样在 60 / 120 / 30fps 下手感一致。
 */
export function damp(current, target, lambda, dt) {
  const k = 1 - Math.pow(1 - lambda, dt * 60);
  return current + (target - current) * k;
}

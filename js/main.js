/**
 * 指尖雷花 · 主程序
 * ---------------------------------------------------------------------------
 * 摄像头 → MediaPipe 21 关键点 → tension(0~1) → 雷电绽放程度 spread(0~1)
 * 放电粒子交给一个 THREE.Points + ShaderMaterial；电弧层每帧单独重组。
 */
import * as THREE from '../vendor/three.module.js';
import { CONFIG, clamp, smoothstep, damp } from './config.js';
import { Flower, createStarfield } from './flower.js';
import { GestureController } from './gesture.js';
import { HandOverlay, getVideoCover } from './overlay.js';
import { FingerLightning } from './fingerlightning.js';
import { FlashController } from './flash.js';
import { LightningAudio } from './audio.js';

const $ = (sel) => document.querySelector(sel);
const params = new URLSearchParams(window.location.search);
const SYNTH_HAND = params.has('hand');
const SYNTH_TENSION = params.has('tension')
  ? clamp(Number(params.get('tension')) || 0, 0, 1)
  : null;
const isDebug = params.get('debug') === '1';

const dom = {
  canvas: $('#scene'),
  video: $('#camera'),
  handCanvas: $('#handCanvas'),
  fxCanvas: $('#fxCanvas'),
  flashOverlay: $('#flashOverlay'),
  status: $('#status'),
  statusText: $('#statusText'),
  btnCamera: $('#btnCamera'),
  btnBackdrop: $('#btnBackdrop'),
  btnSkeleton: $('#btnSkeleton'),
  btnInfo: $('#btnInfo'),
  btnAudio: $('#btnAudio'),
  intro: $('#intro'),
  btnStart: $('#btnStart'),
  btnDemo: $('#btnDemo'),
  introError: $('#introError'),
  statParticles: $('#statParticles'),
  meter: $('#meter'),
  meterFill: $('#meterFill'),
  meterState: $('#meterState'),
  tensionValue: $('#tensionValue'),
  infoPanel: $('#infoPanel'),
  btnCloseInfo: $('#btnCloseInfo'),
  toast: $('#toast'),
  debug: $('#debug'),
  fatal: $('#fatal'),
  fatalText: $('#fatalText'),
};

/* ========================================================================== *
 *  状态
 * ========================================================================== */

function readParticleCount() {
  const raw = Number(params.get('particles'));
  if (!Number.isFinite(raw) || raw <= 0) return CONFIG.particles;
  return clamp(Math.round(raw), CONFIG.minParticles, CONFIG.maxParticles);
}

function readForcedSpread() {
  if (!params.has('spread')) return null;
  const raw = Number(params.get('spread'));
  return clamp(Number.isFinite(raw) ? raw : 0, 0, 1);
}

const state = {
  mode: 'demo',              // demo | camera
  cameraOn: false,
  cameraPending: false,
  introOpen: document.body.classList.contains('intro-open'),
  hand: { present: false },
  tension: 0,
  spread: 0,
  forcedSpread: readForcedSpread(),
  pointer: new THREE.Vector2(10, 10),
  pointerStrength: 0,
  pointerActive: false,
  pointerPos: new THREE.Vector2(0.5, 0.5),
  yaw: 0,
  tiltX: 0,
  tiltZ: 0,
  time: 0,
  fps: 0,
  frames: 0,
  qualityCap: Infinity,
  reducedQuality: false,
  backdrop: true,
  skeleton: true,
};

/* ========================================================================== *
 *  Three.js 基础
 * ========================================================================== */

let renderer;
try {
  renderer = new THREE.WebGLRenderer({
    canvas: dom.canvas,
    antialias: true,
    alpha: true,
    premultipliedAlpha: false,
    powerPreference: 'high-performance',
  });
} catch (err) {
  console.error('[webgl]', err);
  dom.fatal.hidden = false;
  dom.fatalText.textContent = '当前浏览器或显卡环境不支持 WebGL。请更新 Chrome / Edge，或在系统设置中开启硬件加速后重试。';
  throw err;
}

renderer.setClearColor(0x000000, 0);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
const BASE_EXPOSURE = 0.98;
renderer.toneMappingExposure = BASE_EXPOSURE;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(CONFIG.render.fov, 1, 0.1, 140);
camera.position.set(0, 0, 6);
const projectedFlower = new THREE.Vector3();

const clock = new THREE.Clock();
const overlay = new HandOverlay(dom.handCanvas);
const fingerFx = new FingerLightning(dom.fxCanvas);
const flash = new FlashController({
  minGap: CONFIG.lightning.flashMin,
  maxGap: CONFIG.lightning.flashMax,
  offsets: CONFIG.lightning.flashOnsets,
  amplitudes: CONFIG.lightning.flashAmps,
  sigma: CONFIG.lightning.flashSigma,
});
const audio = new LightningAudio();
flash.onStroke = (power) => audio.playStroke({ power, spread: state.spread, tension: state.tension });
const gesture = new GestureController(dom.video);
const starfield = createStarfield(CONFIG.stars);
scene.add(starfield);

let flower = null;
let viewWidth = 10;
let viewHeight = 6;
let spin = 0;
let toastTimer = 0;
let lastStatusText = '';
let lastStatusTone = '';
let uiTimer = 0;
let fpsFrames = 0;
let fpsTimer = 0;
let frameCount = 0;

/* ========================================================================== *
 *  小工具
 * ========================================================================== */

function showToast(message, tone = 'info', duration = 4800) {
  if (!message) return;
  dom.toast.textContent = message;
  dom.toast.dataset.tone = tone;
  dom.toast.classList.add('is-on');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => dom.toast.classList.remove('is-on'), duration);
}

function setStatus(tone, text) {
  if (text === lastStatusText && tone === lastStatusTone) return;
  lastStatusText = text;
  lastStatusTone = tone;
  dom.status.dataset.tone = tone;
  dom.statusText.textContent = text;
}

function showIntroError(message) {
  dom.introError.textContent = message;
  dom.introError.hidden = false;
}

function describeCameraError(err) {
  if (err?.code === 'INSECURE_CONTEXT') {
    return '当前页面不是安全上下文。请通过 localhost 或 HTTPS 打开，不要直接双击 HTML 文件。';
  }
  if (err?.code === 'NO_MEDIA') {
    return '当前浏览器不支持摄像头采集，建议使用最新版 Chrome 或 Edge。';
  }
  if (err?.code === 'HANDS_LIB') {
    return '手势识别库加载失败，请检查 vendor/hands/ 资源是否完整，或确认网络可访问 CDN。';
  }
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return '摄像头权限被拒绝。请点击地址栏左侧的权限图标，允许摄像头后重试。';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return '没有找到可用的摄像头，请检查设备连接后重试。';
    case 'NotReadableError':
    case 'TrackStartError':
      return '摄像头被其他应用占用，请关闭占用摄像头的程序（如会议软件）后重试。';
    case 'OverconstrainedError':
      return '摄像头不支持请求的分辨率，请更换设备后重试。';
    case 'AbortError':
      return '摄像头启动被中断，请重试。';
    default:
      return err?.message
        ? `摄像头启动失败：${err.message}`
        : '摄像头启动失败，请重试，或先使用演示模式。';
  }
}

/* ========================================================================== *
 *  场景尺寸 / 相机
 * ========================================================================== */

function fitCamera() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  const aspect = width / Math.max(1, height);
  const tan = Math.tan(THREE.MathUtils.degToRad(CONFIG.render.fov) / 2);
  const radius = CONFIG.render.fitRadius * CONFIG.render.fitMargin;

  camera.aspect = aspect;
  camera.position.set(0, 0, Math.max(radius / (tan * aspect), radius / tan));
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();

  viewHeight = 2 * tan * camera.position.z;
  viewWidth = viewHeight * aspect;
}

function resize() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, CONFIG.render.maxDpr, state.qualityCap);

  renderer.setPixelRatio(dpr);
  renderer.setSize(width, height, false);
  fitCamera();
  overlay.resize(width, height, dpr);
  const fxDpr = Math.min(dpr, 1.5) * 0.62;
  fingerFx.resize(width, height, fxDpr);
  if (flower) flower.setViewport(dpr, width, height);
}

/* ========================================================================== *
 *  雷花
 * ========================================================================== */

function buildFlower(count) {
  const previous = flower
    ? { position: flower.group.position.clone(), rotation: flower.group.rotation.clone() }
    : null;

  if (flower) flower.dispose();
  flower = new Flower(scene, count);
  flower.setViewport(renderer.getPixelRatio(), window.innerWidth, window.innerHeight);
  flower.setPointer(state.pointer.x, state.pointer.y, state.pointerStrength);
  flower.update(0, state.time, state.spread, state.tension);

  if (previous) {
    flower.group.position.copy(previous.position);
    flower.group.rotation.copy(previous.rotation);
  }

  dom.statParticles.textContent = flower.count.toLocaleString('en-US');
}

function setParticleCount(value) {
  const count = clamp(Math.round(Number(value) || CONFIG.particles), CONFIG.minParticles, CONFIG.maxParticles);
  if (flower && flower.count === count) return count;
  buildFlower(count);
  showToast(`粒子数量已调整为 ${count.toLocaleString('en-US')}`, 'info');
  return count;
}

/* ========================================================================== *
 *  摄像头
 * ========================================================================== */

function setCameraBusy(busy) {
  dom.btnCamera.classList.toggle('is-loading', busy);
  dom.btnCamera.disabled = busy;
  dom.btnStart.disabled = busy;
  dom.btnStart.classList.toggle('is-loading', busy);
}

function setCameraUI(on) {
  dom.btnCamera.classList.toggle('is-on', on);
  dom.btnCamera.setAttribute('aria-pressed', String(on));
  // 只有摄像头开启时，画面与骨架的开关才有意义
  dom.btnBackdrop.disabled = !on;
  dom.btnSkeleton.disabled = !on;
  dom.btnBackdrop.setAttribute('aria-pressed', String(on && state.backdrop));
  dom.btnSkeleton.setAttribute('aria-pressed', String(on && state.skeleton));
}

async function enableCamera({ fromIntro = false } = {}) {
  if (state.cameraOn || state.cameraPending) return;

  state.cameraPending = true;
  setCameraBusy(true);
  dom.introError.hidden = true;

  const slowTimer = window.setTimeout(() => {
    if (state.cameraPending) {
      showToast('识别模型约 24MB，首次加载需要一点时间，请保持页面打开…', 'warn', 6000);
    }
  }, 12000);

  try {
    await gesture.start();

    state.cameraOn = true;
    state.mode = 'camera';
    document.body.dataset.mode = 'camera';
    setCameraUI(true);
    setStatus('live', '等待手部');
    closeIntro();
    showToast('摄像头已就绪 · 握拳聚雷，张开手掌让雷电绽放', 'ok', 5600);
  } catch (err) {
    console.error('[camera]', err);
    state.cameraOn = false;
    state.mode = 'demo';
    document.body.dataset.mode = 'demo';
    setCameraUI(false);
    setStatus('demo', '演示模式');

    const message = describeCameraError(err);
    if (state.introOpen || fromIntro) showIntroError(message);
    showToast(message, 'error', 7200);
  } finally {
    window.clearTimeout(slowTimer);
    state.cameraPending = false;
    setCameraBusy(false);
  }
}

async function disableCamera() {
  if (!state.cameraOn) return;

  await gesture.stop();
  state.cameraOn = false;
  state.mode = 'demo';
  document.body.dataset.mode = 'demo';
  state.hand = { present: false };
  state.pointerStrength = 0;
  overlay.clear();
  fingerFx.clear();
  setCameraUI(false);
  setStatus('demo', '演示模式');
  showToast('已断开摄像头 · 回到自动演示', 'info');
}

function toggleCamera() {
  if (state.cameraPending) return;
  if (state.cameraOn) disableCamera();
  else enableCamera();
}

/* ========================================================================== *
 *  开场 / 说明面板
 * ========================================================================== */

function closeIntro() {
  if (!state.introOpen) return;
  state.introOpen = false;
  document.body.classList.remove('intro-open');
  dom.intro.classList.add('is-hidden');
  dom.intro.setAttribute('aria-hidden', 'true');
  window.setTimeout(() => { dom.intro.hidden = true; }, 760);
}

function setInfo(open) {
  dom.infoPanel.classList.toggle('is-open', open);
  dom.infoPanel.setAttribute('aria-hidden', String(!open));
  dom.btnInfo.setAttribute('aria-pressed', String(open));
  dom.btnInfo.classList.toggle('is-on', open);
}

/* ========================================================================== *
 *  每帧更新
 * ========================================================================== */

function demoTension(t) {
  // 呼吸式开合：从半开开始，先绽放再慢慢收拢，周期约 18 秒
  const wave = 0.52 - 0.45 * Math.cos(t * 0.35 - 2.0);
  return clamp(wave + 0.015 * Math.sin(t * 1.6), 0, 1);
}

/** 仅用于 ?hand=1 的无摄像头预览：生成一只缓慢开合的手，方便检查指尖电弧 */
function syntheticHand(t) {
  const sway = Math.sin(t * 0.9) * 0.018;
  const lift = Math.sin(t * 1.3) * 0.012;
  const landmarks = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.6, z: 0 }));
  landmarks[0] = { x: 0.5 + sway, y: 0.83 + lift, z: 0 };

  const fingers = [
    [[0.34, 0.68], [0.28, 0.6], [0.24, 0.53], [0.21, 0.47]],
    [[0.43, 0.6], [0.425, 0.47], [0.42, 0.35], [0.415, 0.25]],
    [[0.5, 0.585], [0.5, 0.44], [0.5, 0.3], [0.5, 0.19]],
    [[0.57, 0.6], [0.575, 0.46], [0.58, 0.34], [0.585, 0.24]],
    [[0.645, 0.64], [0.665, 0.53], [0.68, 0.43], [0.69, 0.35]],
  ];

  const tips = [4, 8, 12, 16, 20];
  fingers.forEach((finger, f) => {
    finger.forEach(([x, y], j) => {
      const index = f === 0 ? j + 1 : 5 + (f - 1) * 4 + j;
      landmarks[index] = {
        x: x + sway + Math.sin(t * 1.7 + f + j) * 0.004,
        y: y + lift + Math.cos(t * 1.4 + f * 0.7 + j) * 0.005,
        z: 0,
      };
    });
  });

  const palm = [0, 5, 9, 13, 17].reduce((acc, i) => ({
    x: acc.x + landmarks[i].x / 5,
    y: acc.y + landmarks[i].y / 5,
  }), { x: 0, y: 0 });

  return {
    present: true,
    tension: SYNTH_TENSION ?? 0.82 + 0.1 * Math.sin(t * 0.6),
    rawTension: 0.82,
    palm,
    palmCenter: palm,
    palmSize: 0.2,
    indexTip: landmarks[tips[1]],
    middleTip: landmarks[tips[2]],
    wrist: landmarks[0],
    landmarks,
    handedness: 'Right',
    at: t * 1000,
  };
}

function update(dt) {
  const time = state.time;
  const flashPower = flash.update(dt);
  if (flower) flower.setFlashPower(flashPower);

  /* ---- 1. tension → spread ---------------------------------------------- */
  if (SYNTH_HAND) state.hand = syntheticHand(time);

  let targetTension;
  if (state.forcedSpread !== null) {
    targetTension = state.forcedSpread;
  } else if (state.cameraOn) {
    targetTension = state.hand.present ? state.hand.tension : 0.24;
  } else if (SYNTH_HAND) {
    targetTension = state.hand.tension;
  } else {
    targetTension = demoTension(time);
  }

  if (state.forcedSpread !== null) {
    state.tension = state.forcedSpread;
    state.spread = state.forcedSpread;
  } else {
    state.tension = damp(state.tension, targetTension, 0.32, dt);
    const targetSpread = smoothstep(CONFIG.thresholds.closed, CONFIG.thresholds.open, state.tension);
    // 不对称缓动：张开像爆炸，收回像凝聚
    const spreadLambda = targetSpread > state.spread
      ? CONFIG.smoothing.spreadOut
      : CONFIG.smoothing.spreadIn;
    state.spread = damp(state.spread, targetSpread, spreadLambda, dt);
  }

  /* ---- 2. 指尖位置（考虑摄像头 cover 裁切）------------------------------ */
  const cover = state.cameraOn && dom.video.videoWidth
    ? getVideoCover(dom.video, window.innerWidth, window.innerHeight)
    : null;

  let pointerX = state.pointer.x;
  let pointerY = state.pointer.y;
  let pointerStrength = 0;

  if (state.cameraOn && state.hand.present && cover) {
    const tip = state.hand.indexTip;
    const sx = cover.ox + (1 - tip.x) * cover.dw;
    const sy = cover.oy + tip.y * cover.dh;
    pointerX = (sx / window.innerWidth) * 2 - 1;
    pointerY = 1 - (sy / window.innerHeight) * 2;
    pointerStrength = 0.35 + 0.65 * clamp(state.hand.extensions?.[0] ?? 1, 0, 1);
  } else if (state.pointerActive && !state.cameraOn) {
    pointerX = state.pointerPos.x * 2 - 1;
    pointerY = 1 - state.pointerPos.y * 2;
    pointerStrength = 0.5;
  }

  state.pointer.x = damp(state.pointer.x, pointerX, 0.24, dt);
  state.pointer.y = damp(state.pointer.y, pointerY, 0.24, dt);
  state.pointerStrength = damp(state.pointerStrength, pointerStrength, 0.12, dt);
  flower.setPointer(state.pointer.x, state.pointer.y, state.pointerStrength);

  /* ---- 3. 雷花跟随 / 倾斜 ----------------------------------------------- */
  const maxOffsetX = Math.min(1.15, Math.max(0, viewWidth / 2 - 2.0));
  const maxOffsetY = Math.min(1.0, Math.max(0, viewHeight / 2 - 2.05));

  let targetX = 0;
  let targetY = -0.16;
  let targetYaw = 0;
  // 聚雷时保持直立，雷绽时徐徐转向镜头，露出放电束的正面轮廓
  let targetTiltX = smoothstep(0.12, 0.86, state.spread) * 1.28;
  let targetTiltZ = 0;

  if (state.cameraOn && state.hand.present) {
    const palm = state.hand.palmCenter;
    let fx = palm.x;
    let fy = palm.y;

    if (cover) {
      const sx = cover.ox + (1 - palm.x) * cover.dw;
      const sy = cover.oy + palm.y * cover.dh;
      fx = sx / window.innerWidth;
      fy = sy / window.innerHeight;
    }

    targetX = clamp((fx - 0.5) * viewWidth * 0.55, -maxOffsetX, maxOffsetX);
    targetY += clamp((0.5 - fy) * viewHeight * 0.42, -maxOffsetY, maxOffsetY);

    const dx = -(state.hand.middleTip.x - state.hand.wrist.x);
    const dy = state.hand.middleTip.y - state.hand.wrist.y;
    targetTiltZ = clamp(Math.atan2(dx, -dy), -0.5, 0.5) * 0.75;
    targetTiltX += clamp((fy - 0.5) * 0.42, -0.2, 0.2);
    targetYaw = clamp((fx - 0.5) * 0.8, -0.35, 0.35);
  } else if (state.pointerActive && !state.introOpen) {
    targetX = (state.pointerPos.x - 0.5) * viewWidth * 0.05;
    targetY += (0.5 - state.pointerPos.y) * viewHeight * 0.04;
  }

  // 手机开场卡片占了下半屏，把雷球轻轻托到卡片上方
  if (state.introOpen && window.innerWidth < 700) targetY += 0.42;

  flower.group.position.x = damp(flower.group.position.x, targetX, CONFIG.smoothing.follow, dt);
  flower.group.position.y = damp(flower.group.position.y, targetY, CONFIG.smoothing.follow, dt);

  spin += dt * 0.1;
  state.yaw = damp(state.yaw, targetYaw, 0.08, dt);
  state.tiltX = damp(state.tiltX, targetTiltX, 0.08, dt);
  state.tiltZ = damp(state.tiltZ, targetTiltZ, 0.08, dt);
  flower.group.rotation.set(state.tiltX, spin + state.yaw, state.tiltZ);

  /* ---- 4. 雷花 uniform / 星尘 ------------------------------------------- */
  flower.update(dt, time, state.spread, state.tension);

  starfield.rotation.y += dt * 0.005;
  starfield.rotation.z = Math.sin(time * 0.03) * 0.02;

  /* ---- 5. 骨架叠加层 ----------------------------------------------------- */
  overlay.draw({
    hand: state.hand,
    video: dom.video,
    tension: state.tension,
    time,
    dt,
  });

  /* ---- 6. 指尖雷电层 ----------------------------------------------------- */
  projectedFlower.copy(flower.group.position);
  projectedFlower.project(camera);
  const flowerScreen = {
    x: (projectedFlower.x * 0.5 + 0.5) * window.innerWidth,
    y: (-projectedFlower.y * 0.5 + 0.5) * window.innerHeight,
  };
  fingerFx.draw({
    hand: state.hand,
    video: dom.video,
    tension: state.tension,
    spread: state.spread,
    time,
    dt,
    flowerScreen,
  });
  if (dom.flashOverlay) {
    dom.flashOverlay.style.opacity = String(
      clamp(fingerFx.flash * CONFIG.lightning.flashTint, 0, 0.14)
    );
  }

  // 指尖雷层打出的强闪，叠加到 3D 雷花的爆闪与冲击环
  if (fingerFx.consumeStroke() && flower) flower.addSurge(0.55);

  audio.update(dt, {
    tension: state.tension,
    spread: state.spread,
    power: flashPower,
    active: state.cameraOn || state.mode === 'demo',
  });
}

/* ========================================================================== *
 *  HUD
 * ========================================================================== */

function updateHud() {
  const shown = state.forcedSpread !== null ? state.spread : state.tension;
  const percent = clamp(shown * 100, 0, 100);

  dom.tensionValue.textContent = shown.toFixed(2);
  dom.meterFill.style.width = `${percent.toFixed(1)}%`;
  dom.meter.setAttribute('aria-valuenow', String(Math.round(percent)));

  const zone = shown < CONFIG.thresholds.closed
    ? 'bud'
    : shown > CONFIG.thresholds.open
      ? 'bloom'
      : 'mid';

  if (dom.meter.dataset.state !== zone) {
    dom.meter.dataset.state = zone;
    dom.meterState.dataset.state = zone;
    dom.meterState.textContent = zone === 'bud' ? '聚雷' : zone === 'bloom' ? '雷绽' : '电离';
  }

  if (isDebug) updateDebug();
}

function updateDebug() {
  const info = renderer.info.render;
  const h = state.hand;
  dom.debug.textContent = [
    `mode      ${state.cameraOn ? 'camera' : 'demo'}  phase=${gesture.phase}`,
    `webgl2    ${renderer.capabilities.isWebGL2}  dpr=${renderer.getPixelRatio().toFixed(2)}`,
    `fps       ${state.fps.toFixed(1)}  frames=${frameCount}`,
    `particles ${flower?.count ?? 0}  draws=${info.calls}  tris=${info.triangles}`,
    `tension   ${state.tension.toFixed(3)}  spread=${state.spread.toFixed(3)}`,
    `hand      present=${!!h.present}  raw=${(h.rawTension ?? 0).toFixed(3)}`,
    `fx        bolts=${fingerFx.activeBolts}  flash=${fingerFx.flash.toFixed(2)}  fade=${fingerFx.presence.toFixed(2)}`,
    `storm     power=${flash.power.toFixed(2)}  exposure=${renderer.toneMappingExposure.toFixed(3)}`,
    `audio     ${audio.ready ? 'ready' : 'locked'}  ${audio.muted ? 'muted' : 'on'}`,
    `pointer   ${state.pointer.x.toFixed(2)}, ${state.pointer.y.toFixed(2)}  s=${state.pointerStrength.toFixed(2)}`,
    `video     ${dom.video.videoWidth}x${dom.video.videoHeight}`,
  ].join('\n');
}

function trackFps(rawDt) {
  if (rawDt > 0.5) return;
  frameCount++;
  fpsFrames++;
  fpsTimer += rawDt;

  if (fpsTimer >= 0.8) {
    state.fps = fpsFrames / fpsTimer;
    fpsFrames = 0;
    fpsTimer = 0;

    if (!state.reducedQuality
      && state.time > 9
      && !state.introOpen
      && state.fps > 0
      && state.fps < 38
      && renderer.getPixelRatio() > 1.25) {
      state.reducedQuality = true;
      state.qualityCap = 1.25;
      resize();
      console.info('[quality] reduced render scale to keep 60fps');
    }
  }
}

/* ========================================================================== *
 *  动画循环
 * ========================================================================== */

function animate() {
  requestAnimationFrame(animate);

  const rawDt = clock.getDelta();
  const dt = Math.min(rawDt, 1 / 20);
  state.time += dt;

  trackFps(rawDt);
  update(dt);

  // 相机震动：从零重算，绝不累加；强度跟强闪功率走
  const shake = flash.power * CONFIG.lightning.shakeAmp;
  camera.position.x = (Math.random() - 0.5) * shake;
  camera.position.y = (Math.random() - 0.5) * shake;
  camera.lookAt(0, 0, 0);

  // 强闪期间轻微抬高曝光；回落后严格回到 0.98 基线
  renderer.toneMappingExposure = BASE_EXPOSURE
    * (flash.power > 0.05 ? 1 + flash.power * 0.35 : 1);

  uiTimer += dt;
  if (uiTimer >= 0.09) {
    uiTimer = 0;
    updateHud();
  }

  renderer.render(scene, camera);
}

/* ========================================================================== *
 *  事件绑定
 * ========================================================================== */

gesture.addEventListener('status', (event) => {
  const { phase } = event.detail;
  if (phase === 'requesting') setStatus('busy', '请求摄像头权限');
  else if (phase === 'loading') setStatus('busy', '加载识别模型');
  else if (phase === 'tracking' || phase === 'waiting') {
    setStatus('live', state.hand.present ? '手部追踪中' : '等待手部');
  } else if (phase === 'error') setStatus('error', '识别不可用');
  else if (phase === 'idle' && !state.cameraOn) setStatus('demo', '演示模式');
});

gesture.addEventListener('hand', (event) => {
  state.hand = event.detail || { present: false };
  if (state.cameraOn) {
    setStatus('live', event.detail?.present ? '手部追踪中' : '等待手部');
  }
});

gesture.addEventListener('warning', (event) => {
  if (event.detail?.message) showToast(event.detail.message, 'warn', 6000);
});

gesture.addEventListener('error', (event) => {
  console.error('[gesture]', event.detail?.error);
});

dom.btnCamera.addEventListener('click', toggleCamera);

dom.btnBackdrop.addEventListener('click', () => {
  state.backdrop = !state.backdrop;
  document.body.dataset.backdrop = state.backdrop ? 'on' : 'off';
  dom.btnBackdrop.setAttribute('aria-pressed', String(state.backdrop));
  showToast(state.backdrop ? '摄像头背景：开启' : '摄像头背景：关闭', 'info', 2200);
});

dom.btnSkeleton.addEventListener('click', () => {
  state.skeleton = !state.skeleton;
  overlay.enabled = state.skeleton;
  if (!state.skeleton) overlay.clear();
  dom.btnSkeleton.setAttribute('aria-pressed', String(state.skeleton));
  showToast(state.skeleton ? '手部关键点：显示' : '手部关键点：隐藏', 'info', 2200);
});

dom.btnInfo.addEventListener('click', (event) => {
  event.stopPropagation();
  setInfo(!dom.infoPanel.classList.contains('is-open'));
});

function toggleAudio() {
  if (!audio.ready) {
    audio.setMuted(false);
    audio.unlock();
    dom.btnAudio.setAttribute('aria-pressed', 'true');
    dom.btnAudio.classList.remove('is-off');
    showToast('音效：开启', 'info', 2000);
    return;
  }
  audio.setMuted(!audio.muted);
  const on = !audio.muted;
  dom.btnAudio.setAttribute('aria-pressed', String(on));
  dom.btnAudio.classList.toggle('is-off', !on);
  if (on) audio.unlock();
  showToast(on ? '音效：开启' : '音效：静音', 'info', 2000);
}

dom.btnAudio.addEventListener('click', toggleAudio);
audio.setMuted(false);
dom.btnAudio.setAttribute('aria-pressed', 'true');

dom.btnCloseInfo.addEventListener('click', () => setInfo(false));

document.addEventListener('pointerdown', (event) => {
  if (!dom.infoPanel.classList.contains('is-open')) return;
  if (dom.infoPanel.contains(event.target) || dom.btnInfo.contains(event.target)) return;
  setInfo(false);
});

dom.btnStart.addEventListener('click', () => {
  audio.unlock();
  enableCamera({ fromIntro: true });
});

dom.btnDemo.addEventListener('click', () => {
  audio.unlock();
  closeIntro();
  setStatus('demo', '演示模式');
  showToast('演示模式 · 注意雷花随呼吸聚散', 'info');
});

window.addEventListener('pointermove', (event) => {
  state.pointerPos.set(
    event.clientX / Math.max(1, window.innerWidth),
    event.clientY / Math.max(1, window.innerHeight),
  );
  state.pointerActive = true;
}, { passive: true });

window.addEventListener('pointerdown', (event) => {
  state.pointerPos.set(
    event.clientX / Math.max(1, window.innerWidth),
    event.clientY / Math.max(1, window.innerHeight),
  );
  state.pointerActive = true;
}, { passive: true });

// 浏览器自动播放策略：第一次真实手势时解锁音频；?cam=1 直达也能生效
const unlockAudioOnce = () => { audio.unlock(); };
window.addEventListener('pointerdown', unlockAudioOnce, { once: true, capture: true });
window.addEventListener('touchstart', unlockAudioOnce, { once: true, capture: true, passive: true });

document.addEventListener('pointerleave', () => { state.pointerActive = false; });
window.addEventListener('blur', () => { state.pointerActive = false; });

window.addEventListener('keydown', (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const key = event.key.toLowerCase();
  if (key === 'c') toggleCamera();
  else if (key === 'b') dom.btnBackdrop.click();
  else if (key === 'h') dom.btnSkeleton.click();
  else if (key === 'i') setInfo(!dom.infoPanel.classList.contains('is-open'));
  else if (key === 'm') toggleAudio();
  else if (key === 'escape') setInfo(false);
});

window.addEventListener('resize', resize);
window.addEventListener('orientationchange', () => window.setTimeout(resize, 220));

dom.canvas.addEventListener('webglcontextlost', (event) => {
  event.preventDefault();
  showToast('图形上下文丢失，正在等待恢复…', 'error', 8000);
});

dom.canvas.addEventListener('webglcontextrestored', () => {
  showToast('图形上下文已恢复', 'ok');
});

/* ========================================================================== *
 *  启动
 * ========================================================================== */

resize();
buildFlower(readParticleCount());
if (params.get('skeleton') === '0') state.skeleton = false;
setCameraUI(false);
overlay.enabled = state.skeleton;
dom.btnSkeleton.setAttribute('aria-pressed', String(state.skeleton));
state.spread = state.forcedSpread ?? 0;
state.tension = state.forcedSpread ?? 0;
flower.update(0, 0, state.spread, state.tension);

if (isDebug) {
  dom.debug.hidden = false;
  console.info('[bloom] debug mode on');
}

const autoDemo = params.get('demo') === '1';
const autoCam = params.get('cam') === '1';

if (state.forcedSpread !== null) {
  dom.btnCamera.title = '预览模式：雷电绽放程度已锁定（C 仍可开启摄像头）';
  closeIntro();
  setStatus('demo', '预览模式');
} else if (autoDemo) {
  closeIntro();
  setStatus('demo', '演示模式');
}

if (autoCam) {
  window.setTimeout(() => enableCamera({ fromIntro: true }), 450);
}

window.BLOOM = {
  config: CONFIG,
  get flower() { return flower; },
  get state() {
    return {
      mode: state.cameraOn ? 'camera' : 'demo',
      phase: gesture.phase,
      tension: state.tension,
      spread: state.spread,
      forcedSpread: state.forcedSpread,
      handPresent: !!state.hand.present,
      particleCount: flower?.count ?? 0,
      fps: state.fps,
    };
  },
  setParticleCount,
  setSpread(value) {
    const v = clamp(Number(value) || 0, 0, 1);
    state.forcedSpread = v;
    state.tension = v;
    state.spread = v;
    closeIntro();
    setStatus('demo', '预览模式');
    showToast(`预览雷电绽放 ${v.toFixed(2)} · 调用 BLOOM.autoSpread() 恢复`, 'info', 5000);
    return v;
  },
  autoSpread() {
    state.forcedSpread = null;
    setStatus('demo', '演示模式');
    showToast('已恢复自动演示', 'info');
  },
  startCamera: () => enableCamera(),
  stopCamera: disableCamera,
  flash: () => {
    flash.trigger();
    return flash.power;
  },
  unlockAudio: () => audio.unlock(),
  audioInfo: () => ({
    ready: audio.ready,
    muted: audio.muted,
    duration: audio.duration,
    offset: audio.mainOffset,
    voices: audio._voices,
    lastStroke: audio.lastStroke || null,
  }),
};

animate();

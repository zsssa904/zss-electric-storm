/**
 * 手势控制器
 * ---------------------------------------------------------------------------
 * MediaPipe Hands 输出 21 个归一化关键点。为了得到对距离 / 手大小 / 画面比例
 * 都不敏感的“张开度”，我们使用下面这套公式：
 *
 *   palm = mean(|wrist - mcp_i|)                     i = 5, 9, 13, 17
 *   ext_i = clamp((|tip_i - wrist| - |mcp_i - wrist|) / palm / 0.95, 0, 1)
 *   thumb = clamp((|tip4 - mcp5| / palm - 0.62) / 0.85, 0, 1)
 *   tension = 0.27*ext_index + 0.24*ext_middle + 0.19*ext_ring
 *           + 0.15*ext_pinky + 0.15*thumb
 *
 * 直觉：握拳时指尖缩回掌心，|tip - wrist| 与 |mcp - wrist| 接近 → ext≈0；
 * 张开时指尖远离手腕，差值约为一个手掌 → ext≈1。
 * 距离在“按画面宽高比校正”的坐标里计算，避免 16:9 / 4:3 拉伸造成误差。
 * 最后对 tension 做指数平滑，消除关键点抖动。
 */
import { CONFIG, clamp } from './config.js';

const LOCAL_BASE = './vendor/hands/';
const CDN_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/';

/** 实际加载 hands.js 的目录（本地优先，失败回退 CDN） */
let handsBase = LOCAL_BASE;

const TIP = [8, 12, 16, 20];
const MCP = [5, 9, 13, 17];
const FINGER_WEIGHTS = [0.27, 0.24, 0.19, 0.15];
const THUMB_WEIGHT = 0.15;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`无法加载脚本：${src}`));
    document.head.appendChild(script);
  });
}

/** 优先使用本地 vendor 版本，失败时回退 CDN。 */
async function ensureHandsLibrary() {
  if (window.Hands) return handsBase;

  try {
    await loadScript(LOCAL_BASE + 'hands.js');
    if (window.Hands) {
      handsBase = LOCAL_BASE;
      return handsBase;
    }
  } catch (_) {
    /* 继续尝试 CDN */
  }

  await loadScript(CDN_BASE + 'hands.js');
  if (!window.Hands) {
    const err = new Error('手势识别库加载失败');
    err.code = 'HANDS_LIB';
    throw err;
  }
  handsBase = CDN_BASE;
  return handsBase;
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export class GestureController extends EventTarget {
  constructor(video) {
    super();
    this.video = video;
    this.hands = null;
    this.stream = null;
    this.running = false;
    this.busy = false;
    this.rafId = 0;
    this.lastSend = 0;
    this.aspect = 16 / 9;
    this.phase = 'idle';
    this.tension = 0;
    this.rawTension = 0;
    this.hand = { present: false };
    this.lastHandAt = 0;
    this.lastResultAt = 0;
    this.startedAt = 0;
    this.watchdogFired = false;
    this._cameraInfo = null;

    this._loop = this._loop.bind(this);
  }

  get active() {
    return this.running;
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  _setPhase(phase, message = '') {
    if (this.phase === phase) return;
    this.phase = phase;
    this._emit('status', { phase, message });
  }

  /* ------------------------------------------------------------------------ */
  async start() {
    if (this.running) return this;

    if (!window.isSecureContext) {
      const err = new Error('需要 HTTPS 或 localhost 才能访问摄像头');
      err.code = 'INSECURE_CONTEXT';
      this._fail(err);
      throw err;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      const err = new Error('当前浏览器不支持摄像头采集');
      err.code = 'NO_MEDIA';
      this._fail(err);
      throw err;
    }

    try {
      this._setPhase('requesting', '正在请求摄像头权限…');
      const base = await ensureHandsLibrary();

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: 'user',
          width: { ideal: CONFIG.camera.targetWidth },
          height: { ideal: CONFIG.camera.targetHeight },
          frameRate: { ideal: 30, max: 60 },
        },
      });
      this.stream = stream;
      this.video.srcObject = stream;

      await this._waitForVideo();
      await this.video.play().catch(() => {});

      const track = stream.getVideoTracks()[0];
      this._cameraInfo = track?.getSettings?.() || null;
      this.aspect = (this.video.videoWidth / this.video.videoHeight) || 16 / 9;

      this._setPhase('loading', '正在加载手部识别模型…');

      const Hands = window.Hands;
      this.hands = new Hands({
        locateFile: (file) => new URL(`${base}${file}`, document.baseURI).href,
      });
      this.hands.setOptions({
        maxNumHands: CONFIG.camera.maxHands,
        modelComplexity: CONFIG.camera.complexity,
        minDetectionConfidence: CONFIG.camera.minDetection,
        minTrackingConfidence: CONFIG.camera.minTracking,
      });
      this.hands.onResults((results) => this._onResults(results));

      if (typeof this.hands.initialize === 'function') {
        await this.hands.initialize();
      }

      this.running = true;
      this.startedAt = performance.now();
      this.watchdogFired = false;
      this.lastResultAt = 0;
      this.rafId = requestAnimationFrame(this._loop);
      this._emit('status', { phase: 'waiting', message: '等待手部进入画面…' });
      return this;
    } catch (err) {
      await this.stop({ silent: true });
      this._fail(err);
      throw err;
    }
  }

  _waitForVideo() {
    if (this.video.videoWidth > 0) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        this.video.removeEventListener('loadedmetadata', done);
        this.video.removeEventListener('resize', done);
        resolve();
      };
      this.video.addEventListener('loadedmetadata', done, { once: true });
      this.video.addEventListener('resize', done, { once: true });
      setTimeout(done, 4000);
    });
  }

  /* ------------------------------------------------------------------------ */
  _loop() {
    if (!this.running) return;
    const now = performance.now();

    if (!this.watchdogFired && this.startedAt && now - this.startedAt > 14000 && !this.lastResultAt) {
      this.watchdogFired = true;
      this._emit('warning', {
        message: '识别模型加载较慢，首次使用需要下载约 20MB 本地模型，请稍候…',
      });
    }

    if (!this.busy
      && this.video.readyState >= 2
      && now - this.lastSend >= 1000 / CONFIG.camera.detectFps) {
      this.busy = true;
      this.lastSend = now;
      this.hands
        .send({ image: this.video })
        .catch((err) => this._onSendError(err))
        .finally(() => { this.busy = false; });
    }

    this.rafId = requestAnimationFrame(this._loop);
  }

  _onSendError(err) {
    if (!this.running) return;
    console.error('[gesture] send failed:', err);
    this._emit('warning', {
      message: '手势识别出现异常，正在重试…（请确认 vendor/hands 资源完整）',
    });
  }

  /* ------------------------------------------------------------------------ */
  _onResults(results) {
    if (!this.running) return;
    this.lastResultAt = performance.now();
    if (this.phase === 'loading' || this.phase === 'requesting') {
      this._setPhase('tracking', '手部识别已就绪');
    }

    const landmarks = results.multiHandLandmarks?.[0];
    const handedness = results.multiHandedness?.[0]?.label || '';

    if (!landmarks) {
      if (this.hand.present && performance.now() - this.lastHandAt > 260) {
        this.hand = { present: false, tension: this.tension };
        this._emit('hand', this.hand);
      }
      return;
    }

    this.lastHandAt = performance.now();
    const analysis = this._analyze(landmarks);
    const base = CONFIG.smoothing.tension;
    const rate = analysis.raw > this.tension ? base * 1.25 : base * 0.85;
    this.rawTension = analysis.raw;
    this.tension += (analysis.raw - this.tension) * rate;
    this.tension = clamp(this.tension, 0, 1);

    this.hand = {
      present: true,
      tension: this.tension,
      rawTension: analysis.raw,
      palm: analysis.palm,
      palmCenter: analysis.palmCenter,
      indexTip: analysis.indexTip,
      middleTip: analysis.middleTip,
      wrist: analysis.wrist,
      palmSize: analysis.palmSize,
      extensions: analysis.extensions,
      handedness,
      landmarks,
      at: this.lastHandAt,
    };
    this._emit('hand', this.hand);
  }

  _analyze(lm) {
    // x 乘以 aspect，使距离不受视频宽高比影响
    const aspect = this.aspect || 16 / 9;
    const point = (i) => ({ x: lm[i].x * aspect, y: lm[i].y });
    const wrist = point(0);
    const mcpPoints = MCP.map(point);
    const palmSize = Math.max(
      1e-5,
      mcpPoints.reduce((sum, p) => sum + dist(p, wrist), 0) / mcpPoints.length,
    );

    const extensions = TIP.map((tip, i) => {
      const tipDist = dist(point(tip), wrist);
      const baseDist = dist(point(MCP[i]), wrist);
      return clamp((tipDist - baseDist) / palmSize / 0.95, 0, 1);
    });

    const thumb = clamp((dist(point(4), point(5)) / palmSize - 0.62) / 0.85, 0, 1);

    let raw = thumb * THUMB_WEIGHT;
    for (let i = 0; i < 4; i++) raw += extensions[i] * FINGER_WEIGHTS[i];
    raw = clamp(raw, 0, 1);

    // 屏幕坐标（未镜像），用于位置跟随与骨架绘制
    const palmCenter = [0, 5, 9, 13, 17].reduce((acc, i) => {
      acc.x += lm[i].x / 5;
      acc.y += lm[i].y / 5;
      return acc;
    }, { x: 0, y: 0 });

    return {
      raw,
      extensions,
      thumb,
      palmSize,
      palmCenter,
      palm: palmCenter,
      indexTip: { x: lm[8].x, y: lm[8].y },
      middleTip: { x: lm[12].x, y: lm[12].y },
      wrist: { x: lm[0].x, y: lm[0].y },
    };
  }

  /* ------------------------------------------------------------------------ */
  async stop({ silent = false } = {}) {
    this.running = false;
    cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    this.busy = false;

    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    if (this.video.srcObject) this.video.srcObject = null;

    if (this.hands) {
      try { this.hands.close?.(); } catch (_) { /* ignore */ }
      this.hands = null;
    }

    this.hand = { present: false, tension: this.tension };
    this.phase = 'idle';
    if (!silent) {
      this._emit('status', { phase: 'idle', message: '摄像头已关闭' });
      this._emit('hand', this.hand);
    }
    return this;
  }

  _fail(err) {
    this.phase = 'error';
    this._emit('error', { error: err });
    this._emit('status', { phase: 'error', message: err.message });
  }
}

/**
 * 2D 指尖放电层（只负责画）
 * ---------------------------------------------------------------------------
 * 分形算法、节拍、强闪都在 lightning.js；这里把 composer 产出的 Bolt
 * 画成三层发光、余辉拖尾和低分辨率 bloom。
 *
 * 性能红线：
 *  - 不使用 ctx.shadowBlur
 *  - 电弧点数组在 lightning.js 里预分配；这里只读写固定缓冲
 *  - 每帧不 new 路径数组 / 渐变对象
 */

import { CONFIG, clamp, smoothstep } from './config.js';
import { getVideoCover } from './overlay.js';
import { LightningComposer } from './lightning.js';

const TIPS = [4, 8, 12, 16, 20];
const PALM = [0, 5, 9, 13, 17];
const DRAW_X = new Float32Array(128);
const DRAW_Y = new Float32Array(128);

function makeGlowSprite() {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.16, 'rgba(210,250,255,.85)');
  g.addColorStop(0.42, 'rgba(90,200,255,.32)');
  g.addColorStop(1, 'rgba(40,80,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return canvas;
}

export class FingerLightning {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.composer = new LightningComposer();
    this.width = 1;
    this.height = 1;
    this.dpr = 1;
    this.enabled = true;
    this.pts = new Float32Array(42);
    this.bloomCanvas = document.createElement('canvas');
    this.bloomCtx = this.bloomCanvas.getContext('2d');
    this.glow = makeGlowSprite();
    this.shake = { x: 0, y: 0 };
    this.flash = 0;
    this.presence = 0;
    this.activeBolts = 0;
    this._ink = false;
    this._hadHand = false;
    this._lastPts = false;
  }

  resize(width, height, dpr) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.dpr = dpr;
    this.canvas.width = Math.round(this.width * dpr);
    this.canvas.height = Math.round(this.height * dpr);
    this.composer.resize(this.width, this.height);

    const scale = CONFIG.lightning.bloomScale * dpr;
    this.bloomCanvas.width = Math.max(1, Math.round(this.width * scale));
    this.bloomCanvas.height = Math.max(1, Math.round(this.height * scale));
    this._bloomScale = scale;
    this.clear();
  }

  clear() {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.composer.reset();
    this._ink = false;
    this.activeBolts = 0;
    this.presence = 0;
    this.flash = 0;
    this.shake.x = 0;
    this.shake.y = 0;
  }

  _map(hand, video) {
    const cover = getVideoCover(video, this.width, this.height);
    const lm = hand.landmarks;
    for (let i = 0; i < 21; i++) {
      const p = lm[i];
      this.pts[i * 2] = cover.ox + (1 - p.x) * cover.dw;
      this.pts[i * 2 + 1] = cover.oy + p.y * cover.dh;
    }
    return this.pts;
  }

  draw({ hand, video, tension = 0, spread = 0, time = 0, dt = 1 / 60, flowerScreen = null }) {
    if (!this.enabled) {
      if (this._ink) this.clear();
      return;
    }

    const hasHand = !!(hand?.present && hand.landmarks?.length);
    const points = hasHand ? this._map(hand, video) : null;

    this.composer.update(dt, time, {
      points,
      tension,
      spread,
      flowerScreen,
    });

    this.flash = this.composer.flash;
    this.presence = this.composer.presence;
    this.activeBolts = this.composer.activeCount;
    this.shake.x = this.composer.shakeX;
    this.shake.y = this.composer.shakeY;

    if (!hasHand && this.presence <= 0) {
      if (this._ink) this.clear();
      this._hadHand = false;
      return;
    }

    this._fade(dt);
    this._ink = true;

    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.miterLimit = 1.5;

    this._beginBloom();
    const composer = this.composer;
    const k = smoothstep(0, 1, composer.blend);
    const presence = composer.presence;

    for (let b = 0; b < composer.activeCount; b++) {
      const bolt = composer.pool[b];
      if (!bolt.active || bolt.curCount < 2) continue;

      this._buildDrawBuffer(bolt.cur, bolt.curCount, bolt.prev, bolt.prevCount, k, time, bolt.seed);

      const flicker = 0.78 + 0.22 * Math.sin(time * 2.7 + bolt.seed);
      const outer = flicker * presence * (1 + this.flash * 0.85);
      this._drawPath(ctx, bolt.curCount, bolt.width, bolt.alpha * outer);

      if (CONFIG.lightning.bloom && bolt.width > 0.8) {
        this._bloomPath(bolt.width * 7, presence * bolt.alpha * 0.5, bolt.curCount);
      }

      for (let j = 0; j < bolt.branches.length; j++) {
        const branch = bolt.branches[j];
        if (branch.curCount < 2) continue;
        this._buildDrawBuffer(
          branch.cur,
          branch.curCount,
          branch.prev,
          branch.prevCount,
          k,
          time,
          branch.seed,
        );
        this._drawPath(ctx, branch.curCount, bolt.width * branch.width, bolt.alpha * branch.alpha * outer);
      }

    }

    this._endBloom(ctx);
    this._drawGlows(ctx, hasHand, presence);
    if (hasHand) this._maskByPalm(this.composer.pts);
    // 强闪由 DOM 叠层显示，不能画进带余辉的 Canvas，否则会逐帧累积成灰雾
  }

  /**
   * 手挡在雷球前时，让掌心的电弧稍微“退后”。
   * 只做 destination-out 擦除，不画任何手部轮廓；独立 save/restore，
   * 不碰 _fade() 的 globalAlpha 与合成状态。
   */
  _maskByPalm(pts) {
    const ids = [0, 1, 5, 9, 13, 17];
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i] * 2;
      cx += pts[id];
      cy += pts[id + 1];
    }
    cx /= ids.length;
    cy /= ids.length;

    const d0 = Math.hypot(pts[0] - pts[18], pts[1] - pts[19]);
    const d1 = Math.hypot(pts[10] - pts[34], pts[11] - pts[35]);
    const r = (d0 + d1) * 0.5 * 1.05;
    if (r < 8) return;

    const ctx = this.ctx;
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.globalAlpha = 0.35;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = '#000';
    ctx.fill();
    ctx.restore();
    if (this.ctx.globalAlpha !== 1) this.ctx.globalAlpha = 1;
  }

  _fade(dt) {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.globalAlpha = 1 - Math.exp(-dt / CONFIG.lightning.trailSeconds);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  _buildDrawBuffer(cur, count, prev, prevCount, k, time, seed) {
    const pc = prevCount || count;
    const denom = Math.max(1, count - 1);
    const canBlend = prevCount >= 2;
    for (let i = 0; i < count; i++) {
      const ratio = (i / denom) * (pc - 1);
      const j = Math.floor(ratio);
      const f = ratio - j;
      const j2 = Math.min(pc - 1, j + 1);
      const px = canBlend ? prev[j * 2] + (prev[j2 * 2] - prev[j * 2]) * f : cur[i * 2];
      const py = canBlend ? prev[j * 2 + 1] + (prev[j2 * 2 + 1] - prev[j * 2 + 1]) * f : cur[i * 2 + 1];
      const wobble = 0.7 * (1 - k);
      DRAW_X[i] = px + (cur[i * 2] - px) * k + Math.sin(time * 54 + seed + i * 1.83) * wobble;
      DRAW_Y[i] = py + (cur[i * 2 + 1] - py) * k + Math.cos(time * 47 + seed * 1.3 + i * 1.37) * wobble;
    }
  }

  _drawPath(ctx, count, baseWidth, alpha) {
    const widths = [3.5, 1.55, 0.62];
    const alphas = [0.11, 0.46, 0.96];
    const taperW = [1, 0.6, 0.4];
    const taperA = [1, 0.88, 0.72];

    for (let layer = 0; layer < 3; layer++) {
      ctx.strokeStyle = layer === 0
        ? CONFIG.lightning.colors.outer
        : layer === 1
          ? CONFIG.lightning.colors.mid
          : CONFIG.lightning.colors.inner;

      for (let chunk = 0; chunk < 2; chunk++) {
        const start = Math.floor((count - 1) * (chunk / 2));
        const end = Math.floor((count - 1) * ((chunk + 1) / 2));
        if (end <= start) continue;

        ctx.globalAlpha = clamp(alpha * alphas[layer] * taperA[chunk], 0, 1);
        ctx.lineWidth = Math.max(0.35, baseWidth * widths[layer] * taperW[chunk]);
        ctx.beginPath();
        ctx.moveTo(DRAW_X[start], DRAW_Y[start]);
        for (let i = start + 1; i <= end; i++) ctx.lineTo(DRAW_X[i], DRAW_Y[i]);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  _beginBloom() {
    if (!CONFIG.lightning.bloom) return;
    const bctx = this.bloomCtx;
    bctx.setTransform(1, 0, 0, 1, 0, 0);
    bctx.clearRect(0, 0, this.bloomCanvas.width, this.bloomCanvas.height);
    bctx.setTransform(this._bloomScale || 0.5, 0, 0, this._bloomScale || 0.5, 0, 0);
    bctx.globalCompositeOperation = 'lighter';
    bctx.lineCap = 'round';
    bctx.lineJoin = 'round';
  }

  _bloomPath(width, alpha, count) {
    if (!CONFIG.lightning.bloom) return;
    const ctx = this.bloomCtx;
    ctx.strokeStyle = CONFIG.lightning.colors.outer;
    ctx.globalAlpha = clamp(alpha * 0.34, 0, 0.7);
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(DRAW_X[0], DRAW_Y[0]);
    for (let i = 1; i < count; i++) ctx.lineTo(DRAW_X[i], DRAW_Y[i]);
    ctx.stroke();
  }

  _endBloom(ctx) {
    if (!CONFIG.lightning.bloom) return;
    ctx.globalAlpha = 0.5;
    ctx.drawImage(this.bloomCanvas, 0, 0, this.width, this.height);
    ctx.globalAlpha = 1;
  }

  _drawGlows(ctx, hasHand, presence) {
    if (!hasHand && presence <= 0) return;
    const p = this.composer.pts;
    const open = this.composer.open;
    const closed = this.composer.closed;
    const baseR = 20 + open * 12;

    for (let i = 0; i < TIPS.length; i++) {
      const id = TIPS[i] * 2;
      const r = baseR * (0.85 + i * 0.03);
      ctx.globalAlpha = clamp(presence * (0.55 + this.flash * 0.5), 0, 1);
      ctx.drawImage(this.glow, p[id] - r, p[id + 1] - r, r * 2, r * 2);
    }

    if (closed > 0.1) {
      const r = this.composer.palmSize * 0.75;
      ctx.globalAlpha = clamp(presence * closed * 0.75, 0, 1);
      ctx.drawImage(this.glow, this.composer.palmX - r, this.composer.palmY - r, r * 2, r * 2);
    }
    ctx.globalAlpha = 1;
  }

  consumeStroke() {
    return this.composer.consumeStroke();
  }

  debugStats() {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let b = 0; b < this.composer.activeCount; b++) {
      const bolt = this.composer.pool[b];
      for (let i = 0; i < bolt.curCount; i++) {
        const x = bolt.cur[i * 2];
        const y = bolt.cur[i * 2 + 1];
        if (!Number.isFinite(x) || !Number.isFinite(y)) return 'nan';
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    return `${Math.round(minX)},${Math.round(minY)}..${Math.round(maxX)},${Math.round(maxY)}`;
  }
}

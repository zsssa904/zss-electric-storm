/**
 * 分形闪电算法
 * ---------------------------------------------------------------------------
 * 只负责“算”：中点位移生成主干、折返点、递归分支、节拍与强闪。
 * 具体的 Canvas 绘制在 fingerlightning.js 里，所有参数在 config.js。
 *
 * 关键点：
 *  - 中点位移递归细分，主弧 2^5 段，分支再递归 1~2 层
 *  - 抖动幅度按当前段长度缩放，主干粗、分支细
 *  - 随机折返（kink），避免正弦折线感
 *  - 8~15Hz 重新生成形状，帧间用 prev/cur 插值
 *  - 对象池：Bolt / Branch 数组全部预分配，绘制期间不 new
 */

import { CONFIG, clamp, smoothstep } from './config.js';

const TAU = Math.PI * 2;
const MAX_MAIN_POINTS = 110;
const MAX_BRANCH_POINTS = 48;
const BRANCH_SLOTS = 4;
const FLOAT_COUNT = 21 * 2;

const SX = new Float32Array((1 << 6) + 1);
const SY = new Float32Array((1 << 6) + 1);

const FINGERS = [
  { mcp: 1, pip: 2, dip: 3, tip: 4, scale: 1.0 },
  { mcp: 5, pip: 6, dip: 7, tip: 8, scale: 1.08 },
  { mcp: 9, pip: 10, dip: 11, tip: 12, scale: 1.04 },
  { mcp: 13, pip: 14, dip: 15, tip: 16, scale: 0.96 },
  { mcp: 17, pip: 18, dip: 19, tip: 20, scale: 0.86 },
];

const PAIRS = [
  [4, 8, 0.55],
  [8, 12, 0.55],
  [12, 16, 0.55],
  [4, 20, 0.78],
];

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 低频、连续的一维噪声（不分配） */
function noise1(x) {
  return 0.5 + 0.5 * Math.sin(x * 1.73 + Math.sin(x * 0.71) * 2.3);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** 一条固定容量的电弧分支（预分配） */
class Branch {
  constructor() {
    this.cur = new Float32Array(MAX_BRANCH_POINTS * 2);
    this.prev = new Float32Array(MAX_BRANCH_POINTS * 2);
    this.curCount = 0;
    this.prevCount = 0;
    this.width = 1;
    this.alpha = 1;
    this.seed = 0;
  }

  begin() {
    const swap = this.cur;
    this.cur = this.prev;
    this.prev = swap;
    this.prevCount = this.curCount;
    this.curCount = 0;
  }
}

/** 一条主电弧 + 最多 4 条分支（预分配） */
class Bolt {
  constructor() {
    this.cur = new Float32Array(MAX_MAIN_POINTS * 2);
    this.prev = new Float32Array(MAX_MAIN_POINTS * 2);
    this.curCount = 0;
    this.prevCount = 0;
    this.width = 1;
    this.alpha = 1;
    this.seed = 0;
    this.active = false;
    this.branches = Array.from({ length: BRANCH_SLOTS }, () => new Branch());
  }

  begin() {
    const swap = this.cur;
    this.cur = this.prev;
    this.prev = swap;
    this.prevCount = this.curCount;
    this.curCount = 0;
    this.active = true;
    for (let i = 0; i < this.branches.length; i++) this.branches[i].begin();
  }
}

/**
 * 中点位移生成一条折线，直接写入 out（单位：像素，[x,y,x,y,...]）。
 * 返回点数。
 */
function buildFractal(out, x1, y1, x2, y2, rand, opts) {
  const iterations = clamp(opts.iterations ?? 4, 2, 6);
  const n = 1 << iterations;
  const cap = out.length >> 1;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const roughness = opts.roughness ?? 0.26;
  const kinkChance = opts.kinkChance ?? 0.22;

  SX[0] = x1;
  SY[0] = y1;
  SX[n] = x2;
  SY[n] = y2;

  for (let step = n >> 1; step >= 1; step >>= 1) {
    for (let mid = step; mid < n; mid += step * 2) {
      const t = mid / n;
      const env = Math.sin(Math.PI * t);
      // 越靠近上一级端点，允许的偏移越小；按段长缩放而不是固定振幅
      const amp = roughness * len * Math.pow(step / n, 0.6) * (0.35 + 0.65 * env);
      const off = (rand() * 2 - 1) * amp;
      // 中点必须先落在左右两个已定位点的连线上，再施加垂直位移
      SX[mid] = (SX[mid - step] + SX[mid + step]) * 0.5 + nx * off;
      SY[mid] = (SY[mid - step] + SY[mid + step]) * 0.5 + ny * off;

      // 折返：沿切线方向往回退一点，真实闪电最常见的“毛刺”
      if (rand() < 0.09) {
        const back = len * (0.008 + rand() * 0.022) * env;
        SX[mid] -= (dx / len) * back;
        SY[mid] -= (dy / len) * back;
      }
    }
  }

  let count = 0;
  out[count * 2] = SX[0];
  out[count * 2 + 1] = SY[0];
  count++;

  for (let i = 1; i <= n; i++) {
    if (count >= cap - 2) break;

    // 额外插入一个回退点，形成明显的 kink，而不是平直折线
    if (i > 1 && i < n && rand() < kinkChance) {
      const back = 0.18 + rand() * 0.38;
      out[count * 2] = lerp(SX[i - 1], SX[i], back) + nx * (rand() - 0.5) * 5;
      out[count * 2 + 1] = lerp(SY[i - 1], SY[i], back) + ny * (rand() - 0.5) * 5;
      count++;
    }

    out[count * 2] = SX[i];
    out[count * 2 + 1] = SY[i];
    count++;
  }

  return count;
}

function buildBranches(bolt, rand, depth) {
  const mainCount = bolt.curCount;
  if (mainCount < 8) return 0;

  const ax = bolt.cur[0];
  const ay = bolt.cur[1];
  const bx = bolt.cur[(mainCount - 1) * 2];
  const by = bolt.cur[(mainCount - 1) * 2 + 1];
  const baseAngle = Math.atan2(by - ay, bx - ax);
  const mainLen = Math.hypot(bx - ax, by - ay) || 1;
  let slot = 0;

  const topCount = 1;
  for (let b = 0; b < topCount && slot < BRANCH_SLOTS; b++) {
    const idx = 3 + Math.floor(rand() * Math.max(1, mainCount - 6));
    const px = bolt.cur[idx * 2];
    const py = bolt.cur[idx * 2 + 1];
    const side = rand() < 0.5 ? -1 : 1;
    const angle = baseAngle + side * (0.3 + rand() * 0.9);
    const len = mainLen * (0.18 + rand() * 0.3);
    const ex = px + Math.cos(angle) * len;
    const ey = py + Math.sin(angle) * len;

    const br = bolt.branches[slot++];
    br.width = 0.56;
    br.alpha = 0.82;
    br.seed = rand() * 1000;
    br.curCount = buildFractal(br.cur, px, py, ex, ey, rand, {
      iterations: 3,
      roughness: 0.3,
      kinkChance: 0.18,
    });

    // 第二层：分支的分支，从分支末端再劈一小段
    if (depth > 1 && slot < BRANCH_SLOTS && rand() < 0.35) {
      const sub = bolt.branches[slot++];
      sub.width = 0.3;
      sub.alpha = 0.6;
      sub.seed = rand() * 1000;
      const sAngle = angle + (rand() < 0.5 ? -1 : 1) * (0.35 + rand() * 0.65);
      const sLen = len * (0.3 + rand() * 0.3);
      sub.curCount = buildFractal(sub.cur, ex, ey, ex + Math.cos(sAngle) * sLen, ey + Math.sin(sAngle) * sLen, rand, {
        iterations: 2,
        roughness: 0.34,
        kinkChance: 0.12,
      });
    }
  }

  return slot;
}

/**
 * 电弧合成器：把 21 个手部关键点变成一整套分形电弧。
 * 它不做 Canvas 绘制，只生产当前帧可绘制的 Bolt 数据。
 */
export class LightningComposer {
  constructor() {
    const lightning = CONFIG.lightning;
    this.pool = Array.from({ length: lightning.maxBolts }, () => new Bolt());
    this.activeCount = 0;
    this.pts = new Float32Array(FLOAT_COUNT);
    this.hasHand = false;
    this.presence = 0;
    this.tension = 0;
    this.spread = 0;
    this.beatTime = -1;
    this.nextBeat = 0;
    this.beatIndex = 0;
    this.blend = 1;
    this.flash = 0;
    this.nextFlash = 1.2;
    this.strokeReady = false;
    this.shakeX = 0;
    this.shakeY = 0;
    this.velX = 0;
    this.velY = 0;
    this.lastPalmX = 0;
    this.lastPalmY = 0;
    this.lastBeatAt = -1;
    this.palmX = 0;
    this.palmY = 0;
    this.palmSize = 80;
    this.closed = 0;
    this.open = 0;
    this.rand = mulberry32(0x9e3779b9);
    this.forceBeat = true;
    this.width = 1;
    this.height = 1;
    this.time = 0;
  }

  resize(width, height) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
  }

  reset() {
    this.activeCount = 0;
    this.hasHand = false;
    this.presence = 0;
    this.flash = 0;
    this.shakeX = 0;
    this.shakeY = 0;
    this.beatTime = -1;
    this.nextBeat = 0;
    this.forceBeat = true;
    this.strokeReady = false;
  }

  /**
   * 更新节拍、强闪、震动与手部状态。
   * points 是 [x0,y0,...x20,y20]（21 点，已映射到屏幕像素）。
   */
  update(dt, time, { points = null, tension = 0, spread = 0, flowerScreen = null } = {}) {
    const cfg = CONFIG.lightning;
    this.time = time;
    this.tension = tension;
    this.spread = spread;

    if (points && points.length >= FLOAT_COUNT) {
      this.pts.set(points.subarray ? points.subarray(0, FLOAT_COUNT) : points);
      if (!this.hasHand) this.forceBeat = true;
      this.hasHand = true;
      this.presence = 1;
    } else {
      this.hasHand = false;
      this.presence = Math.max(0, this.presence - dt / 0.3);
    }

    if (this.hasHand && (this.forceBeat || time >= this.nextBeat)) {
      this._compose(time, flowerScreen);
      this.beatTime = time;
      this.beatIndex++;
      this.forceBeat = false;
      const hz = cfg.beatMin + this.rand() * (cfg.beatMax - cfg.beatMin);
      this.nextBeat = time + 1 / hz;
    }

    this.blend = this.beatTime < 0
      ? 1
      : clamp((time - this.beatTime) / cfg.beatBlend, 0, 1);

    // 强闪：每隔 0.4~1.5s 一次，快速衰减
    if (this.hasHand && time >= this.nextFlash) {
      this.flash = 1;
      this.strokeReady = true;
      this.nextFlash = time + cfg.flashMin + this.rand() * (cfg.flashMax - cfg.flashMin);
    }
    this.flash *= Math.exp(-dt * cfg.flashDecay);
    if (this.flash < 0.001) this.flash = 0;

    // 相机震动：跟强闪和整体放电强度相关，使用平滑噪声而不是白噪声
    const amp = cfg.shake * (this.presence * 0.55 + this.flash * 1.6);
    const targetX = (noise1(time * 9.1 + 1.7) - 0.5) * 2 * amp;
    const targetY = (noise1(time * 11.3 + 5.2) - 0.5) * 2 * amp;
    const follow = 1 - Math.pow(0.86, dt * 60);
    this.shakeX += (targetX - this.shakeX) * follow;
    this.shakeY += (targetY - this.shakeY) * follow;

    if (!this.hasHand && this.presence <= 0) this.activeCount = 0;
  }

  consumeStroke() {
    if (!this.strokeReady) return false;
    this.strokeReady = false;
    return true;
  }

  _compose(time, flowerScreen) {
    const cfg = CONFIG.lightning;
    this.activeCount = 0;
    this.beatIndex++;
    this.rand = mulberry32((0x9e3779b9 ^ Math.imul(this.beatIndex, 2654435761)) >>> 0);
    const rand = this.rand;
    const p = this.pts;

    const palm = this._palmCenter();
    const palmSize = Math.max(24, Math.hypot(p[10] - p[0], p[11] - p[1]) * 1.35);
    this.palmX = palm.x;
    this.palmY = palm.y;
    this.palmSize = palmSize;

    const beatDt = this.lastBeatAt < 0 ? 1 / 12 : Math.max(1 / 30, time - this.lastBeatAt);
    if (this.lastBeatAt > 0) {
      this.velX = lerp(this.velX, (palm.x - this.lastPalmX) / beatDt, 0.45);
      this.velY = lerp(this.velY, (palm.y - this.lastPalmY) / beatDt, 0.45);
    }
    this.lastPalmX = palm.x;
    this.lastPalmY = palm.y;
    this.lastBeatAt = time;

    const windX = clamp(-this.velX * 0.1, -46, 46);
    const windY = clamp(-this.velY * 0.1, -46, 46);

    const closed = 1 - smoothstep(0.16, 0.46, this.tension);
    const open = smoothstep(0.42, 0.74, this.tension);
    this.closed = closed;
    this.open = open;

    for (let f = 0; f < FINGERS.length; f++) {
      const finger = FINGERS[f];
      const mcpX = p[finger.mcp * 2];
      const mcpY = p[finger.mcp * 2 + 1];
      const pipX = p[finger.pip * 2];
      const pipY = p[finger.pip * 2 + 1];
      const dipX = p[finger.dip * 2];
      const dipY = p[finger.dip * 2 + 1];
      const tipX = p[finger.tip * 2];
      const tipY = p[finger.tip * 2 + 1];

      let dx = tipX - palm.x;
      let dy = tipY - palm.y;
      let dl = Math.hypot(dx, dy) || 1;
      dx /= dl;
      dy /= dl;

      const ext = clamp(Math.hypot(tipX - mcpX, tipY - mcpY) / palmSize, 0, 1.5);
      const baseLen = (15 + 30 * ext + 36 * open) * finger.scale * (1 - closed * 0.45);
      const len = baseLen * (0.82 + rand() * 0.3);
      const ex = tipX + dx * len + windX * 0.55 + (rand() - 0.5) * 10;
      const ey = tipY + dy * len + windY * 0.55 + (rand() - 0.5) * 10;

      // 指尖高压主弧：张开时更长、更亮
      this._emit(tipX, tipY, ex, ey, {
        width: 1.0 + open * 0.4,
        alpha: 0.9 + open * 0.1,
        branches: f === 1 || f === 2 ? 2 : 1,
        iterations: 4,
        roughness: 0.27,
      });

      // 指骨内爬行电弧（从曲率大的 DIP 关节发出）
      if (rand() < 0.8) {
        const ia = Math.atan2(tipY - dipY, tipX - dipX) + (rand() - 0.5) * 1.2;
        const il = 16 + rand() * 30;
        this._emit(dipX, dipY, dipX + Math.cos(ia) * il, dipY + Math.sin(ia) * il, {
          width: 0.55,
          alpha: 0.7,
          branches: 1,
          iterations: 3,
          roughness: 0.32,
        });
      }

      // 指节凸起的小电弧
      if (rand() < 0.5) {
        const ka = Math.atan2(pipY - mcpY, pipX - mcpX) + (rand() < 0.5 ? -1 : 1) * (0.7 + rand());
        const kl = 14 + rand() * 24;
        this._emit(pipX, pipY, pipX + Math.cos(ka) * kl + windX * 0.3, pipY + Math.sin(ka) * kl + windY * 0.3, {
          width: 0.4,
          alpha: 0.55,
          branches: 0,
          iterations: 3,
          roughness: 0.34,
        });
      }

      // 中指在张开时把一条电弧送向花心，形成“指尖牵引”的联系
      if (flowerScreen && open > 0.2 && f === 2) {
        const mix = 0.22 + open * 0.5;
        const tx = lerp(tipX, flowerScreen.x, mix) + windX * 0.8;
        const ty = lerp(tipY, flowerScreen.y, mix) + windY * 0.8;
        this._emit(tipX, tipY, tx, ty, {
          width: 1.0,
          alpha: 0.8,
          branches: 2,
          iterations: 5,
          roughness: 0.24,
        });
      }
    }

    // 握拳：掌缘绕球爬行的表面电弧 + 向外炸出的短枝
    const radius = palmSize * 0.62;
    if (closed > 0.12) {
      const count = 8 + Math.round(closed * 5);
      for (let i = 0; i < count; i++) {
        const a0 = rand() * TAU;
        const a1 = a0 + 0.35 + rand() * 0.9;
        const r = radius * (0.72 + rand() * 0.34);
        const x0 = palm.x + Math.cos(a0) * r;
        const y0 = palm.y + Math.sin(a0) * r;
        const x1 = palm.x + Math.cos(a1) * r;
        const y1 = palm.y + Math.sin(a1) * r;
        this._emit(x0, y0, x1, y1, {
          width: 0.85,
          alpha: 0.9,
          branches: 1,
          iterations: 4,
          roughness: 0.22,
        });
      }
      for (let i = 0; i < 3; i++) {
        const a = rand() * TAU;
        const r0 = radius * (0.5 + rand() * 0.3);
        const r1 = radius * (1.3 + rand() * 0.7);
        this._emit(
          palm.x + Math.cos(a) * r0,
          palm.y + Math.sin(a) * r0,
          palm.x + Math.cos(a) * r1 + windX * 0.4,
          palm.y + Math.sin(a) * r1 + windY * 0.4,
          { width: 0.75, alpha: 0.7, branches: 1, iterations: 4, roughness: 0.26 },
        );
      }
    } else if (rand() < 0.55) {
      const a = rand() * TAU;
      this._emit(
        palm.x + Math.cos(a) * radius * 0.7,
        palm.y + Math.sin(a) * radius * 0.7,
        palm.x + Math.cos(a) * radius * 1.1,
        palm.y + Math.sin(a) * radius * 1.1,
        { width: 0.5, alpha: 0.45, branches: 0, iterations: 3, roughness: 0.3 },
      );
    }

    // 指尖之间距离足够近时，击穿出细小火花
    for (const [ia, ib, factor] of PAIRS) {
      const ax = p[ia * 2];
      const ay = p[ia * 2 + 1];
      const bx = p[ib * 2];
      const by = p[ib * 2 + 1];
      const d = Math.hypot(bx - ax, by - ay);
      if (d < palmSize * factor && d > 4) {
        this._emit(ax, ay, bx, by, {
          width: 0.45,
          alpha: clamp(1 - d / (palmSize * factor), 0, 1) * 0.9,
          branches: 0,
          iterations: 3,
          roughness: 0.18,
        });
      }
    }
  }

  _palmCenter() {
    const p = this.pts;
    let x = 0;
    let y = 0;
    const ids = [0, 5, 9, 13, 17];
    for (const id of ids) {
      x += p[id * 2];
      y += p[id * 2 + 1];
    }
    return { x: x / ids.length, y: y / ids.length };
  }

  _emit(x1, y1, x2, y2, opts) {
    if (this.activeCount >= this.pool.length) return;
    const bolt = this.pool[this.activeCount++];
    const rand = this.rand;
    bolt.begin();
    bolt.curCount = buildFractal(bolt.cur, x1, y1, x2, y2, rand, {
      iterations: opts.iterations ?? 4,
      roughness: opts.roughness ?? CONFIG.lightning.roughness,
      kinkChance: CONFIG.lightning.kinkChance,
    });
    bolt.width = opts.width ?? 1;
    bolt.alpha = opts.alpha ?? 1;
    bolt.seed = rand() * 1000;

    if ((opts.branches ?? 0) > 0) {
      buildBranches(bolt, rand, Math.min(CONFIG.lightning.branchDepth, opts.branches));
    } else {
      for (const branch of bolt.branches) {
        branch.curCount = 0;
      }
    }
  }
}

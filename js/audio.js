/**
 * 雷声音效
 * ---------------------------------------------------------------------------
 * 使用用户提供的 assets/audio/electric-arc.mp3 作为唯一采样源：
 *   - 强闪触发主放电 + 两次劈啪，都是同一段采样按手势改变音高 / 滤波 / 音量
 *   - 环境嗡鸣是同一段采样的低速率循环，握拳时更闷、张开时更亮
 *   - 不加载任何其他音频文件，也不使用合成器伪造主音色
 *
 * 采样只在 unlock 时 fetch + decode 一次；每帧 update 不分配对象。
 */
import { CONFIG } from './config.js';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

const lerp = (a, b, t) => a + (b - a) * t;

function smoothOpen(tension) {
  const t = clamp01(tension);
  if (t <= CONFIG.thresholds.closed) return 0;
  if (t >= CONFIG.thresholds.open) return 1;
  const x = (t - CONFIG.thresholds.closed) / (CONFIG.thresholds.open - CONFIG.thresholds.closed);
  return x * x * (3 - 2 * x);
}

export class LightningAudio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.buffer = null;
    this.duration = 0;
    this.mainOffset = 0;
    this.humSource = null;
    this.humGain = null;
    this.humFilter = null;
    this.volume = CONFIG.audio.masterVolume;
    this.muted = false;
    this._ready = false;
    this._voices = 0;
    this._loadPromise = null;
    this._inactiveTime = 0;
    this._lastActive = false;
    this.lastPower = 0;
  }

  get ready() {
    return Boolean(this._ready && this.ctx && this.ctx.state === 'running' && this.buffer);
  }

  /** 必须在用户手势里调用；会创建 AudioContext 并加载采样。 */
  async unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      try {
        this.ctx = new AC();
      } catch (err) {
        console.warn('[audio] AudioContext 创建失败', err);
        return false;
      }
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : this.volume;
      this.master.connect(this.ctx.destination);
    }

    if (this.ctx.state !== 'running') {
      try {
        await this.ctx.resume();
      } catch (err) {
        console.warn('[audio] resume 失败', err);
        return false;
      }
    }

    if (!this.buffer) {
      try {
        await this._load();
      } catch (err) {
        console.warn('[audio] 电流采样加载失败', err);
        return false;
      }
    }

    // iOS Safari：一次极短的静音振荡，确保上下文真正解锁
    if (!this._ready) {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      gain.gain.value = 0.0001;
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      const now = this.ctx.currentTime;
      osc.start(now);
      osc.stop(now + 0.01);
      osc.onended = () => {
        try { osc.disconnect(); gain.disconnect(); } catch (e) { /* already gone */ }
      };
      this._buildHum();
    }

    this._ready = this.ctx.state === 'running' && Boolean(this.buffer);
    return this._ready;
  }

  async _load() {
    if (this._loadPromise) return this._loadPromise;
    this._loadPromise = (async () => {
      const url = new URL(CONFIG.audio.sampleUrl, document.baseURI).href;
      const res = await fetch(url, { cache: 'force-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.arrayBuffer();
      const buffer = await new Promise((resolve, reject) => {
        const p = this.ctx.decodeAudioData(data, resolve, reject);
        if (p && typeof p.then === 'function') p.then(resolve, reject);
      });
      this.buffer = buffer;
      this.duration = buffer.duration;
      this.mainOffset = this._findMainOffset();
    })();
    return this._loadPromise;
  }

  /** 找采样中最有能量的一段，避免从静音开头播放。 */
  _findMainOffset() {
    const data = this.buffer.getChannelData(0);
    const sr = this.buffer.sampleRate;
    const win = Math.max(256, Math.floor(sr * 0.18));
    const step = Math.max(1, Math.floor(sr * 0.05));
    let best = 0;
    let bestRms = -1;
    for (let start = 0; start + win <= data.length; start += step) {
      let sum = 0;
      for (let i = start; i < start + win; i += 4) sum += data[i] * data[i];
      if (sum > bestRms) {
        bestRms = sum;
        best = start;
      }
    }
    return Math.max(0, Math.min(this.duration * 0.35, best / sr - 0.02));
  }

  _buildHum() {
    if (!this.buffer || this.humSource) return;
    const ctx = this.ctx;
    this.humSource = ctx.createBufferSource();
    this.humSource.buffer = this.buffer;
    this.humSource.loop = true;
    this.humSource.playbackRate.value = CONFIG.audio.humRateClosed;

    this.humFilter = ctx.createBiquadFilter();
    this.humFilter.type = 'lowpass';
    this.humFilter.frequency.value = CONFIG.audio.humCutClosed;
    this.humFilter.Q.value = 2.2;

    this.humGain = ctx.createGain();
    this.humGain.gain.value = 0;

    this.humSource.connect(this.humFilter);
    this.humFilter.connect(this.humGain);
    this.humGain.connect(this.master);

    this.humSource.start(0, this.mainOffset);
  }

  setVolume(v) {
    this.volume = clamp01(Number(v) || 0);
    if (this.master && !this.muted) {
      this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.03);
    }
  }

  setMuted(muted) {
    this.muted = Boolean(muted);
    if (!this.master) return;
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(this.muted ? 0 : this.volume, now);
  }

  /**
   * 从采样中播放一段。offset / sliceDuration 使用采样自身的时间单位。
   * rate 控制音高，cutoff 控制明暗；两者都由手势 drive。
   */
  _slice(now, offset, sliceDuration, amp, rate, cutoff) {
    if (!this.buffer || this._voices >= 14) return false;
    const ctx = this.ctx;
    const safeOffset = Math.max(0, Math.min(this.duration - 0.03, offset));
    const available = this.duration - safeOffset;
    const sourceDuration = Math.min(sliceDuration, available);
    if (sourceDuration <= 0.01) return false;

    const src = ctx.createBufferSource();
    src.buffer = this.buffer;
    src.playbackRate.value = rate;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = cutoff;
    filter.Q.value = 0.85;

    const gain = ctx.createGain();
    gain.gain.value = 0.0001;

    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);

    const wall = sourceDuration / rate;
    const peak = Math.max(0.0002, amp);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(peak, now + 0.006);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak * 0.36), now + wall * 0.42);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + wall);

    this._voices++;
    src.start(now, safeOffset, sourceDuration);
    src.stop(now + wall + 0.02);
    src.onended = () => {
      this._voices = Math.max(0, this._voices - 1);
      [src, filter, gain].forEach((node) => {
        try { node.disconnect(); } catch (e) { /* already gone */ }
      });
    };
    return true;
  }

  /**
   * 强闪音：主放电 + 低频冲击 + 三连击后两拍，全部来自同一采样。
   * power 控制响度，spread 控制音高和滤波器（握拳更闷、张开更亮）。
   */
  playStroke({ power = 1, spread = 0, tension = 0 } = {}) {
    if (!this.ready || this.muted) return false;
    const p = clamp01(power);
    if (p <= 0.3) return false;

    const s = clamp01(spread);
    const open = smoothOpen(tension || s);
    const rate = lerp(CONFIG.audio.strokeRateClosed, CONFIG.audio.strokeRateOpen, s);
    const cutoff = lerp(CONFIG.audio.strokeCutClosed, CONFIG.audio.strokeCutOpen, s);
    const base = this.mainOffset;
    const gain = CONFIG.audio.crackGain * (0.45 + 0.55 * p) * (0.88 + 0.12 * open);
    this.lastStroke = { power: p, spread: s, rate, cutoff, gain, tension: clamp01(tension) };

    // 主放电：从采样中能量最高的位置开始
    this._slice(this.ctx.currentTime, base, CONFIG.audio.strokeDuration, gain, rate, cutoff);
    // 低频身体感：同一采样降速 + 低通，代替原来的正弦 thump
    this._slice(this.ctx.currentTime, base + 0.02, 0.26, gain * (0.38 + 0.2 * (1 - s)), rate * 0.56, 180);
    // 三连击后两拍，时间取视觉强闪的 offsets
    this._slice(
      this.ctx.currentTime + CONFIG.lightning.flashOnsets[1],
      base + 0.1,
      0.18,
      gain * 0.36,
      rate * 1.05,
      Math.min(4800, cutoff * 1.18),
    );
    this._slice(
      this.ctx.currentTime + CONFIG.lightning.flashOnsets[2],
      base + 0.2,
      0.16,
      gain * 0.24,
      rate * 1.1,
      Math.min(5200, cutoff * 1.28),
    );
    return true;
  }

  update(dt, { tension = 0, spread = 0, power = 0, active = false } = {}) {
    this.lastPower = power;
    if (!this.ready) return;

    const open = smoothOpen(tension || spread);
    const hasSignal = Boolean(active) && !this.muted;

    const targetGain = hasSignal
      ? lerp(CONFIG.audio.humGainClosed, CONFIG.audio.humGainOpen, open)
      : 0;
    const targetCut = hasSignal
      ? lerp(CONFIG.audio.humCutClosed, CONFIG.audio.humCutOpen, open)
      : CONFIG.audio.humCutClosed;
    const targetRate = hasSignal
      ? lerp(CONFIG.audio.humRateClosed, CONFIG.audio.humRateOpen, open)
      : CONFIG.audio.humRateClosed;

    const now = this.ctx.currentTime;
    this.humGain.gain.setTargetAtTime(targetGain, now, 0.15);
    this.humFilter.frequency.setTargetAtTime(targetCut, now, 0.15);
    this.humSource.playbackRate.setTargetAtTime(targetRate, now, 0.2);

    if (!hasSignal) {
      this._inactiveTime += dt;
      if (this._inactiveTime > 0.8) {
        // 截止到精确 0，避免长时间停在可闻的极小底噪
        this.humGain.gain.cancelScheduledValues(now);
        this.humGain.gain.setValueAtTime(0, now);
      }
    } else {
      this._inactiveTime = 0;
    }

    this._lastActive = hasSignal;
  }

  dispose() {
    if (!this.ctx) return;
    try {
      if (this.humSource) {
        this.humSource.stop();
        this.humSource.disconnect();
      }
      this.ctx.close();
    } catch (e) { /* already closed */ }
    this.ctx = null;
    this.buffer = null;
    this.humSource = null;
    this._ready = false;
  }
}

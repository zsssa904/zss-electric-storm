/**
 * 三连击强闪控制器
 * ---------------------------------------------------------------------------
 * 一次放电由 3 个高斯脉冲叠加，产生“亮-暗-亮-暗-亮”的节奏：
 *   power(t) = Σ amp[i] * exp(-((t - onset[i])²) / (2σ²))
 *
 * 只做标量运算，不在帧内分配对象。时间用 elapsed 累计，脉冲相对本次放电
 * 起点计算，避免多次事件累加浮点误差。
 */
export class FlashController {
  constructor({ minGap = 0.4, maxGap = 1.5, offsets, amplitudes, sigma = 0.028 } = {}) {
    this.minGap = minGap;
    this.maxGap = maxGap;
    this.offsets = Float64Array.from(offsets || [0, 0.06, 0.13]);
    this.amplitudes = Float64Array.from(amplitudes || [1.0, 0.62, 0.38]);
    this.sigma = sigma;
    this.enabled = true;
    this.elapsed = 0;
    this.strokeAt = -1;
    this.nextAt = minGap + Math.random() * Math.max(0.001, maxGap - minGap);
    this._power = 0;
    this._isStroking = false;
    this.onStroke = null;
  }

  get power() {
    return this._power;
  }

  get isStroking() {
    return this._isStroking;
  }

  trigger() {
    this.strokeAt = this.elapsed;
    this._power = 1;
    this._isStroking = true;
    // 手动 flash() 不应立刻又被自然节拍触发一次
    this.nextAt = this.elapsed + this.minGap
      + Math.random() * Math.max(0.001, this.maxGap - this.minGap);
    if (this.onStroke) this.onStroke(1);
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    if (!this.enabled) {
      this._power = 0;
      this._isStroking = false;
    } else {
      this.nextAt = this.elapsed + this.minGap
        + Math.random() * Math.max(0.001, this.maxGap - this.minGap);
    }
  }

  update(dt) {
    if (!this.enabled) {
      this._power = 0;
      this._isStroking = false;
      return 0;
    }

    this.elapsed += dt;
    if (this.elapsed >= this.nextAt) {
      this.trigger();
      this.nextAt = this.elapsed + this.minGap
        + Math.random() * Math.max(0.001, this.maxGap - this.minGap);
    }

    if (this.strokeAt < 0) {
      this._power = 0;
      this._isStroking = false;
      return 0;
    }

    const t = this.elapsed - this.strokeAt;
    const last = this.offsets[this.offsets.length - 1];
    const tail = last + this.sigma * 5;
    if (t > tail) {
      this._power = 0;
      this._isStroking = false;
      return 0;
    }

    let sum = 0;
    const inv = 1 / (2 * this.sigma * this.sigma);
    for (let i = 0; i < this.offsets.length; i++) {
      const d = t - this.offsets[i];
      sum += this.amplitudes[i] * Math.exp(-(d * d) * inv);
    }

    this._power = sum > 1 ? 1 : sum < 0 ? 0 : sum;
    this._isStroking = true;
    return this._power;
  }
}

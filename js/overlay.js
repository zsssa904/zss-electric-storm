/**
 * 2D 手部骨架叠加层
 * 摄像头画面用 CSS object-fit: cover + scaleX(-1) 显示，
 * 这里用完全相同的映射，把手部关键点画在正确的位置上。
 */

export const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

const PALM = [0, 5, 9, 13, 17];
const TIPS = [4, 8, 12, 16, 20];

/** 计算 object-fit: cover 的绘制区域（与 CSS 中的 video 样式保持一致） */
export function getVideoCover(video, width, height) {
  const vw = video?.videoWidth || width;
  const vh = video?.videoHeight || height;
  const scale = Math.max(width / vw, height / vh);
  const dw = vw * scale;
  const dh = vh * scale;
  return {
    ox: (width - dw) / 2,
    oy: (height - dh) / 2,
    dw,
    dh,
    scale,
  };
}

export class HandOverlay {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.width = 1;
    this.height = 1;
    this.dpr = 1;
    this.points = null;
    this.enabled = true;
  }

  resize(width, height, dpr) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.dpr = dpr;
    this.canvas.width = Math.round(this.width * dpr);
    this.canvas.height = Math.round(this.height * dpr);
    this.points = null;
  }

  clear() {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  draw({ hand, video, tension = 0, time = 0, dt = 1 / 60 }) {
    const ctx = this.ctx;
    if (!this.enabled || !hand?.present || !hand.landmarks?.length) {
      if (this.points) {
        this.points = null;
        this.clear();
      }
      return;
    }

    const w = this.width;
    const h = this.height;
    const cover = getVideoCover(video, w, h);

    const target = hand.landmarks.map((p) => ({
      x: cover.ox + (1 - p.x) * cover.dw,
      y: cover.oy + p.y * cover.dh,
    }));

    if (!this.points || this.points.length !== target.length) {
      this.points = target;
    } else {
      const k = 1 - Math.pow(0.6, dt * 60);
      for (let i = 0; i < target.length; i++) {
        this.points[i].x += (target[i].x - this.points[i].x) * k;
        this.points[i].y += (target[i].y - this.points[i].y) * k;
      }
    }
    const pts = this.points;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // 掌心淡淡的一层填充
    ctx.beginPath();
    PALM.forEach((index, i) => {
      const p = pts[index];
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    });
    ctx.closePath();
    ctx.fillStyle = 'rgba(70, 190, 255, 0.06)';
    ctx.fill();

    const strokeAll = () => {
      ctx.beginPath();
      for (const [a, b] of HAND_CONNECTIONS) {
        ctx.moveTo(pts[a].x, pts[a].y);
        ctx.lineTo(pts[b].x, pts[b].y);
      }
      ctx.stroke();
    };

    ctx.strokeStyle = 'rgba(70, 190, 255, 0.12)';
    ctx.lineWidth = 9;
    strokeAll();

    ctx.strokeStyle = 'rgba(126, 244, 255, 0.30)';
    ctx.lineWidth = 3.4;
    strokeAll();

    ctx.strokeStyle = 'rgba(226, 253, 255, 0.78)';
    ctx.lineWidth = 1.2;
    strokeAll();

    // 关节光点
    ctx.shadowColor = 'rgba(126, 244, 255, 0.9)';
    ctx.shadowBlur = 9;
    ctx.fillStyle = 'rgba(206, 250, 255, 0.94)';
    for (const p of pts) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.1, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.shadowBlur = 0;

    // 指尖高亮
    for (let i = 0; i < TIPS.length; i++) {
      const p = pts[TIPS[i]];
      const isIndex = i === 1;
      const radius = isIndex ? 4.2 : 3.2;

      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, isIndex ? 26 : 18);
      g.addColorStop(0, 'rgba(240, 255, 255, 0.6)');
      g.addColorStop(0.35, 'rgba(120, 225, 255, 0.24)');
      g.addColorStop(1, 'rgba(80, 160, 255, 0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(p.x, p.y, isIndex ? 26 : 18, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius * 0.55, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = 'rgba(160, 245, 255, 0.8)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius + 2.5, 0, Math.PI * 2);
      ctx.stroke();
    }

    // 食指指尖的张力进度环：直观看到 0 → 1
    const tip = pts[8];
    const ringR = 24;
    const hue = 202 - 42 * Math.min(1, Math.max(0, tension));
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
    ctx.beginPath();
    ctx.arc(tip.x, tip.y, ringR, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = `hsla(${hue}, 100%, 76%, 0.92)`;
    ctx.shadowColor = `hsla(${hue}, 100%, 70%, 0.8)`;
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.arc(tip.x, tip.y, ringR, -Math.PI / 2, -Math.PI / 2 + tension * Math.PI * 2);
    ctx.stroke();
    ctx.shadowBlur = 0;

    // 呼吸小点，让叠层不那么死板
    const pulse = 0.5 + 0.5 * Math.sin(time * 2.2);
    ctx.fillStyle = `rgba(210, 252, 255, ${0.25 + 0.35 * pulse})`;
    ctx.beginPath();
    ctx.arc(tip.x + Math.cos(time) * 3, tip.y - 28 - pulse * 3, 1.6, 0, Math.PI * 2);
    ctx.fill();

    ctx.globalCompositeOperation = 'source-over';
  }
}

你是 WebGL 实时特效工程师。项目「指尖雷花 · Electric Storm」，当前工作目录就是项目根目录。
技术栈：Three.js r160 + MediaPipe Hands + 原生 ES Module，无构建流程。

我已核对过当前代码，先给你事实基线（不要偏离）：
- 粒子在一个 THREE.ShaderMaterial 里，uniforms：uTime / uSpread / uPixelRatio / uResolution /
  uPointer / uPointerStrength / uSurge（js/flower.js:686-702）
- 顶点着色器 pos = mix(aBud, aOpen, local) 在 js/flower.js:157，
  vColor 赋值在 js/flower.js:206，aDelay 错峰在附近逻辑里
- 几何 attribute 在 js/flower.js:672-683，数组声明在 459-469
- Flower.update(dt, time, spread, tension) 在 js/flower.js:1241，负责写 uniforms
- main.js:531 调 flower.update；main.js:552 调 fingerFx.draw
- fingerlightning.js 的 _fade() 已经用了 destination-out 做余辉，别和它冲突
- config.js 已有 lightning 段（38-60 行），含 flashMin / flashMax

不要重写已有功能（分形电弧、8-15Hz 节拍、三层发光、余辉、bloom、强闪都不动）。
只做下面四项，按顺序完成，每项做完自己验证。

═══════════════════════════════════════
【1】虚拟照亮 —— 让粒子互相照亮，而不是各自发光
═══════════════════════════════════════
问题：现在全是 AdditiveBlending，粒子之间没有光照关系，像一堆亮点不像一团发光的云。

做法：
a) 在 flower.js 粒子 ShaderMaterial 的 uniforms 里新增：
     uFlashPos:   { value: new THREE.Vector3(0, 0, 0) }
     uFlashPower: { value: 0 }

b) 顶点着色器声明：
     uniform vec3  uFlashPos;
     uniform float uFlashPower;

c) 在 vColor 赋值（第 206 行 vColor = mix(...) 之后）追加：
     vec3 toLight = uFlashPos - pos;
     float dL     = length(toLight);
     vec3 dirL    = toLight / max(dL, 0.001);
     vec3 nrm     = normalize(pos);          // 没有法线，用位置当球面法线
     float ndotl  = max(dot(nrm, dirL), 0.0);
     float fall2  = 1.0 / (1.0 + dL * dL * 0.35);
     vColor += vec3(0.55, 0.85, 1.0) * (ndotl * fall2 * uFlashPower * 1.6);

d) JS 侧在 Flower.update() 里每帧写入：
     this.uniforms.uFlashPos.value.copy(this.group.position);   // 雷球中心世界坐标
     this.uniforms.uFlashPower.value = this.flashPower || 0;
   并加一个方法 setFlashPower(v) { this.flashPower = v; }，由 main.js 每帧调用。

硬性要求：
- 不新增 draw call，不新建材质。
- 不许改动 aOpen / aBud 插值逻辑。
- 若在 ACESFilmic 下过曝，降低 1.6 这个系数，绝不允许改 toneMappingExposure。
- 验证：?debug=1&spread=0.7 下看花瓣内侧应被照亮；再把 uFlashPower 设 0，
  画面必须与改前逐像素一致。

═══════════════════════════════════════
【2】闪光控制器（新建 js/flash.js）—— 三连击节奏
═══════════════════════════════════════
新建 js/flash.js：

  export class FlashController {
    constructor({ minGap, maxGap, offsets, amplitudes, sigma } = {})
    update(dt)          // 推进时间，返回当前 power
    get power()         // 0~1 瞬时强度
    get isStroking()    // 是否处于一次放电内
    trigger()           // 立即触发一次
    setEnabled(bool)
    onStroke = null     // 触发时回调
  }

行为：
- 每隔 minGap~maxGap 秒随机触发一次。
- 一次放电 = 3 个高斯脉冲叠加：
    offsets    = [0, 0.06, 0.13]  秒
    amplitudes = [1.0, 0.62, 0.38]
    sigma      = 0.028 秒
  power(t) = Σ amplitudes[i] * exp(-((t - offsets[i])^2) / (2 * sigma^2))，clamp 到 [0,1]
- 用 elapsed 绝对时间累计，不要用累加浮点误差。
- 不分配对象，不用数组 push，每帧只做标量运算。

参数放到 config.js 的 lightning 段：
  flashOnsets: [0, 0.06, 0.13],
  flashAmps:   [1.0, 0.62, 0.38],
  flashSigma:  0.028,
  shakeAmp:    0.004,

接入 main.js：
- 实例化 flash，每帧 flash.update(dt)。
- flower.setFlashPower(flash.power)（第 1 项用）。
- 相机震动：
    const baseY = 0;  // camera.position 基准
    const s = flash.power * CONFIG.lightning.shakeAmp;
    camera.position.x = (Math.random() - 0.5) * s;
    camera.position.y = (Math.random() - 0.5) * s;
    每帧从基准重算，绝不累加。
- 曝光：
    renderer.toneMappingExposure = flash.power > 0.05
      ? 1.0 + flash.power * 0.35
      : 1.0;
    注意：当前代码里 exposure 初始是 0.98（main.js:115），若要保持原观感，
    用 renderer.toneMappingExposure = BASE_EXPOSURE * (power > 0.05 ? 1 + power*0.35 : 1)，
    BASE_EXPOSURE 定义为 0.98 常量。power 回落超过 0.05 后必须当帧立刻回到基线。

硬性要求：
- 正常状态下 exposure 必须严格等于基线（0.98），不许常驻偏高，否则整屏发灰。
- 不用 DOM 叠层做强闪（现有 flashOverlay 保留给指尖层，别动）。

═══════════════════════════════════════
【3】粒子初速度过冲 —— 爆发要"炸"出去，不是"溶"开
═══════════════════════════════════════
现状：mix(aBud, aOpen, local) 是纯线性插值，看着像溶解。

做法：
a) 在几何构建处（flower.js:459-469 附近）新增：
     const vel = new Float32Array(total * 3);
   全部粒子填完后（第 683 行 setAttribute 那批之后）计算：
     每个粒子 i：
       爆发方向 = normalize(aOpen_i - aBudCenter)，aBudCenter 取 (0, 0.1, 0)
       或者更稳：dir = normalize(open - bud)，若长度为 0 则用随机单位向量
       vel[i*3..] = dir * (0.8 + rand * 0.8)
   然后：
     geometry.setAttribute('aVelocity', new THREE.BufferAttribute(vel, 3));

b) 顶点着色器声明 attribute vec3 aVelocity;

c) 在 pos 计算之后（第 157 行 pos = mix(...) 之后）追加：
     float e = clamp(uSpread, 0.0, 1.0);
     float overshoot = 4.0 * e * (1.0 - e);              // 0→1→0
     float rebound   = smoothstep(0.72, 1.0, e) - 1.0;   // 尾部回弹
     pos += aVelocity * (overshoot * 1.35 + rebound * 0.45);
     // 收拢时的挤压感
     float squeeze = 4.0 * (1.0 - e) * e;
     pos *= 1.0 - squeeze * 0.06;

硬性要求：
- e=0 和 e=1 时 overshoot / rebound / squeeze 必须精确为 0，几何完全回到原位。
- 用 ?spread=0 与 ?spread=1 分别截图，与改前逐像素比对，必须一致。
- 不许破坏 aDelay 错峰引爆的顺序。
- 位移幅度若让花瓣飞出画面，调小 1.35 这个系数。

═══════════════════════════════════════
【4】手部遮挡电弧 —— 现在电弧永远浮在最上层
═══════════════════════════════════════
问题：指尖电弧在独立 2D Canvas，手挡在雷球前时没有遮挡层次。

在 fingerlightning.js 里加一个方法，在 draw() 末尾、_drawGlows 之后调用：

  _maskByPalm(pts) {
    const ctx = this.ctx;
    const ids = [0, 1, 5, 9, 13, 17];
    const cx = ..., cy = ...;                 // 手掌质心
    const r  = 手掌尺度（用 |pts[0]-pts[9]| 与 |pts[5]-pts[17]| 的平均）
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.globalAlpha = 0.35;                   // 关键：不要擦干净
    ctx.beginPath();
    ctx.arc(cx, cy, r * 1.05, 0, Math.PI * 2);
    ctx.fillStyle = '#000';
    ctx.fill();
    ctx.restore();
  }

调用条件：hasHand === true 才执行；无手 / 关摄像头时完全不调用。

硬性要求：
- 只擦不画，绝对不能出现手部轮廓。
- 强度 0.35，若视觉上手被"挖洞"太明显，降到 0.25。
- 不能和 _fade() 的 destination-out 余辉互相干扰（都是用独立 save/restore）。


═══════════════════════════════════════
【5】音效系统（新建 js/audio.js）—— 全部程序化合成，不加载任何音频文件
═══════════════════════════════════════
约束：项目里现在没有任何音频资源，也不允许新增 mp3/wav 文件下载。
所有声音必须用 Web Audio API 实时合成（OscillatorNode / AudioBufferSourceNode + 噪声）。
不引入 Tone.js 等第三方库（会破坏"无构建、零依赖"的现状）。

新建 js/audio.js，导出：

  export class LightningAudio {
    constructor()
    async unlock()            // 首次用户手势时调用，创建/resume AudioContext
    get ready()               // 是否已解锁
    setVolume(v)              // 0~1 总音量
    setMuted(bool)
    playStroke({ power, spread })   // 强闪音：每次 FlashController 触发调用一次
    update(dt, { tension, spread, power, active })  // 每帧调用，维持环境音
    dispose()
  }

--- 音色设计（4 层）---

1) 主爆裂 crack（playStroke，power>0.3 时）
   - 白噪声缓冲 0.25s，包络：attack 1ms → decay 到 0.2 在 60ms → 拖尾到 250ms
   - 经 BiquadFilter type='highpass' freq 1800Hz，Q=0.7
   - 再并联一路 bandpass 4200Hz，Q=1.1，音量 0.4，制造"撕裂"感
   - 音量 = 0.55 * power

2) 低频冲击 thump（playStroke）
   - Oscillator type='sine'，频率 90Hz → 42Hz 用 exponentialRampToValueAtTime 在 0.18s 内下滑
   - 包络：attack 2ms，decay 180ms
   - 音量 = 0.45 * power
   - 目的：给"雷击"重量感，没有它听起来就像电流噪声

3) 次级劈啪 crackle（playStroke 的 offsets[1] 和 offsets[2] 各触发一次）
   - 短噪声 0.06s，bandpass 2800Hz，音量为主爆裂的 0.35 和 0.2
   - 这正是"三连击"听觉上的体现

4) 环境嗡鸣 hum（update 持续）
   - 两个 Oscillator：sawtooth 55Hz + sawtooth 82.5Hz（纯五度），
     经 lowpass 220Hz Q=3，音量常驻 0.06
   - 音量和滤波截止频率随 tension 变化：
       closed（握拳，tension 低）：cutoff 180Hz，音量 0.10 —— 压抑的蓄能感
       open（张开）：cutoff 900Hz，音量 0.05 —— 变亮变薄
     用 setTargetAtTime 平滑，时间常数 0.15s，不要用 linearRamp 造成阶梯感
   - 这是让"握拳时真的有压迫感"的关键

--- 实时性与性能要求 ---
- 噪声缓冲区在构造时预生成一次（1s 白噪声 AudioBuffer），不要每次 new。
- 每个 playStroke 只创建临时节点，播放结束用 node.onended 断开，不留悬挂节点。
- 同时存在的最大节点数 < 16；超出则跳过新的 crackle，不排队。
- AudioContext 只创建一次，sampleRate 用默认值，不要指定 48000 强制重采样。
- 每帧 update 内不做任何 new；复用已创建的节点引用。

--- 自动播放策略（很重要，否则会被浏览器静音）---
- AudioContext 必须在**用户手势内**创建或 resume。
  接入点：index.html 的 #btnStart 和 #btnDemo 的 click 里调用 audio.unlock()。
- 若用户直接带 ?cam=1 进入而没点按钮，则在第一次 touchstart/pointerdown 时 unlock。
- unlock() 里做一次 0.001 音量的静音 osc 起停在同帧完成，确保 iOS Safari 解锁。

--- UI 接入 ---
- index.html 的 .tools 区域（#btnInfo 之后）新增一个按钮：
    <button id="btnAudio" class="tool" type="button" aria-pressed="true" title="音效开关（M）">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/></svg>
      <span class="tool-label">音效</span>
    </button>
- main.js 里绑定：点击切换 muted，aria-pressed 同步；
  键盘 M 键同样切换（参考现有 C/B/H/I 的按键处理写法）。
- 默认 muted = false，但音量起始 0.7，避免第一声过响。
- 按钮关闭态加 .is-off 样式（styles.css 里补，沿用现有 .tool 的视觉语言）。

--- 参数放 config.js 新增段 ---
  audio: {
    masterVolume: 0.7,
    crackGain: 0.55,
    thumpGain: 0.45,
    humGainClosed: 0.10,
    humGainOpen: 0.05,
    humCutClosed: 180,
    humCutOpen: 900,
  },

--- 触发点（在 main.js 里接）---
- flash.onStroke = (power) => audio.playStroke({ power, spread: state.spread });
  只在 power > 0.3 时真正发声（低强度闪不响，避免噪声疲劳）。
- 每帧在 update() 末尾调用：
  audio.update(dt, { tension: state.tension, spread: state.spread,
                     power: flash.power, active: state.cameraOn || state.mode === 'demo' });
- 关闭摄像头 / 停演示时，hum 用 setTargetAtTime 淡出到 0，不要直接 disconnect。

硬性要求：
- 不新增任何二进制音频文件。
- 不引入第三方音频库。
- 静止时不能有可闻底噪（gain 精确到 0，不是 0.001）。
- 同屏 60fps 下，音频调度总开销 < 1.5ms/帧。
- 无摄像头演示模式下也要有环境嗡鸣（跟随 demoTension 变化）。

═══════════════════════════════════════
【工程约束】
═══════════════════════════════════════
- 所有新参数进 config.js，并在 README 的配置表补一行。
- 不引入构建工具、不引入 EffectComposer 全套后处理。
- 不用 ctx.shadowBlur。
- 不靠拉高 exposure 变亮。
- 帧内不 new 数组 / Path / Object；复用已有缓冲区。
- MediaPipe 仍走本地 vendor/hands/。
- 帧率不得比改前低 5fps 以上（用 ?debug=1 对比）。

═══════════════════════════════════════
【交付时请报告】
═══════════════════════════════════════
1. 改了哪些文件、每处改动的行号。
2. 每项的帧率开销（改前 vs 改后）。
3. 音频调度每帧耗时（performance.now 采样平均值）。
4. 以下自检逐条结论：
   [ ] 强闪时花瓣内侧被照亮，不只是自己变亮
   [ ] 闪光呈三连击节奏（亮-暗-亮-暗-亮）
   [ ] 基线状态 exposure 严格 0.98，画面不发灰
   [ ] 张开时粒子炸出去并回弹，不是平滑溶开
   [ ] ?spread=0 / ?spread=1 与改前逐像素一致
   [ ] 手在雷球前时电弧被弱化
   [ ] 帧率不低于改前 5fps
   [ ] 关摄像头能正常回演示模式，无报错
   [ ] 点击「开启摄像头」或「先看演示」后能听到声音（未被浏览器静音）
   [ ] 强闪时有"爆裂 + 低频冲击"两层，三连击在听觉上可辨
   [ ] 握拳时嗡鸣变低变闷，张开时变亮变薄
   [ ] 静止无手时无可闻底噪
   [ ] 音效按钮 / M 键能正常静音，aria-pressed 同步
   [ ] 未新增任何 mp3/wav 等音频文件
5. 任何未达成项，说明原因和备选方案。

───────────────────────────────────────
补充：给 【4】手部遮挡 的修正说明
───────────────────────────────────────
注意 fingerlightning.js 的 _fade() 已经在用 destination-out 做余辉，
所以你新加的 _maskByPalm() 必须保证：
- 不与 _fade() 在同一处修改 globalAlpha；
- 用完必须 ctx.save()/restore() 包裹，或显式把 globalAlpha 还原成 1；
- 顺序：先 _fade(dt) → 再画电弧 → 再 _drawGlows → 最后 _maskByPalm。
若发现余辉被手掌"吃掉"，说明顺序错了，把 _maskByPalm 移到 _fade 之前。

你是一名专门做 WebGL 实时特效的前端工程师。当前项目「指尖雷花 · Electric Storm」：
Three.js r160 + MediaPipe Hands，通过摄像头识别手部 21 个关键点，用手掌张开度驱动雷电特效。
原生 ES Module，无构建流程。项目根目录为当前工作目录。

【本轮目标】提升「真实感与空间感」。已完成的部分（分形电弧、8-15Hz 放电节拍、三层发光、
余辉、bloom、强闪）保持不变，不要重写。本轮只做下面四件事，按顺序做完。

================================================================
【第 1 项 · 虚拟照亮（最高优先级）】
================================================================
现状问题：所有粒子都是 AdditiveBlending + 径向衰减，各自发光互不相干，
看起来像"一堆亮点"而不是"一团发光的云"。缺少光照一致性。

在 js/flower.js 的粒子 ShaderMaterial 中新增两个 uniform：
  uniform vec3  uFlashPos;     // 雷球中心的世界坐标
  uniform float uFlashPower;   // 0~1，来自闪光控制器

在顶点着色器中，算完 pos 与 vColor 之后追加：
  vec3 toLight = uFlashPos - pos;
  float d      = length(toLight);
  vec3 dir     = toLight / max(d, 0.001);
  vec3 normal  = normalize(pos);            // 用位置充当球面法线
  float ndotl  = max(dot(normal, dir), 0.0);
  float falloff = 1.0 / (1.0 + d * d * 0.35);
  float lit    = ndotl * falloff * uFlashPower;
  vColor += vec3(0.55, 0.85, 1.0) * lit * 1.6;

JS 侧每帧更新：uFlashPos = 雷球中心世界坐标，uFlashPower = flash.power。

硬性要求：
- 不新增任何 draw call。
- 不破坏现有 aOpen / aBud 插值逻辑。
- 必须在 ACESFilmic tone mapping 下检查不会过曝成一片死白；
  若过曝，降低 1.6 这个系数，而不是降低 exposure。
- 用 ?debug=1 和 ?spread=0.7 验证；再令 uFlashPower=0 确认画面与改前一致。

================================================================
【第 2 项 · 三连闪控制器（新建 js/flash.js）】
================================================================
新建 js/flash.js，实现独立的高压放电闪光控制器。

导出：
  export class FlashController {
    constructor({ minGap = 0.4, maxGap = 1.5 } = {})
    update(dt)          // 每帧调用
    get power()         // 0~1 当前瞬时强度
    get isStroking()    // 是否处于一次放电中
    trigger()           // 手动触发一次放电
    setEnabled(bool)
  }

行为定义：
- 每隔 minGap~maxGap 秒随机触发一次放电。
- 一次放电 = 3 个高斯脉冲叠加：
    时间偏移 [0, 0.06, 0.13] 秒
    幅度     [1.0, 0.62, 0.38]
    脉宽 sigma = 0.028 秒
  power = Σ amplitude_i * exp(-(t - offset_i)^2 / (2*sigma^2))，最后 clamp 到 [0,1]。
- 触发瞬间回调 onStroke（若赋值），供相机震动等使用。

接入 js/main.js：
  1. 实例化 flash，每帧 flash.update(dt)。
  2. flash.power 传给 flower 的 uSurge 与新增的 uFlashPower。
  3. 相机 handheld shake：
     shakeAmp = flash.power * 0.004；
     camera.position 在基础位置偏移 (rand-0.5)*shakeAmp（x/y 各一次）；
     每帧重新计算，不要累加，避免漂移。
  4. toneMappingExposure：
     仅当 flash.power > 0.05 时 = 1.0 + flash.power * 0.35；
     必须在 power 回落后 6 帧内严格回到 1.0。

硬性要求：
- 正常状态下 renderer.toneMappingExposure 必须严格等于 1.0，绝不能常驻偏高，
  否则整个画面会发灰——这是最容易犯的错。
- 闪光不能干扰 HUD 与摄像头视频层的亮度。
- 把参数放进 js/config.js 的 lightning 段：
  flashMin / flashMax / flashOffsets / flashAmplitudes / flashSigma。

================================================================
【第 3 项 · 粒子初速度过冲（让爆发"炸"出去而不是"溶"开）】
================================================================
现状问题：aOpen 与 aBud 两套坐标线性插值，运动像"溶解"，不像"喷发"。
真实火花有惯性：爆发瞬间冲过头，然后回弹。

修改 js/flower.js 的粒子几何生成：
- 新增 attribute vec3 aVelocity，为每颗粒子预计算爆发方向上的初速度，
  方向 = normalize(aOpen - aBudCenter)，大小按粒子层级随机 0.8~1.6。
- 顶点着色器中，在 aOpen/aBud 插值之后追加：

    float e = clamp(uSpread, 0.0, 1.0);
    float overshoot = 4.0 * e * (1.0 - e);            // 0→1→0 的鼓包
    float rebound   = smoothstep(0.72, 1.0, e) - 1.0; // 尾部回弹
    pos += aVelocity * (overshoot * 1.35 + rebound * 0.45);

- 握拳方向的反向过冲（收拢时的挤压感）：
    float squeeze = 4.0 * (1.0 - e) * e;
    pos *= 1.0 - squeeze * 0.06;

硬性要求：
- 只有在 0.2 < uSpread < 0.9 区间内才明显，两端必须完全收敛到原位。
- 用 ?spread=0 和 ?spread=1 验证，几何必须与改前完全一致。
- 不能影响 aDelay 错峰引爆的顺序感。

================================================================
【第 4 项 · 手部遮挡电弧（修复"电弧永远浮在最上层"）】
================================================================
现状问题：指尖电弧画在独立 2D Canvas 上，永远在最上层，手挡在雷球前面时也没有遮挡关系。

在 js/fingerlightning.js 中实现低成本方案：
1. 从 hand.landmarks 计算手掌多边形（0、5、9、13、17 加指尖构成外轮廓）。
2. 每帧在电弧绘制完成之后，用同一个 2D 上下文、globalCompositeOperation='destination-out'，
   在手掌多边形内以 0.35 的透明度擦除电弧层。
3. 手挡在前面时电弧自然弱化，产生层次感。

硬性要求：
- 不要把手部轮廓画出来（是擦除，不是描边）。
- 擦除强度 0.35 左右，不要擦干净，否则边缘会硬切。
- 关闭摄像头或无手时不执行任何擦除。

================================================================
【工程约束（必须遵守）】
================================================================
- 所有可调参数集中到 js/config.js，新增 flash 段，并在 README 配置表补上。
- 不引入需要构建的框架，仍是原生 ES Module。
- 不引入 EffectComposer 全套后处理；现有半分辨率 bloom 保留即可。
- 不要用 ctx.shadowBlur（整屏 2D Canvas 上极慢）。
- 不要靠拉高 toneMappingExposure 来"变亮"。
- 不要每帧 new 数组 / new Path / new Object；电弧点数组用对象池复用。
- MediaPipe 仍走本地 vendor/hands/，不上传任何画面。
- 目标 60fps / 1080p / 中端核显；改完帧率不得比改前低 5fps 以上。

================================================================
【验收清单（做完逐条自检并报告结果）】
================================================================
[ ] 强闪时花瓣边缘会被"照亮"，而不只是自己变亮。
[ ] 握手时能感觉到光从手上打出来，手有亮边。
[ ] 闪光呈三连击节奏，肉眼可辨"亮-暗-亮-暗-亮"。
[ ] 正常运行时画面不发灰（exposure 严格 1.0）。
[ ] 张开时粒子是"炸"出去并轻微回弹，不是平滑溶开。
[ ] ?spread=0 与 ?spread=1 的静态几何与改前一致。
[ ] 手放在雷球前面时，指尖电弧被手部区域弱化。
[ ] ?debug=1 下帧率不低于改前 5fps。
[ ] 关闭摄像头能正常回演示模式，无报错。

完成后请给出：改了哪些文件、每项的实际帧率开销、以及任何未达成的项及原因。

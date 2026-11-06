/**
 * 用 CDP 精确模拟视口并截图（仅用于本地视觉验证）
 * 用法：node tools/shot.mjs <url> <width> <height> <outfile> [waitMs] [mobile]
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const [, , url, widthArg, heightArg, outArg, waitArg = '6000', mobileArg = '0'] = process.argv;
const width = Number(widthArg) || 1440;
const height = Number(heightArg) || 900;
const waitMs = Number(waitArg) || 6000;
const mobile = mobileArg === '1';
const out = resolve(outArg || 'shots/cdp.png');
const port = 9300 + Math.floor(Math.random() * 500);
const profile = resolve(`shots/.cdp-${port}`);
mkdirSync(dirname(out), { recursive: true });

const edgeArgs = [
  '--headless=new',
  '--disable-extensions',
  '--no-first-run',
  '--no-default-browser-check',
  '--hide-scrollbars',
  '--autoplay-policy=no-user-gesture-required',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--mute-audio',
  `--use-angle=${process.env.SHOT_ANGLE || 'swiftshader'}`,
  ...(process.env.SHOT_ANGLE === 'd3d11' ? [] : ['--enable-unsafe-swiftshader']),
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
];
if (process.env.FAKE_CAM === '1') {
  edgeArgs.push('--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream');
}
if (process.env.FAKE_VIDEO) {
  edgeArgs.push(
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    `--use-file-for-fake-video-capture=${process.env.FAKE_VIDEO}`,
  );
}
edgeArgs.push('about:blank');
const edge = spawn(EDGE, edgeArgs, { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForTarget() {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page;
    } catch {}
    await sleep(200);
  }
  throw new Error('CDP target not found');
}

const target = await waitForTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});

let seq = 0;
const pending = new Map();
const errors = [];
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve: res, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else res(msg.result);
    return;
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    errors.push(msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text);
  }
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    errors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
  }
  if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
    errors.push(msg.params.entry.text);
  }
};

function send(method, params = {}) {
  const id = ++seq;
  return new Promise((res, rej) => {
    pending.set(id, { resolve: res, reject: rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width,
  height,
  deviceScaleFactor: 1,
  mobile,
  screenWidth: width,
  screenHeight: height,
});
if (mobile) {
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
}
await send('Page.navigate', { url });
await sleep(waitMs);

if (process.env.SHOT_EVAL) {
  const ev = await send('Runtime.evaluate', { expression: process.env.SHOT_EVAL, awaitPromise: true });
  if (ev.result?.value !== undefined) console.log('EVAL', ev.result.value);
  await sleep(Number(process.env.SHOT_EVAL_WAIT || 90));
}

const info = await send('Runtime.evaluate', {
  expression: `JSON.stringify({
    vw: innerWidth, vh: innerHeight, dpr: devicePixelRatio,
    body: document.body.className,
    status: document.querySelector('#statusText')?.textContent,
    particles: document.querySelector('#statParticles')?.textContent,
    scene: !!document.querySelector('#scene'),
    error: document.querySelector('#fatalText')?.textContent || '',
    mode: document.body.dataset.mode,
    camera: document.body.dataset.backdrop,
    bloom: window.BLOOM?.state || null,
    debug: document.querySelector('#debug')?.innerText || '',
    video: (() => {
      const v = document.querySelector('#camera');
      if (!v) return null;
      const s = getComputedStyle(v);
      return {
        readyState: v.readyState, currentTime: +v.currentTime.toFixed(2),
        paused: v.paused, w: v.videoWidth, h: v.videoHeight,
        opacity: s.opacity, display: s.display, visibility: s.visibility,
      };
    })(),
    tools: [...document.querySelectorAll('.tool')].map((b) => {
      const r = b.getBoundingClientRect();
      return { id: b.id, display: getComputedStyle(b).display, x: Math.round(r.x), w: Math.round(r.width) };
    }),
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth
  })`,
  returnByValue: true,
});
console.log('PAGE', info.result.value);
if (errors.length) {
  console.log('CONSOLE_ERRORS');
  for (const e of errors) console.log('-', e);
} else {
  console.log('CONSOLE_ERRORS none');
}

const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
writeFileSync(out, Buffer.from(shot.data, 'base64'));
console.log('SAVED', out);

ws.close();
edge.kill();
process.exit(0);

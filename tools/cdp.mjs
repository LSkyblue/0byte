/* 无头 Chrome 截图 / 操作小工具（Chrome 调试协议，不用装任何东西），测界面用。Chrome 的路径写的是 macOS 的，别的系统改下面的 CHROME。
   用法：SHOT_DIR=截图放哪 node tools/cdp.mjs 场景脚本.mjs（不写 SHOT_DIR 就放在当前目录的 shots/ 里）
   场景脚本长这样（例子见 tools/scene-example.mjs）：
     export default async p => { await p.mobileMode(); await p.goto(地址); await p.tap('#plusBtn'); await p.shot('a.png'); };
   p.mobileMode()：iPhone（390×844、触摸、iPhone UA）；p.desktopMode(w, h)：电脑窗口；p.size(w, h, 倍数, 透明底)：按真实像素截（做图标用）
   p.tap / p.click / p.swipe / p.js(代码) / p.setFiles(选择框, [文件]) / p.type(文字) / p.shot(文件名)。最后会打印页面上的报错。
   p.send(指令, 参数)：直接发 Chrome 调试协议指令（调慢 CPU、看性能都用它）。
   只对测试用的服务（另开一个端口、用一份测试数据）用，别拿去点你正在用的那个。 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const OUT = resolve(process.env.SHOT_DIR || 'shots');
mkdirSync(OUT, { recursive: true });
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const port = 9333 + Math.floor(Math.random() * 400);
const prof = mkdtempSync(join(tmpdir(), 'cdp-chrome-'));   // 一次性的浏览器资料，用完删掉
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, '--no-first-run', '--no-default-browser-check',
  '--window-size=1280,900', '--hide-scrollbars', '--force-color-profile=srgb', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let targets;
for (let i = 0; i < 60; i++) {
  try { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); if (targets.find(t => t.type === 'page')) break; } catch { /* 还没起来 */ }
  await sleep(250);
}
const page = targets.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));
let id = 0; const wait = new Map(); const logs = [];
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id && wait.has(m.id)) { const { ok, no } = wait.get(m.id); wait.delete(m.id); m.error ? no(new Error(m.error.message)) : ok(m.result); }
  if (m.method === 'Runtime.exceptionThrown') logs.push('页面报错：' + (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text));
  if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) logs.push('console.' + m.params.type + '：' + m.params.args.map(a => a.value ?? a.description).join(' '));
});
const send = (method, params = {}) => new Promise((ok, no) => { const i = ++id; wait.set(i, { ok, no }); ws.send(JSON.stringify({ id: i, method, params })); });
await send('Page.enable'); await send('Runtime.enable');

const p = {
  sleep,
  async mobileMode(w = 390, h = 844, dark = false) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: true });
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] });
  },
  async desktopMode(w = 1280, h = 860, dark = false) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: false });
    await send('Emulation.setTouchEmulationEnabled', { enabled: false });
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] });
  },
  async size(w, h, dpr = 1, transparent = false) {   // 按真实像素截图（做图标用）；transparent = 透明底
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: dpr, mobile: false });
    if (transparent) await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  },
  async goto(url, ms = 1800) { await send('Page.navigate', { url }); await sleep(ms); },
  async js(expr) {
    const r = await send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('js 出错：' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  },
  async box(sel) {
    const b = await p.js(`const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };`);
    if (!b) throw new Error('找不到 ' + sel);
    return b;
  },
  async tap(sel, ms = 500) {   // 真的触摸：按下、抬起（会触发 click）
    const { x, y } = await p.box(sel);
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(ms);
  },
  async click(sel, ms = 500) {
    const { x, y } = await p.box(sel);
    for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
    await sleep(ms);
  },
  async swipe(x0, y0, x1, y1, steps = 12, ms = 400) {
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0 }] });
    for (let i = 1; i <= steps; i++) { await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + (x1 - x0) * i / steps, y: y0 + (y1 - y0) * i / steps }] }); await sleep(16); }
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(ms);
  },
  async setFiles(sel, files) {   // 给 <input type=file> 塞文件（会触发 change）
    const { root } = await send('DOM.getDocument', { depth: 0 });
    const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: sel });
    await send('DOM.setFileInputFiles', { nodeId, files });
  },
  async type(text) { await send('Input.insertText', { text }); },
  async shot(name) {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT, name), Buffer.from(r.data, 'base64'));
    console.log('截图', name);
  },
  logs,
  send,   // 直接发调试协议指令，比如 p.send('Emulation.setCPUThrottlingRate', { rate: 4 })：CPU 慢 4 倍，像手机
};
try {
  const mod = await import(resolve(process.argv[2]));
  await mod.default(p);
} catch (e) { console.error('场景出错：', e.message); }
finally {
  if (logs.length) console.log(logs.join('\n')); else console.log('页面没有报错');
  ws.close(); chrome.kill('SIGTERM');
  setTimeout(() => { try { rmSync(prof, { recursive: true, force: true }); } catch { /* 删不掉就算了 */ } }, 500);
}

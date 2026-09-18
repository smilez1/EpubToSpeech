import { spawn } from 'node:child_process';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

/** 浏览器验证：设置面板出现"Piper 音色微调"两个滑杆；改动后合成请求携带新参数。 */
const browser = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find((p) => existsSync(p));
if (!browser) throw new Error('找不到 Microsoft Edge');
// 临时 profile 一律放项目内 .tmp/，不要落到项目外的盘符根目录
const profile = resolve(import.meta.dirname, '..', '.tmp', 'edge-noise');
const port = 9485;
const WEB = process.env.WEB_BASE ?? 'http://127.0.0.1:5173';
const API = process.env.API_BASE ?? 'http://127.0.0.1:8787';
rmSync(profile, { recursive: true, force: true });
mkdirSync(profile, { recursive: true });

const books = await (await fetch(`${API}/api/books`)).json();
const book = [...books.books].sort((a, b) => b.chapterCount - a.chapterCount)[0];
if (!book) throw new Error('书库为空');
const child = spawn(browser, ['--headless=new', '--disable-gpu', '--no-first-run', '--autoplay-policy=no-user-gesture-required', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  let targets;
  for (let i = 0; i < 40 && !targets; i += 1) { await sleep(250); targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()).catch(() => null); }
  if (!targets) throw new Error('CDP 未就绪');
  const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0; const pending = new Map();
  const synthBodies = [];
  ws.addEventListener('message', (event) => {
    const m = JSON.parse(event.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
    if (m.method === 'Network.requestWillBeSent' && /tts\/piper\/synthesize/.test(m.params.request?.url ?? '')) synthBodies.push(m.params.request?.postData ?? '');
  });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); return r?.result?.value ?? (r?.exceptionDetails ? 'ERR:' + r.exceptionDetails.text : undefined); };
  await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');

  await send('Page.navigate', { url: `${WEB}/#/read/${book.id}?engine=piper` });
  let ready = false;
  for (let i = 0; i < 80; i += 1) { const v = await ev(`(() => { const d = document.querySelector('iframe')?.contentDocument; return !!(d && d.body && d.body.textContent.trim().length > 0); })()`); if (v === true) { ready = true; break; } await sleep(300); }
  console.log(`正文就绪: ${ready}`);
  await sleep(1500);

  // 打开设置面板
  const opened = await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '设置' || x.getAttribute('aria-label') === '打开设置'); if (b) b.click(); return !!b; })()`);
  await sleep(1000);
  const panel = await ev(`(() => {
    const text = document.body.innerText;
    return JSON.stringify({
      hasPiperMicro: text.includes('Piper 音色微调'),
      hasStability: text.includes('音色稳定度'),
      hasProsody: text.includes('韵律起伏'),
      engineOption: [...document.querySelectorAll('select option')].some(o => o.textContent.includes('Piper')),
    });
  })()`);
  console.log(`设置面板: ${panel}`);

  // 拖拽两个滑杆到非默认值（default 0.667 / 0.8）
  const changed = await ev(`(() => {
    const ranges = [...document.querySelectorAll('aside input[type="range"]')];
    // 找到"音色稳定度"与"韵律起伏"：在 aside 里按 label 文本定位
    const labels = [...document.querySelectorAll('aside label')];
    let count = 0;
    for (const label of labels) {
      const text = label.textContent || '';
      const isStability = text.includes('音色稳定度');
      const isProsody = text.includes('韵律起伏');
      if (!isStability && !isProsody) continue;
      const input = label.querySelector('input[type="range"]');
      if (!input) continue;
      const next = isStability ? '0.30' : '1.20';
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, next);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      count += 1;
    }
    return count;
  })()`);
  console.log(`调过的滑杆数: ${changed}`);
  await sleep(1500);

  // 读 localStorage 确认已持久化
  const stored = await ev(`localStorage.getItem('epub-tts:reader-settings')`);
  console.log(`localStorage: ${String(stored).slice(0, 200)}`);

  // 点播放，抓合成请求体确认带新参数
  await ev(`(() => { const b = document.querySelector('button[aria-label="开始朗读"], button[aria-label="暂停朗读"]'); if (b) b.click(); return !!b; })()`);
  await sleep(6000);
  console.log(`合成请求体（前 1 条）: ${synthBodies[0] ? synthBodies[0].slice(0, 160) : '(未捕获)'}`);
  const hasNoise = synthBodies.some((b) => JSON.parse(b).noiseScale === 0.3 && JSON.parse(b).noiseWScale === 1.2);
  console.log(`请求携带新 noise 参数: ${hasNoise}`);
  ws.close(); child.kill();
  if (!hasNoise || changed !== 2) process.exit(1);
} catch (err) { console.error('FAIL:', err); child.kill(); process.exit(1); }
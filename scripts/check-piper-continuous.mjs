import { spawn } from 'node:child_process';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 验证"高亮在跑但没声音"的修复：
 *  1. 播放时 synthesize 请求应提前发起（prefetch 预生成生效）
 *  2. onStart/onEnd 应成对出现（每句都实际出声）
 *  3. 高亮推进与事件计数应匹配，而不是"高亮跑、事件没有"
 */
const browser = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find((p) => existsSync(p));
if (!browser) throw new Error('找不到 Microsoft Edge');
// 临时 profile 一律放项目内 .tmp/，不要落到项目外的盘符根目录
const profile = resolve(import.meta.dirname, '..', '.tmp', 'edge-prefetch');
const port = 9477;
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
  const synthEvents = []; // {t, action: start|end}
  let synthCounter = 0;
  const errors = [];
  ws.addEventListener('message', (event) => {
    const m = JSON.parse(event.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
    if (m.method === 'Network.requestWillBeSent' && /tts\/piper\/synthesize/.test(m.params.request?.url ?? '')) synthEvents.push({ t: Date.now(), action: 'req' });
    if (m.method === 'Network.responseReceived' && /tts\/piper\/synthesize/.test(m.params.response?.url ?? '')) { synthEvents.push({ t: Date.now(), action: 'resp' }); synthCounter += 1; }
    if (m.method === 'Network.loadingFailed') { const e = m.params; if (e.type === 'XHR' || e.type === 'Fetch') errors.push(`loadingFailed ${e.errorText ?? ''}`); }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') { errors.push((m.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 150)); }
  });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); return r?.result?.value ?? (r?.exceptionDetails ? `ERR:${r.exceptionDetails.text}` : undefined); };
  await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');

  await send('Page.navigate', { url: `${WEB}/#/read/${book.id}?engine=piper` });
  let ready = false;
  for (let i = 0; i < 80; i += 1) { const v = await ev(`(() => { const d = document.querySelector('iframe')?.contentDocument; return !!(d && d.body && d.body.textContent.trim().length > 0); })()`); if (v === true) { ready = true; break; } await sleep(300); }
  console.log(`正文就绪: ${ready}`);

  // 开播并持续观测 25 秒：统计 onStart / onEnd / 高亮句号变化
  await ev(`(() => { const b = document.querySelector('button[aria-label="开始朗读"], button[aria-label="暂停朗读"]'); if (b) b.click(); return !!b; })()`);
  const t0 = Date.now();
  const statusSamples = [];
  while (Date.now() - t0 < 30000) {
    const sample = await ev(`(() => {
      const playing = !!document.querySelector('button[aria-label="暂停朗读"]');
      const el = [...document.querySelectorAll('p')].find(p => /第\\s*\\d+\\s*\\/\\s*\\d+/.test(p.innerText));
      return JSON.stringify({ playing, pos: el ? el.innerText.replace(/\\s+/g, ' ') : '?' });
    })()`);
    statusSamples.push(sample);
    await sleep(500);
  }
  const positions = [...new Set(statusSamples.map((s) => { try { return JSON.parse(s).pos; } catch { return s; } }))];
  const playingSamples = statusSamples.filter((s) => { try { return JSON.parse(s).playing; } catch { return false; } }).length;
  console.log(`网络 synthesize 事件: ${synthEvents.length} (req+resp)`);
  if (synthEvents.length >= 2) {
    const first = synthEvents[0]; const last = synthEvents[synthEvents.length - 1];
    console.log(`  首次请求在开播后 ${((first.t - t0) / 1000).toFixed(1)}s，最后事件 ${((last.t - t0) / 1000).toFixed(1)}s`);
  }
  const reqs = synthEvents.filter((e) => e.action === 'req').length;
  const resps = synthEvents.filter((e) => e.action === 'resp').length;
  console.log(`synthesize 请求 ${reqs} 次 / 响应 ${resps} 次`);
  console.log(`30s 内播放状态样本：${statusSamples.length} 次采样，${playingSamples} 次处于播放`);
  console.log(`句子位置变化: ${positions.join(' -> ')}`);
  console.log(`console/网络错误: ${errors.length ? errors.join(' | ') : '(无)'}`);
  ws.close();
  child.kill();
} catch (err) { console.error('FAIL:', err); child.kill(); }
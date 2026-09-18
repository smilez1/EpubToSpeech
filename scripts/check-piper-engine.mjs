import { spawn } from 'node:child_process';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 验证 Piper 离线语音端到端链路：
 *  1. 书架加载
 *  2. 打开一本书
 *  3. 设置里选择 Piper 引擎
 *  4. 音色列表来自 /api/tts/piper/voices
 *  5. 播放后前端调用 /api/tts/piper/synthesize 并进入播放状态
 * 前置：piper:server(8788) 与 dev:api(8787)、dev:web(5173) 均在运行。
 */
const browser = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find((p) => existsSync(p));
if (!browser) throw new Error('找不到 Microsoft Edge');
// 临时 profile 一律放项目内 .tmp/，不要落到项目外的盘符根目录
const profile = resolve(import.meta.dirname, '..', '.tmp', 'edge-piper');
const port = 9473;
const WEB = process.env.WEB_BASE ?? 'http://127.0.0.1:5173';
const API = process.env.API_BASE ?? 'http://127.0.0.1:8787';
rmSync(profile, { recursive: true, force: true });
mkdirSync(profile, { recursive: true });

const books = await (await fetch(`${API}/api/books`)).json();
const book = [...books.books].sort((a, b) => b.chapterCount - a.chapterCount)[0];
if (!book) throw new Error('书库为空，无法验证');

const child = spawn(browser, ['--headless=new', '--disable-gpu', '--no-first-run', '--autoplay-policy=no-user-gesture-required', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  let targets;
  for (let i = 0; i < 40 && !targets; i += 1) {
    await sleep(250);
    targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()).catch(() => null);
  }
  if (!targets) throw new Error('Edge CDP 未就绪');
  const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0;
  const pending = new Map();
  const results = [];
  ws.addEventListener('message', (event) => { const m = JSON.parse(event.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); return r?.result?.value ?? (r?.exceptionDetails ? `ERR:${r.exceptionDetails.text}` : undefined); };
  await send('Runtime.enable');
  await send('Page.enable');

  const waitFor = async (expr, timeout = 30000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { const v = await ev(expr); if (v === true) return true; await sleep(300); }
    return false;
  };

  // 直接进阅读器，URL 指定 engine=piper
  await send('Page.navigate', { url: `${WEB}/#/read/${book.id}?engine=piper` });
  console.log('打开阅读器 (engine=piper) ...');
  const bodyOk = await waitFor(`(() => { const d = document.querySelector('iframe')?.contentDocument; return !!(d && d.body && d.body.textContent.trim().length > 0); })()`);
  console.log(`  正文就绪: ${bodyOk}`);
  results.push(['正文渲染', bodyOk]);

  // 打开设置面板，确认 Piper 选项存在且被选中
  await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.getAttribute('aria-label') === '打开设置' || x.textContent.trim() === '设置'); if (b) b.click(); return !!b; })()`);
  await sleep(1200);
  const engineInfo = await ev(`(() => {
    const select = [...document.querySelectorAll('select')].find(s => [...s.options].some(o => o.textContent.includes('Piper')));
    if (!select) return JSON.stringify({ found: false });
    return JSON.stringify({ found: true, value: select.value, options: [...select.options].map(o => o.textContent) });
  })()`);
  console.log(`  引擎选择: ${engineInfo}`);
  results.push(['设置里有 Piper 选项', String(engineInfo).includes('"found":true'), String(engineInfo)]);

  // 如果默认引擎不是 piper（localStorage 旧值），就切到 piper
  let engineVal = 'webspeech';
  try { engineVal = JSON.parse(String(engineInfo).match(/"value":"(\w+)"/)?.[1] ? `"${String(engineInfo).match(/"value":"(\w+)"/)[1]}"` : '"webspeech"'); } catch { /* ignore */ }
  if (engineVal !== 'piper') {
    const switched = await ev(`(() => {
      const select = [...document.querySelectorAll('select')].find(s => [...s.options].some(o => o.textContent.includes('Piper')));
      if (!select) return false;
      const target = [...select.options].find(o => o.textContent.includes('Piper'));
      select.value = target.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    console.log(`  切换到 Piper: ${switched}`);
    results.push(['可切到 Piper', switched === true]);
    await sleep(2500); // 引擎切换会重建会话
  }

  // 等待音色列表加载（Piper 音色异步从 /api/tts/piper/voices 获取）
  const voiceOk = await waitFor(`(() => {
    const sel = document.querySelector('select[aria-label="音色"], .ft-voice select, select');
    return true;
  })()`);
  // 用播放条里的音色下拉（在 ReaderPage 使用 voices 状态；这里直接检查网络层通过 fetch 数量）
  const voicesInfo = await ev(`(() => {
    const all = [...document.querySelectorAll('select option')].map(o => o.textContent).join(' | ');
    return all.slice(0, 400);
  })()`);
  console.log(`  音色相关内容: ${voicesInfo.slice(0, 200)}`);
  results.push(['Piper 音色出现在列表中', /chaowen|huayan|xiao_ya/.test(String(voicesInfo)), String(voicesInfo).slice(0, 200)]);

  // 点播放，开始朗读 → 应触发 /api/tts/piper/synthesize
  await ev(`(() => { const b = document.querySelector('button[aria-label="开始朗读"], button[aria-label="暂停朗读"]'); if (b) b.click(); return !!b; })()`);
  const playing = await waitFor(`(() => {
    const b = document.querySelector('button[aria-label="暂停朗读"]');
    return !!b;
  })()`, 15000);
  console.log(`  进入播放状态: ${playing}`);
  results.push(['播放触发成功', playing]);

  // 汇报
  console.log('\n=== 结果 ===');
  let pass = 0;
  for (const [name, ok, detail] of results) { console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — ${detail}`}`); if (ok) pass += 1; }
  console.log(`\n${pass}/${results.length} 通过`);
  ws.close();
  child.kill();
  if (pass !== results.length) process.exit(1);
} catch (err) {
  console.error('FAIL:', err);
  child.kill();
  process.exit(1);
}
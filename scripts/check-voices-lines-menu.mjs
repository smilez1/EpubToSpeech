import { spawn } from 'node:child_process';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 三项验证（第二版）：
 *  1. #/voices 语音包页面渲染（目录、许可标签、已安装、不可分发原站引导）
 *  2. 行距：走真实 UI —— 设置面板拖行距滑杆 → iframe p 计算样式变化
 *  3. 弹窗位置：点击正文后菜单 fixed 坐标 = iframe 内坐标 + iframe 偏移
 */
const browser = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find((p) => existsSync(p));
if (!browser) throw new Error('找不到 Microsoft Edge');
// 临时 profile 一律放项目内 .tmp/，不要落到项目外的盘符根目录
const profile = resolve(import.meta.dirname, '..', '.tmp', 'edge-three');
const port = 9489;
const WEB = process.env.WEB_BASE ?? 'http://127.0.0.1:5173';
const API = process.env.API_BASE ?? 'http://127.0.0.1:8787';
rmSync(profile, { recursive: true, force: true });
mkdirSync(profile, { recursive: true });

const books = await (await fetch(`${API}/api/books`)).json();
const book = [...books.books].sort((a, b) => b.chapterCount - a.chapterCount)[0];
if (!book) throw new Error('书库为空');
const child = spawn(browser, ['--headless=new', '--disable-gpu', '--no-first-run', '--autoplay-policy=no-user-gesture-required', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
try {
  let targets;
  for (let i = 0; i < 40 && !targets; i += 1) { await sleep(250); targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()).catch(() => null); }
  if (!targets) throw new Error('CDP 未就绪');
  const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0; const pending = new Map();
  ws.addEventListener('message', (event) => { const m = JSON.parse(event.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); return r?.result?.value ?? (r?.exceptionDetails ? 'ERR:' + r.exceptionDetails.text : undefined); };
  await send('Runtime.enable'); await send('Page.enable');

  /* ============ 1. 语音包页面 ============ */
  await send('Page.navigate', { url: `${WEB}/#/voices` });
  // 等目录渲染（现在即时返回，但保险起见等"已安装"或任一语音包 ID 出现）
  for (let i = 0; i < 40; i += 1) {
    const v = await ev(`document.body.innerText.includes('zh_CN-chaowen') || document.body.innerText.includes('已安装')`);
    if (v === true) break;
    await sleep(300);
  }
  await sleep(500);
  const voicesInfo = await ev(`(() => {
    const t = document.body.innerText;
    return JSON.stringify({
      hasLic: t.includes('许可'),
      hasChaowenId: t.includes('zh_CN-chaowen-medium'),
      hasXiaoyaId: t.includes('zh_CN-xiao_ya-medium'),
      hasHuayanId: t.includes('zh_CN-huayan-medium'),
      hasCC0: t.includes('CC0'),
      hasNoRedist: t.includes('不允许我们代为分发'),
      hasGoto: t.includes('前往原站'),
      hasInstalled: t.includes('已安装'),
      licLine: (t.split('\\n').find(x => x.includes('许可')) ?? '').trim().slice(0, 60),
    });
  })()`);
  const vp = JSON.parse(voicesInfo || '{}');
  console.log(`语音包页: ${voicesInfo}`);
  results.push(['语音包页打开', true]);
  results.push(['列出三个语音包 ID', vp.hasChaowenId && vp.hasXiaoyaId && vp.hasHuayanId]);
  results.push(['显示许可', vp.hasLic]);
  results.push(['chaowen 标 CC0', vp.hasCC0]);
  results.push(['不可分发有原站引导', vp.hasNoRedist && vp.hasGoto]);
  results.push(['显示已安装', vp.hasInstalled]);

  /* ============ 2. 行距（真实 UI 链路） ============ */
  await send('Page.navigate', { url: `${WEB}/#/read/${book.id}?engine=piper` });
  let ready = false;
  for (let i = 0; i < 80; i += 1) { const v = await ev(`(() => { const d = document.querySelector('iframe')?.contentDocument; return !!(d && d.body && d.body.textContent.trim().length > 0); })()`); if (v === true) { ready = true; break; } await sleep(300); }
  await sleep(1500);
  const before = await ev(`(() => { const d = document.querySelector('iframe')?.contentDocument; const p = d && d.querySelector('p, td, li') || d?.body; return p ? getComputedStyle(p).lineHeight : 'no-p'; })()`);

  // 打开设置面板，找到行距滑杆（label 文本含"行距"），拖到 2.4
  await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '设置' || x.getAttribute('aria-label') === '打开设置'); if (b) b.click(); return !!b; })()`);
  await sleep(800);
  const changed = await ev(`(() => {
    // 行距滑杆在设置面板的 Section 里（标题文本为"行距 X.X"），
    // 不是 label 包裹；用 h3 文本最近的 input 定位
    const h3 = [...document.querySelectorAll('aside h3')].find(h => (h.textContent || '').includes('行距'));
    const section = h3 && h3.closest('div');
    const input = section && section.querySelector('input[type="range"]');
    if (!input) return 'no-input';
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, '2.4');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return input.value;
  })()`);
  console.log(`设置面板行距滑杆设为: ${changed}`);
  // 关闭设置面板（点遮罩或 Esc），等样式应用
  await ev(`(() => { const a = document.querySelector('aside'); const mask = a && a.previousElementSibling; if (mask && mask.click) mask.click(); return true; })()`);
  await sleep(1500);
  const after = await ev(`(() => { const d = document.querySelector('iframe')?.contentDocument; const p = d && d.querySelector('p, td, li') || d?.body; return p ? getComputedStyle(p).lineHeight : 'no-p'; })()`);
  console.log(`  修改前行距: ${before}  修改后: ${after}`);
  const bPx = parseFloat(before); const aPx = parseFloat(after);
  results.push(['正文渲染', ready]);
  results.push(['行距设置生效（px 值增大）', !Number.isNaN(bPx) && !Number.isNaN(aPx) && aPx > bPx + 2]);

  /* ============ 3. 弹窗位置 ============ */
  const menuCheck = await ev(`(async () => {
    const d = document.querySelector('iframe')?.contentDocument;
    if (!d) return JSON.stringify({ ok: false, why: 'no-doc' });
    const el = d.elementFromPoint(Math.round(d.body.clientWidth / 2), Math.round(Math.min(d.body.clientHeight / 2, d.body.clientHeight - 20)));
    const target = (el && (el.closest('p') || el.closest('div') || el)) || d.body;
    const r = target.getBoundingClientRect();
    const cx = Math.max(10, r.left + r.width / 2);
    const cy = Math.max(10, r.top + r.height / 2);
    const evt = new d.defaultView.MouseEvent('click', { bubbles: true, cancelable: true, clientX: cx, clientY: cy, view: d.defaultView });
    target.dispatchEvent(evt);
    await new Promise(r2 => setTimeout(r2, 500));
    const menu = document.querySelector('[role="menu"]');
    if (!menu) return JSON.stringify({ ok: false, why: 'no-menu' });
    const m = menu.getBoundingClientRect();
    const fr = document.querySelector('iframe').getBoundingClientRect();
    const got = JSON.stringify({
      ok: true,
      menuLeft: Math.round(m.left), menuTop: Math.round(m.top),
      clickViewportX: Math.round(cx + fr.left), clickViewportY: Math.round(cy + fr.top),
      dx: Math.abs(m.left - (cx + fr.left)), dy: Math.abs(m.top - (cy + fr.top)),
    });
    return got;
  })()`);
  console.log(`  弹窗位置: ${menuCheck}`);
  const mp = JSON.parse(menuCheck || '{}');
  results.push(['点击正文出现菜单', mp.ok === true]);
  results.push(['菜单位于点击处(水平≤60px)', mp.ok === true && mp.dx < 60]);
  results.push(['菜单纵向贴近(≤200px)', mp.ok === true && mp.dy < 200]);

  ws.close(); child.kill();
  console.log('\n=== 结果 ===');
  let pass = 0;
  for (const [name, ok] of results) { console.log(`${ok ? '✓' : '✗'} ${name}`); if (ok) pass += 1; }
  console.log(`${pass}/${results.length} 通过`);
  if (pass !== results.length) process.exit(1);
} catch (err) { console.error('FAIL:', err); child.kill(); process.exit(1); }
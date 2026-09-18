/**
 * 验证阅读器的三处交互改动：
 *  1. 目录打开时滚动到「当前章节」位置，而不是从第一条开始
 *  2. 播放条的左右按钮切换**章节**（不是句子）
 *  3. 点击正文弹出菜单，由用户选择后才开始朗读（不直接出声）
 *
 * 用法：node scripts/check-reader-ui.mjs [bookId]
 * 前置：服务在跑。默认针对生产构建（dev 模式有 HMR 干扰）。
 */

import { spawn } from 'node:child_process';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const BROWSER = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p));

const ROOT = resolve(import.meta.dirname, '..');
const PROFILE = resolve(ROOT, '.tmp/edge-ui');
const PORT = 9467;
const WEB = process.env.WEB_BASE ?? 'http://127.0.0.1:8790';
const API = process.env.API_BASE ?? 'http://127.0.0.1:8787';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const books = await (await fetch(`${API}/api/books`)).json();
const book = process.argv[2]
  ? books.books.find((b) => b.id === process.argv[2])
  : [...books.books].sort((a, b) => b.chapterCount - a.chapterCount)[0];
console.log(`书：《${book.title}》 共 ${book.chapterCount} 章`);

// 清进度：否则会从上次留下的位置开始（实测曾停在第 1514 章，
// 只剩 2 章可翻，导致"点下一章"看起来像没反应）。
// 注意 href/cfi 也要清成空串——阅读器恢复位置时优先用它们，
// 只写 percent: 0 会留下旧 href，位置照旧。
await fetch(`${API}/api/books/${book.id}/progress`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ percent: 0, cfi: '', href: '', chapterIndex: 0, sentenceIndex: 0 }),
}).catch(() => undefined);

rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(PROFILE, { recursive: true });

const child = spawn(BROWSER, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--window-size=1200,900',
  '--autoplay-policy=no-user-gesture-required',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, 'about:blank',
], { stdio: 'ignore' });

let targets = null;
for (let i = 0; i < 40 && !targets; i += 1) {
  await sleep(250);
  targets = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json()).catch(() => null);
}
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));

let idc = 0;
const pending = new Map();
const consoleErrors = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m.result);
    pending.delete(m.id);
  } else if (m.method === 'Runtime.consoleAPICalled') {
    const text = (m.params.args ?? []).map((a) => a.value ?? a.description).join(' ');
    if (m.params.type === 'error') consoleErrors.push(text.slice(0, 200));
  }
});
const send = (method, params = {}) =>
  new Promise((r) => {
    const i = ++idc;
    pending.set(i, r);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: false });
  if (r?.exceptionDetails) return `ERR: ${r.exceptionDetails.text}`;
  return r?.result?.value;
};

/**
 * 等正文真正渲染出来（iframe 里有文本），而不只是 React 挂载。
 * 只等 root 有内容会在 epub 还没加载完时就动手，导致章节切换等操作无效。
 */
async function waitForBook(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await ev(`(() => {
      const d = document.querySelector('iframe')?.contentDocument;
      return !!(d && d.body && d.body.textContent.trim().length > 0
                && document.querySelector('button[aria-label="下一章"]'));
    })()`);
    if (ok === true) return true;
    await sleep(300);
  }
  return false;
}

const headerText = () => ev(`document.querySelector('header')?.innerText.replace(/\\s+/g,' ') ?? ''`);

await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: `${WEB}/#/read/${book.id}?engine=webspeech` });
const ready = await waitForBook();
console.log(`\n正文渲染就绪: ${ready}`);
await sleep(1000);

const results = [];

/* -------------------- 1. 播放条按钮应切换章节 -------------------- */

console.log('\n=== 1. 播放条按钮 ===');
const labels = await ev(
  `JSON.stringify([...document.querySelectorAll('button[aria-label]')].map(b => b.getAttribute('aria-label')))`,
);
console.log(`  按钮: ${labels}`);
results.push(['有"上一章/下一章"按钮', /上一章/.test(String(labels)) && /下一章/.test(String(labels)), String(labels)]);
results.push(['不再有"上一句/下一句"', !/上一句|下一句/.test(String(labels)), String(labels)]);

const before = await headerText();
const clickedNext = await ev(`(() => { const b = document.querySelector('button[aria-label="下一章"]'); if (b) b.click(); return !!b; })()`);
// 等显示切换（tryDisplaySection 最长等 2.5 秒）
let after = before;
for (let i = 0; i < 22; i += 1) {
  await sleep(400);
  after = await headerText();
  if (after !== before) break;
}
// 切换失败时会通过 onNotice 弹提示，把它一并取回来帮助定位
const notice = await ev(
  `(() => { const el = [...document.querySelectorAll('[role="status"], .fixed')].map(e => e.textContent).filter(Boolean); return el.join(' | '); })()`,
);
console.log(`  切章按钮: ${clickedNext}`);
console.log(`  切章前: ${String(before).slice(0, 56)}`);
console.log(`  切章后: ${String(after).slice(0, 56)}`);
console.log(`  提示: ${String(notice).slice(0, 120)}`);
results.push([
  '点"下一章"确实换了章',
  before !== after,
  `before=${String(before).slice(-26)} after=${String(after).slice(-26)}`,
]);

/* -------------------- 2. 目录应定位到当前章节 -------------------- */

console.log('\n=== 2. 目录定位 ===');
// 先跳到靠后的章节，这样"从头显示"与"定位到当前"才有区分度
await ev(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '目录');
  if (b) b.click();
  return !!b;
})()`);
await sleep(1000);
const jumped = await ev(`(() => {
  const btns = [...document.querySelectorAll('aside nav button')];
  if (btns.length < 10) return JSON.stringify({ ok: false, total: btns.length });
  // 点靠后的一条，制造"当前位置离顶部很远"的情形
  const target = btns[Math.min(300, btns.length - 2)];
  const label = target.textContent.trim();
  target.click();
  return JSON.stringify({ ok: true, label });
})()`);
console.log(`  先跳到: ${jumped}`);
await sleep(3500);
await waitForBook(15_000);

// 再打开目录，检查它是否滚到了当前项
await ev(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '目录');
  if (b) b.click();
  return !!b;
})()`);
await sleep(1200);
const toc = await ev(`(() => {
  const nav = document.querySelector('aside nav');
  if (!nav) return JSON.stringify({ open: false });
  const active = [...nav.querySelectorAll('button')].find(b => b.className.includes('text-accent'));
  const navRect = nav.getBoundingClientRect();
  const activeRect = active?.getBoundingClientRect();
  return JSON.stringify({
    open: true,
    total: nav.querySelectorAll('button').length,
    scrollTop: Math.round(nav.scrollTop),
    activeLabel: active ? active.textContent.trim() : null,
    activeVisible: activeRect ? activeRect.top >= navRect.top - 4 && activeRect.bottom <= navRect.bottom + 4 : false,
  });
})()`);
console.log(`  目录状态: ${toc}`);
results.push(['目录已打开', String(toc).includes('"open":true'), String(toc)]);
results.push(['目录有滚动（不是停在顶部）', /"scrollTop":[1-9]/.test(String(toc)), String(toc)]);
results.push(['当前章节项在可视区内', String(toc).includes('"activeVisible":true'), String(toc)]);

// 关掉目录：先尝试点遮罩，点不掉就按 Esc（抽屉支持两种关闭方式）
await ev(`(() => {
  const aside = document.querySelector('aside');
  if (!aside) return 'no-aside';
  const mask = aside.previousElementSibling;
  if (mask && typeof mask.click === 'function') {
    mask.click();
    return 'mask-clicked';
  }
  return 'no-mask';
})()`);
await sleep(500);
const stillOpen = await ev(`!!document.querySelector('aside nav')`);
if (stillOpen === true) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(500);
}
console.log(`  目录已关闭: ${(await ev(`!document.querySelector('aside nav')`)) === true}`);

/* -------------------- 3. 点击正文应弹菜单 -------------------- */

console.log('\n=== 3. 点击正文弹菜单 ===');
// 取正文中某个段落的视口坐标，然后用 CDP 派发真实鼠标点击
// （caretRangeFromPoint 依赖真实命中测试，合成的 MouseEvent 不可靠）
const point = await ev(`(() => {
  const frame = document.querySelector('iframe');
  const doc = frame?.contentDocument;
  if (!doc) return null;
  const frameRect = frame.getBoundingClientRect();
  for (const p of doc.querySelectorAll('p')) {
    const t = (p.textContent || '').trim();
    if (t.length < 12) continue;
    const r = p.getBoundingClientRect();
    if (r.width < 50 || r.height < 8) continue;
    // iframe 内坐标 + iframe 在页面中的偏移 = 页面视口坐标
    return JSON.stringify({
      x: Math.round(frameRect.left + r.left + 12),
      y: Math.round(frameRect.top + r.top + r.height / 2),
      text: t.slice(0, 30),
    });
  }
  return null;
})()`);
console.log(`  点击目标: ${point}`);

if (point && !String(point).startsWith('ERR')) {
  const { x, y } = JSON.parse(point);
  // 先移动（有些实现需要 hover 才做命中测试），按下与抬起之间留一点间隔
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await sleep(150);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await sleep(120);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await sleep(900);
}

const menu = await ev(`(() => {
  const m = document.querySelector('[role="menu"]');
  const bar = [...document.querySelectorAll('p')].map(p => p.textContent).join(' | ');
  return JSON.stringify({
    menuVisible: !!m,
    items: m ? [...m.querySelectorAll('button')].map(b => b.textContent.trim()) : [],
    playing: /正在朗读/.test(bar),
  });
})()`);
console.log(`  菜单: ${menu}`);
results.push(['点击正文弹出菜单', String(menu).includes('"menuVisible":true'), String(menu)]);
results.push(['点击时不直接播放', String(menu).includes('"playing":false'), String(menu)]);

// 点菜单里的"从这里开始朗读"，这时才应该出声
await ev(`(() => {
  const m = document.querySelector('[role="menu"]');
  const b = m ? [...m.querySelectorAll('button')].find(x => x.textContent.includes('从这里')) : null;
  if (b) b.click();
  return !!b;
})()`);
let afterMenu = '';
for (let i = 0; i < 20; i += 1) {
  await sleep(500);
  afterMenu = String(await ev(`[...document.querySelectorAll('p')].map(p => p.textContent).join(' | ')`));
  if (/正在朗读/.test(afterMenu)) break;
}
console.log(`  点菜单后: ${afterMenu.slice(0, 90)}`);
results.push(['菜单选择后才开始朗读', /正在朗读/.test(afterMenu), afterMenu.slice(0, 90)]);
results.push(['无控制台错误', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | ')]);

/* -------------------- 汇总 -------------------- */

let bad = 0;
console.log('');
for (const [name, ok, detail] of results) {
  if (!ok) bad += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ` —— ${detail}`}`);
}

ws.close();
child.kill();
await sleep(700);
try { rmSync(PROFILE, { recursive: true, force: true }); } catch {}

if (bad > 0) {
  console.error(`\n✗ ${bad} 项未通过`);
  process.exit(1);
}
console.log('\n✓ 三处交互改动均按预期工作');

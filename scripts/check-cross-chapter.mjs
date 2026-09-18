/**
 * 验证「跨章连续朗读」：读完一章的最后一句时，
 * 音频续读的同时**画面也要切到下一章**。
 *
 * 这是实测踩过的 bug：loadNextChapterChunks 只追加了下一章的句子，
 * 却没让 rendition 切换章节，于是"声音进了第二章、界面还在第一章"。
 *
 * 用法：node scripts/check-cross-chapter.mjs [bookId]
 * 默认用只有 2 章的样例书，便于快速跑到章末。
 */

import { spawn } from 'node:child_process';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const BROWSER = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p));

const ROOT = resolve(import.meta.dirname, '..');
const PROFILE = resolve(ROOT, '.tmp/edge-crossch');
const PORT = 9401;
const WEB = process.env.WEB_BASE ?? 'http://localhost:5173';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const books = await (await fetch('http://127.0.0.1:8787/api/books')).json();
// 优先选章节多的书，并跳到**倒数第二章**：这样续读后会进入末章，
// 能明确区分"续读成功"（进入末章后仍在读）与"读到全书末尾"（理应停止）。
// 样例书只有 2 章，进入末章后立刻就结束了，无法区分这两种情况。
const book = process.argv[2]
  ? books.books.find((b) => b.id === process.argv[2])
  : [...books.books].sort((a, b) => b.chapterCount - a.chapterCount)[0];

console.log(`书：《${book.title}》 共 ${book.chapterCount} 章`);

// 先清掉这本书的阅读进度，保证从第一章开始播。
// 否则上次跑完留下的"已读到末章"会让测试一开播就处于"本章已读完"。
const API = process.env.API_BASE ?? 'http://127.0.0.1:8787';
await fetch(`${API}/api/books/${book.id}/progress`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ percent: 0 }),
}).catch(() => undefined);
console.log('  已重置阅读进度到书首');

rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(PROFILE, { recursive: true });

const child = spawn(BROWSER, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--window-size=1200,800',
  '--autoplay-policy=no-user-gesture-required',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, 'about:blank',
], { stdio: 'ignore' });

let targets = null;
for (let i = 0; i < 40 && !targets; i++) {
  await sleep(250);
  targets = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json()).catch(() => null);
}
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));

let idc = 0;
const pending = new Map();
const errors = [];
const logs = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m.result);
    pending.delete(m.id);
  } else if (m.method === 'Runtime.exceptionThrown') {
    errors.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text);
  } else if (m.method === 'Runtime.consoleAPICalled') {
    const text = (m.params.args ?? []).map((a) => a.value ?? a.description).join(' ');
    if (text.includes('[reader]')) logs.push(text);
  }
});
const send = (method, params = {}) =>
  new Promise((r) => {
    const i = ++idc;
    pending.set(i, r);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const ev = async (expr, awaitPromise = false) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise });
  if (r?.exceptionDetails) return `ERR: ${r.exceptionDetails.text}`;
  return r?.result?.value;
};

/** 采样：当前章节标题 + 正文开头 + 朗读状态 */
const sample = () =>
  ev(`(()=>{
    const header=document.querySelector('header')?.innerText.replace(/\\s+/g,' ').trim() ?? '';
    const doc=document.querySelector('iframe')?.contentDocument;
    const text=doc?(doc.body.textContent||'').replace(/\\s+/g,' ').trim().slice(0,40):'';
    const bar=[...document.querySelectorAll('p')].map(p=>p.textContent).join(' | ');
    return JSON.stringify({ header, text, bar });
  })()`);

await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: 'about:blank' });
await sleep(300);
await send('Page.navigate', { url: `${WEB}/#/read/${book.id}` });

for (let i = 0; i < 50; i++) {
  await sleep(300);
  const ok = await ev(
    `(()=>{const d=document.querySelector('iframe')?.contentDocument;return !!(d&&d.body&&d.body.textContent.trim().length>0)})()`,
  );
  if (ok === true) break;
}
await sleep(600);

// 清掉进度，确保从第一章开始（否则可能落在任意章节）
await ev(`localStorage.setItem('epub-tts:reader-settings', JSON.stringify({theme:'dark',fontSize:18,lineHeight:1.8,maxWidthPercent:82,fontFamily:'serif',flow:'scrolled-doc',rate:2.2,volume:1}))`);
await send('Page.reload', {});
await sleep(400);
for (let i = 0; i < 50; i++) {
  await sleep(300);
  const ok = await ev(
    `(()=>{const d=document.querySelector('iframe')?.contentDocument;return !!(d&&d.body&&d.body.textContent.trim().length>0)})()`,
  );
  if (ok === true) break;
}
await sleep(800);

const before = JSON.parse(await sample());
console.log(`\n播放前:`);
console.log(`  标题: ${before.header.slice(0, 60)}`);
console.log(`  正文: ${before.text.slice(0, 40)}`);

// 跳到倒数第二章，让续读在可观察的时间内发生
await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='目录');b?.click();return !!b})()`);
await sleep(600);
const jumped = await ev(`(()=>{
  const btns=[...document.querySelectorAll('aside nav button')];
  if (btns.length < 3) return {ok:false, total:btns.length};
  const idx = Math.max(0, btns.length - 2);
  const label = btns[idx].textContent.trim();
  btns[idx].click();
  return {ok:true, label, total:btns.length};
})()`);
console.log(`\n→ 跳到倒数第二章: ${JSON.stringify(jumped)}`);
await sleep(2500);
const afterJump = JSON.parse(await sample());
console.log(`  跳转后标题: ${afterJump.header.slice(0, 60)}`);
console.log(`  跳转后正文: ${afterJump.text.slice(0, 40)}`);

const chapterBefore = afterJump.text.slice(0, 20);

// 点播放
await ev(`(()=>{const b=document.querySelector('button[aria-label="开始朗读"]');b?.click();return !!b})()`);
await sleep(1500);

// 播放条的左右按钮已改为"切换章节"，界面上没有跳句入口。
// 用**方向键**推进：阅读器把 keydown 挂在 window 上，→ 就是下一句。
// 用真实按键而不是内部 API，默认构建（不含测试钩子）也能跑。
console.log('\n→ 按 → 键推进到章末…');
const totalSentences = Number(
  (await ev(`(()=>{const m=/共 (\\d+) 句|第 \\d+ \\/ (\\d+) 句/.exec(document.body.innerText);return m?(m[1]||m[2]||'0'):'0'})()`)) ?? 0,
);
const presses = Math.min(Math.max(totalSentences + 3, 12), 120);
for (let i = 0; i < presses; i += 1) {
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'ArrowRight',
    code: 'ArrowRight',
    windowsVirtualKeyCode: 39,
    nativeVirtualKeyCode: 39,
  });
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'ArrowRight',
    code: 'ArrowRight',
    windowsVirtualKeyCode: 39,
    nativeVirtualKeyCode: 39,
  });
  await sleep(110);
}
console.log(`  已按 → ${presses} 次（章内共约 ${totalSentences} 句）`);

console.log('\n→ 最多等 60 秒，观察是否自动切到下一章并继续朗读…');
let changed = null;
let playingSeen = false;
for (let i = 0; i < 60; i++) {
  await sleep(1000);
  const now = JSON.parse(await sample());
  if (/正在朗读/.test(now.bar)) playingSeen = true;
  if (now.text !== chapterBefore && !now.text.includes(chapterBefore.slice(0, 10))) {
    changed = { at: i + 1, now };
    break;
  }
  if (i % 10 === 9) {
    console.log(`  [${i + 1}s] 状态: ${now.bar.slice(0, 90)}`);
  }
}

if (!changed) {
  const now = JSON.parse(await sample());
  console.log('\n✗ 60 秒内正文没有切换到下一章');
  console.log(`  最终标题: ${now.header.slice(0, 60)}`);
  console.log(`  最终正文: ${now.text.slice(0, 40)}`);
  console.log(`  播放条: ${now.bar.slice(0, 100)}`);
  ws.close(); child.kill(); await sleep(600);
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch {}
  process.exit(1);
}

console.log(`\n✓ 第 ${changed.at} 秒检测到正文已切换`);
console.log(`  切换后标题: ${changed.now.header.slice(0, 60)}`);
console.log(`  切换后正文: ${changed.now.text.slice(0, 40)}`);

// 关键：切换之后必须**继续朗读**，而不是停在那里等用户手动点播放。
// 因为目标是倒数第二章，进入末章后应仍在朗读（而不是"本章已读完"）。
console.log('\n→ 继续观察 20 秒，确认切换后仍在自动朗读…');
let stillPlaying = false;
for (let i = 0; i < 20; i++) {
  await sleep(1000);
  const now = JSON.parse(await sample());
  if (/正在朗读/.test(now.bar)) stillPlaying = true;
}
const afterSwitch = JSON.parse(await sample());
console.log(`  20 秒后播放条: ${afterSwitch.bar.slice(0, 110)}`);
if (logs.length) {
  console.log('  [浏览器日志]');
  for (const l of logs.slice(-10)) console.log(`    ${l}`);
}

const checks = [
  ['正文确实换成了新内容', changed.now.text !== chapterBefore, `旧=${chapterBefore} 新=${changed.now.text.slice(0, 20)}`],
  ['标题随之更新', changed.now.header !== afterJump.header, `旧=${afterJump.header.slice(-20)} 新=${changed.now.header.slice(-20)}`],
  ['切换后仍在自动朗读（不会停下来）', stillPlaying, `播放条=${afterSwitch.bar.slice(0, 100)}`],
  ['过程无未捕获异常', errors.length === 0, errors.slice(0, 2).join(' | ')],
];

let bad = 0;
for (const [name, ok, detail] of checks) {
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
console.log('\n✓ 跨章连续朗读时，画面与音频同步切换');

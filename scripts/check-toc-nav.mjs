/**
 * 验证目录跳转与标题一致性。
 *
 * 复现原问题：spine 节数(1516) ≠ 目录项数(1514)，导致按序号取标题时
 * 标题比正文内容早 2 章。修复后按 href 匹配，标题应与正文内容一致。
 *
 * 检查方式：点目录里的某一章 → 顶部标题、目录高亮项、正文首句三者必须指向同一章。
 *
 * 用法：node scripts/check-toc-nav.mjs [bookId] [目标章节关键词]
 */

import { spawn } from 'node:child_process';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const BROWSER = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p));

const ROOT = resolve(import.meta.dirname, '..');
const PROFILE = resolve(ROOT, '.tmp/edge-toc');
const PORT = 9399;
const WEB = process.env.WEB_BASE ?? 'http://localhost:5173';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const books = await (await fetch('http://127.0.0.1:8787/api/books')).json();
const book = process.argv[2] ? books.books.find((b) => b.id === process.argv[2]) : books.books[0];

/** 从书的目录里挑一个真实存在的目标项，避免写死章号导致换书就失效。 */
function flattenToc(list, out = []) {
  for (const e of list ?? []) {
    out.push(e);
    if (e.children?.length) flattenToc(e.children, out);
  }
  return out;
}
const flatToc = flattenToc(book.toc);
if (flatToc.length === 0) {
  console.error(`✗《${book.title}》没有目录数据，无法验证目录跳转`);
  process.exit(1);
}
// 取一个靠中间的项，避免首页/尾页的特殊情况；可用第 3 个参数覆盖
const targetEntry = process.argv[3]
  ? flatToc.find((e) => e.label?.includes(process.argv[3])) ?? flatToc[Math.floor(flatToc.length / 2)]
  : flatToc[Math.min(5, flatToc.length - 1)];
const keyword = targetEntry.label;
console.log(`目标章节（取自目录）: 「${keyword}」`);

rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(PROFILE, { recursive: true });

const child = spawn(BROWSER, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--window-size=1400,900',
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
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: false });
  if (r?.exceptionDetails) return `ERR: ${r.exceptionDetails.text}`;
  return r?.result?.value;
};

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

const readHeader = () => ev(
  `(()=>{const h=document.querySelector('header');return h?h.innerText.replace(/\\s+/g,' ').trim():null})()`,
);
const readContentHead = () => ev(
  `(()=>{const d=document.querySelector('iframe')?.contentDocument;if(!d)return null;return (d.body.textContent||'').replace(/\\s+/g,' ').trim().slice(0,60)})()`,
);

console.log(`书：《${book.title}》`);
console.log(`初始标题: ${await readHeader()}`);
console.log(`初始正文: ${await readContentHead()}`);

/* 先摸清 epub.js 的 spine 键长什么样 */
const spineInfo = await ev(`(()=>{
  const f=document.querySelector('iframe');
  return 'skip';
})()`);
void spineInfo;

/* 打开目录并点击目标章节 */
console.log(`\n→ 打开目录，点击包含「${keyword}」的项`);
const clicked = await ev(`(()=>{
  const btn=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='目录');
  if(!btn) return 'no-toc-button';
  btn.click();
  return 'opened';
})()`);
console.log(`  ${clicked}`);
await sleep(500);

const pickResult = await ev(`(()=>{
  const nodes=[...document.querySelectorAll('aside nav button')];
  const hit=nodes.find(n=>n.textContent.includes(${JSON.stringify(keyword)}));
  if(!hit) return {found:false, sample: nodes.slice(0,5).map(n=>n.textContent.trim())};
  const label=hit.textContent.trim();
  hit.click();
  return {found:true, label};
})()`);
console.log(`  目录点击: ${JSON.stringify(pickResult)}`);
if (!pickResult?.found) {
  ws.close(); child.kill(); await sleep(600);
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch {}
  process.exit(1);
}

/* 等新章节渲染 */
for (let i = 0; i < 40; i++) {
  await sleep(300);
  const t = await readContentHead();
  if (t && t.length > 5) break;
}
await sleep(1000);

const header = await readHeader();
const content = await readContentHead();
/* 抽屉在点击后会关闭（设计如此），所以要重新打开才能检查高亮 */
await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='目录');b?.click();return !!b})()`);
await sleep(600);
const activeInToc = await ev(`(()=>{
  const btns=[...document.querySelectorAll('aside nav button')];
  const withClass=btns.filter(b=>b.className.includes('text-accent'));
  return JSON.stringify({
    total: btns.length,
    accentCount: withClass.length,
    accentLabels: withClass.map(b=>b.textContent.trim()).slice(0,3),
  });
})()`);

console.log(`\n→ 跳转后`);
console.log(`  顶部标题: ${header}`);
console.log(`  正文开头: ${content}`);
console.log(`  目录高亮: ${activeInToc}`);
if (logs.length) {
  console.log('  [浏览器日志]');
  for (const l of logs.slice(-8)) console.log(`    ${l}`);
}

/* 判定：关键词（章号）应同时出现在标题、目录高亮、正文里 */
const target = pickResult.label;
const checks = [
  ['顶部标题与点击项一致', header?.includes(target) === true, `标题=${header}`],
  ['顶部标题含目标章号', header?.includes(keyword) === true, `标题=${header}`],
  ['正文含目标章号（内容对得上）', content?.includes(keyword) === true, `正文=${content}`],
  ['目录高亮命中点击项', String(activeInToc).includes(target), `目录状态=${activeInToc}`],
  ['跳转过程无未捕获异常', errors.length === 0, errors.slice(0, 2).join(' | ')],
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
  console.error(`\n✗ ${bad} 项不一致`);
  process.exit(1);
}
console.log('\n✓ 目录跳转、顶部标题与正文内容指向同一章');

/**
 * 验证阅读设置是否真正作用到正文：改行宽/字号后量段落几何。
 *
 * 用法：node scripts/check-settings-apply.mjs
 */

import { spawn } from 'node:child_process';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const BROWSER = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p));

const ROOT = resolve(import.meta.dirname, '..');
const PROFILE = resolve(ROOT, '.tmp/edge-settings');
const PORT = 9377;
const WEB = process.env.WEB_BASE ?? 'http://localhost:5173';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const books = await (await fetch('http://127.0.0.1:8787/api/books')).json();
const book = books.books[0];

rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(PROFILE, { recursive: true });

const child = spawn(BROWSER, [
  '--headless=new', '--disable-gpu', '--no-first-run',
  '--window-size=1400,800',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, 'about:blank',
], { stdio: 'ignore' });

let targets = null;
for (let i = 0; i < 40 && !targets; i++) {
  await sleep(250);
  targets = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json()).catch(() => null);
}
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res) => ws.addEventListener('open', res, { once: true }));

let idc = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id).res(m.result);
    pending.delete(m.id);
  }
});
const send = (method, params = {}) =>
  new Promise((res) => {
    const i = ++idc;
    pending.set(i, { res });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: false });
  return r?.result?.value;
};

const waitReady = async () => {
  for (let i = 0; i < 50; i++) {
    await sleep(300);
    const ok = await evalJs(
      `(() => { const t=document.body.innerText||''; if(t.includes('正在加载阅读器')||t.includes('正在打开书籍')) return false; const f=document.querySelector('iframe'); return !!(f && f.contentDocument && f.contentDocument.body); })()`,
    );
    if (ok === true) return true;
  }
  return false;
};

const measure = () =>
  evalJs(`JSON.stringify((() => {
    const doc = document.querySelector('iframe')?.contentDocument;
    if (!doc) return { error: 'no-iframe' };
    const root = doc.documentElement;
    const p = doc.querySelector('p');
    const r = p?.getBoundingClientRect();
    const container = document.querySelector('.epub-container');
    const host = document.querySelector('.epub-host');
    const stage = container?.firstElementChild;
    return {
      computedHtmlMaxWidth: getComputedStyle(root).maxWidth,
      fontSize: getComputedStyle(root).fontSize,
      lineHeight: getComputedStyle(root).lineHeight,
      paraWidth: r ? Math.round(r.width) : null,
      paraLeft: r ? Math.round(r.left) : null,
      // 分页模式下按列布局，需要单独看容器/舞台/可视宽度是否自洽
      hostW: host ? Math.round(host.getBoundingClientRect().width) : null,
      containerW: container ? Math.round(container.getBoundingClientRect().width) : null,
      containerScrollW: container ? container.scrollWidth : null,
      stageW: stage ? Math.round(stage.getBoundingClientRect().width) : null,
      iframeViewportW: doc.documentElement.clientWidth,
      pageOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  })())`);

/** 分页模式下逐列检查文字是否被裁切 */
const checkColumns = () =>
  evalJs(`JSON.stringify((() => {
    const doc = document.querySelector('iframe')?.contentDocument;
    const container = document.querySelector('.epub-container');
    if (!doc || !container) return null;
    const cols = doc.documentElement.clientWidth;
    const total = container.scrollWidth;
    const pages = Math.max(1, Math.round(total / cols));
    return { columnWidth: cols, totalScrollWidth: total, approxColumns: pages,
             containerOverflowX: getComputedStyle(container).overflowX };
  })())`);

/** 修改 localStorage 里的偏好并重载页面 */
const setPrefs = async (patch) => {
  await evalJs(`(() => {
    const KEY = 'epub-tts:reader-settings';
    const cur = JSON.parse(localStorage.getItem(KEY) || '{}');
    localStorage.setItem(KEY, JSON.stringify({ ...cur, ...${JSON.stringify(patch)} }));
    return true;
  })()`);
  await send('Page.reload', { ignoreCache: false });
  await waitReady();
  await sleep(500);
};

await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: 'about:blank' });
await sleep(300);

/** 覆盖 localStorage 里的偏好（可只设部分字段），不重载页面 —— 用于验证迁移逻辑。 */
const writePrefs = async (patch) => {
  await evalJs(`(() => {
    const KEY = 'epub-tts:reader-settings';
    localStorage.setItem(KEY, JSON.stringify(${JSON.stringify(patch)}));
    return true;
  })()`);
};

/** 读回页面里实际生效的偏好值。 */
const readEffective = () =>
  evalJs(`(() => {
    const doc = document.querySelector('iframe')?.contentDocument;
    const root = doc?.documentElement;
    return JSON.stringify({
      appliedMaxWidth: root ? getComputedStyle(root).maxWidth : null,
      stored: JSON.parse(localStorage.getItem('epub-tts:reader-settings') || '{}'),
    });
  })()`);

console.log('=== 迁移：旧版固定像素 maxWidth:720 应变成合理百分比 ===');
await send('Page.navigate', { url: `${WEB}/#/read/${book.id}` });
await waitReady();
await writePrefs({ maxWidth: 720, theme: 'dark', fontSize: 18, lineHeight: 1.8, flow: 'scrolled-doc' });
await send('Page.reload', {});
await waitReady();
await sleep(400);
console.log('  ' + (await readEffective()));

console.log('\n=== 迁移：旧版 maxWidth:1100 ===');
await writePrefs({ maxWidth: 1100, theme: 'dark', fontSize: 18, lineHeight: 1.8, flow: 'scrolled-doc' });
await send('Page.reload', {});
await waitReady();
await sleep(400);
console.log('  ' + (await readEffective()));

console.log('\n=== 行宽 82%（新默认） ===');
await setPrefs({ maxWidthPercent: 82, fontSize: 18, flow: 'scrolled-doc' });
console.log('  ' + (await measure()));

console.log('\n=== 浏览器缩放 150%（模拟"放大浏览器"） ===');
await send('Emulation.setPageScaleFactor', { pageScaleFactor: 1.5 }).catch(() => undefined);
await send('Emulation.setDeviceMetricsOverride', {
  width: 1400,
  height: 800,
  deviceScaleFactor: 1.5,
  mobile: false,
}).catch(() => undefined);
await sleep(1200);
console.log('  ' + (await measure()));

console.log('\n=== 重置缩放，改为缩小可视区（960x600） ===');
await send('Emulation.clearDeviceMetricsOverride').catch(() => undefined);
await send('Emulation.setDeviceMetricsOverride', {
  width: 960,
  height: 600,
  deviceScaleFactor: 1,
  mobile: false,
}).catch(() => undefined);
await sleep(1200);
console.log('  ' + (await measure()));

console.log('\n=== 模拟手机宽度（CDP 覆盖可视区，避免窗口最小宽度干扰） ===');
for (const w of [360, 390, 480, 834]) {
  await send('Emulation.setDeviceMetricsOverride', {
    width: w,
    height: 720,
    deviceScaleFactor: 1,
    mobile: true,
  }).catch(() => undefined);
  await sleep(1200);
  const m = JSON.parse(await measure());
  const ratio = m.paraWidth ? Math.round((m.paraWidth / w) * 100) : null;
  console.log(
    `  ${w}px 可视区 -> 正文 ${m.paraWidth}px（占 ${ratio}%），上限 ${m.computedHtmlMaxWidth}，溢出 ${m.pageOverflowX}`,
  );
}
await send('Emulation.clearDeviceMetricsOverride').catch(() => undefined);
await sleep(600);

ws.close();
child.kill();
await sleep(700);
try {
  rmSync(PROFILE, { recursive: true, force: true });
} catch {
  /* 忽略 */
}

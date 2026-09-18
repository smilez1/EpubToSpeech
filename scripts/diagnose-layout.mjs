/**
 * 阅读器排版诊断：在真实浏览器里量 iframe 内的几何数据，
 * 用于定位"文字超出显示区域"这类问题。
 *
 * 用法：node scripts/diagnose-layout.mjs [bookId]
 */

import { spawn } from 'node:child_process';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const BROWSER = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p));

const ROOT = resolve(import.meta.dirname, '..');
const PROFILE = resolve(ROOT, '.tmp/edge-layout');
const PORT = 9355;
const WEB = process.env.WEB_BASE ?? 'http://localhost:5173';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const books = await (await fetch('http://127.0.0.1:8787/api/books')).json();
const book = process.argv[2]
  ? books.books.find((b) => b.id === process.argv[2])
  : books.books[0];
if (!book) {
  console.error('✗ 找不到目标书');
  process.exit(1);
}
console.log(`目标书籍：《${book.title}》`);

rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(PROFILE, { recursive: true });

const child = spawn(BROWSER, [
  '--headless=new', '--disable-gpu', '--no-first-run',
  `--window-size=${process.env.WIN_W ?? 1280},${process.env.WIN_H ?? 800}`,
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
  if (r?.exceptionDetails) return `❌ ${r.exceptionDetails.text ?? ''} ${r.exceptionDetails.exception?.description ?? ''}`;
  return r?.result?.value;
};

await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: 'about:blank' });
await sleep(300);
await send('Page.navigate', { url: `${WEB}/#/read/${book.id}` });

// 等渲染就绪
for (let i = 0; i < 50; i++) {
  await sleep(300);
  const ok = await evalJs(
    `(() => { const t=document.body.innerText||''; if(t.includes('正在加载阅读器')||t.includes('正在打开书籍')) return false; const f=document.querySelector('iframe'); return !!(f && f.contentDocument && f.contentDocument.body); })()`,
  );
  if (ok === true) break;
}
await sleep(600);

console.log('\n=== 外层容器几何 ===');
console.log(
  await evalJs(`JSON.stringify((() => {
    const pick = (el) => el ? { w: Math.round(el.getBoundingClientRect().width), ox: el.scrollWidth - el.clientWidth, cw: el.clientWidth, sw: el.scrollWidth } : null;
    // 从 body 一路走到 .epub-container，看清是哪一层变宽的
    const chain = [];
    const container = document.querySelector('.epub-container');
    let el = document.body;
    const stop = container;
    const walk = (node, depth) => {
      chain.push({
        depth,
        tag: node.tagName + (node.className ? '.' + String(node.className).split(' ').slice(0,2).join('.') : ''),
        w: Math.round(node.getBoundingClientRect().width),
        cw: node.clientWidth,
        styleWidth: node.style.width || '',
        styleFlex: node.style.flex || '',
        display: getComputedStyle(node).display,
        overflowX: getComputedStyle(node).overflowX,
      });
      for (const c of node.children) {
        if (depth < 8) walk(c, depth + 1);
      }
    };
    walk(el, 0);
    return {
      window: { w: innerWidth, h: innerHeight },
      hasHorizontalScrollbar: document.body.scrollWidth > document.body.clientWidth,
      htmlScroll: { sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth },
      epubContainer: pick(container),
      chain: chain.slice(0, 14),
    };
  })())`, null, 1),
);

console.log('\n=== 溢出层（min-h-0 flex-1）细节 ===');
console.log(
  await evalJs(`JSON.stringify((() => {
    const el = document.querySelector('.relative.flex.min-h-0.flex-1 > div') || document.querySelector('div.min-h-0.flex-1');
    const parent = el?.parentElement;
    const detail = (n) => {
      if (!n) return null;
      const cs = getComputedStyle(n);
      return {
        tag: n.tagName + (n.className ? '.' + String(n.className) : ''),
        rectWidth: Math.round(n.getBoundingClientRect().width),
        clientWidth: n.clientWidth,
        offsetWidth: n.offsetWidth,
        inlineStyle: n.getAttribute('style') || '',
        cssText: n.style.cssText || '',
        display: cs.display, flex: cs.flex, width: cs.width, minWidth: cs.minWidth, maxWidth: cs.maxWidth,
        margin: cs.margin, padding: cs.padding, boxSizing: cs.boxSizing, overflow: cs.overflow,
      };
    };
    return {
      overflowingLayer: detail(el),
      itsParent: detail(parent),
      parentIsFlex: parent ? getComputedStyle(parent).display : null,
      childrenOfOverflowing: el ? Array.from(el.children).map((c) => detail(c)) : [],
    };
  })())`, null, 1),
);

console.log('\n=== iframe 内部几何 ===');
console.log(
  await evalJs(`JSON.stringify((() => {
    const f = document.querySelector('iframe');
    const doc = f.contentDocument;
    const win = f.contentWindow;
    const html = doc.documentElement;
    const body = doc.body;
    const cs = win.getComputedStyle(body);
    const htmlCs = win.getComputedStyle(html);
    // 找出横向溢出的元素
    const limit = html.clientWidth;
    const overflowers = [];
    for (const el of doc.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.right > limit + 1 || r.width > limit + 1) {
        overflowers.push({
          tag: el.tagName,
          cls: (el.className || '').toString().slice(0, 40),
          right: Math.round(r.right),
          width: Math.round(r.width),
          text: (el.textContent || '').trim().slice(0, 30),
        });
      }
      if (overflowers.length >= 8) break;
    }
    return {
      win: { innerWidth: win.innerWidth, innerHeight: win.innerHeight },
      html: { clientWidth: html.clientWidth, scrollWidth: html.scrollWidth, overflowX: html.scrollWidth - html.clientWidth,
              styleWidth: html.style.width, styleMaxWidth: html.style.maxWidth, stylePadding: html.style.paddingLeft + '/' + html.style.paddingRight,
              computedOverflowX: htmlCs.overflowX, computedBoxSizing: htmlCs.boxSizing },
      body: { clientWidth: body.clientWidth, scrollWidth: body.scrollWidth, offsetWidth: body.offsetWidth,
              marginLeft: cs.marginLeft, marginRight: cs.marginRight, paddingLeft: cs.paddingLeft, paddingRight: cs.paddingRight,
              styleMaxWidth: body.style.maxWidth, styleMargin: body.style.margin, stylePosition: body.style.position,
              boxSizing: cs.boxSizing, computedOverflowX: cs.overflowX },
      overflowers,
    };
  })())`, null, 1),
);

console.log('\n=== 前两个段落的实测行宽 ===');
console.log(
  await evalJs(`JSON.stringify((() => {
    const doc = document.querySelector('iframe').contentDocument;
    const out = [];
    for (const p of Array.from(doc.querySelectorAll('p,div,li')).slice(0, 3)) {
      const r = p.getBoundingClientRect();
      out.push({ tag: p.tagName, width: Math.round(r.width), left: Math.round(r.left), right: Math.round(r.right), text: (p.textContent||'').trim().slice(0, 24) });
    }
    return { viewport: doc.documentElement.clientWidth, paragraphs: out };
  })())`, null, 1),
);

ws.close();
child.kill();
// 浏览器进程退出需要一点时间释放 profile 里的文件锁，删不掉就留着下次清
await sleep(800);
try {
  rmSync(PROFILE, { recursive: true, force: true });
} catch {
  /* EBUSY：下次运行开头会再清一次 */
}

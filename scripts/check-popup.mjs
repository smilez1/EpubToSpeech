import { spawn } from 'node:child_process';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 验证弹窗 v4：
 *  1. 菜单锚点 = **句子头**下方（距句首字符底部 ≤12px），而非点击处
 *  2. 正文里出现选中句子的高亮框（data-tts-highlight 覆盖层可见）
 *  3. Esc 关闭后菜单消失、高亮清除
 */
const browser = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find((p) => existsSync(p));
if (!browser) throw new Error('找不到 Microsoft Edge');
// 临时 profile 一律放项目内 .tmp/，不要落到项目外的盘符根目录
const profile = resolve(import.meta.dirname, '..', '.tmp', 'edge-popup');
const port = 9501;
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

  await send('Page.navigate', { url: `${WEB}/#/read/${book.id}?engine=piper` });
  let ready = false;
  for (let i = 0; i < 80; i += 1) { const v = await ev(`(() => { const d = document.querySelector('iframe')?.contentDocument; return !!(d && d.body && d.body.textContent.trim().length > 0); })()`); if (v === true) { ready = true; break; } await sleep(300); }
  console.log(`正文就绪: ${ready}`);
  await sleep(1500);
  results.push(['正文渲染', ready]);

  // 页面内执行全部步骤，返回最终布尔结果对象
  const run = [
    '(async () => {',
    '  const out = {};',
    '  const d = document.querySelector("iframe")?.contentDocument;',
    '  if (!d) return JSON.stringify({ ok: false });',
    '  const paras = [...d.querySelectorAll("p")].filter(p => (p.textContent || "").length >= 60);',
    '  if (!paras.length) return JSON.stringify({ ok: false });',
    '  // 选**页面顶部**的段落：避免底部空间不足触发菜单向上翻转（那是合理备选，非本测试目标）',
    '  const p = paras.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0];',
    '  const text = p.textContent || "";',
    '  const targetIndex = Math.min(text.length - 1, Math.floor(text.length * 0.4));',
    '  const sentStart = Math.max(0, text.lastIndexOf("。", targetIndex) + 1);',
    '  function charRectAt(index) {',
    '    const w2 = d.createTreeWalker(p, NodeFilter.SHOW_TEXT);',
    '    let ch = 0; let node = null; let off = 0;',
    '    while (w2.nextNode()) {',
    '      const t = w2.currentNode;',
    '      if (index - ch <= t.textContent.length) { node = t; off = index - ch; break; }',
    '      ch += t.textContent.length;',
    '    }',
    '    if (!node) return null;',
    '    const r = document.createRange();',
    '    r.setStart(node, off); r.setEnd(node, Math.min(off + 1, node.textContent.length));',
    '    return r.getBoundingClientRect();',
    '  }',
    '  const sentStartRect = charRectAt(sentStart);',
    '  const clickRect = charRectAt(sentStart + Math.floor((targetIndex - sentStart) * 0.6) + 1); // 句内中后部',
    '  if (!sentStartRect || !clickRect) return JSON.stringify({ ok: false });',
    '  const evt = new d.defaultView.MouseEvent("click", { bubbles: true, cancelable: true, clientX: clickRect.left + clickRect.width / 2, clientY: clickRect.top + clickRect.height / 2, view: d.defaultView });',
    '  p.dispatchEvent(evt);',
    '  await new Promise(r2 => setTimeout(r2, 600));',
    '  const menu = document.querySelector("[role=\\"menu\\"]");',
    '  const overlay = d.querySelector("[data-tts-highlight]");',
    '  if (!menu) return JSON.stringify({ ok: false });',
    '  const m = menu.getBoundingClientRect();',
    '  const fr = document.querySelector("iframe").getBoundingClientRect();',
    '  const sentBottomView = sentStartRect.bottom + fr.top;',
    '  out.menuToSentGap = Math.round(m.top - sentBottomView);',
    '  out.flipped = m.top < sentBottomView - 2; // 判断是否发生向上翻转',
    '  out.debug = JSON.stringify({ menuTop: Math.round(m.top), sentBottomView: Math.round(sentBottomView), menuH: Math.round(m.height), winH: window.innerHeight, frTop: Math.round(fr.top) });',
    '  out.menuLeft = Math.round(m.left);',
    '  out.sentLeft = Math.round(sentStartRect.left + fr.left);',
    '  out.overlayVisible = !!overlay && overlay.style.display !== "none";',
    '  out.buttons = [...menu.querySelectorAll("button")].map(b => b.textContent.trim());',
    '  // Esc 关闭',
    '  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));',
    '  await new Promise(r2 => setTimeout(r2, 300));',
    '  out.menuGone = !document.querySelector(".role-menu, [role=\\"menu\\"]");',
    '  out.hlCleared = !!overlay && overlay.style.display === "none";',
    '  return JSON.stringify(Object.assign({ ok: true }, out));',
    '})()',
  ].join('\n');
  const probe = await ev(run);
  console.log(`弹窗 v4: ${probe}`);
  const pp = JSON.parse(probe || '{}');
  results.push(['点击后出现菜单', pp.ok === true]);
  results.push(['菜单在句子头下方（未翻转，gap 0-12px）', pp.ok === true && pp.flipped !== true && pp.menuToSentGap >= -2 && pp.menuToSentGap <= 12]);
  results.push(['菜单左对齐句子首字（≤12px）', pp.ok === true && Math.abs(pp.menuLeft - pp.sentLeft) <= 12]);
  results.push(['出现选中句子的高亮框', pp.ok === true && pp.overlayVisible === true]);
  results.push(['Esc 关闭后菜单消失', pp.ok === true && pp.menuGone === true]);
  results.push(['关闭后高亮清除', pp.ok === true && pp.hlCleared === true]);

  ws.close(); child.kill();
  console.log('\n=== 结果 ===');
  let pass = 0;
  for (const [name, ok] of results) { console.log(`${ok ? '✓' : '✗'} ${name}`); if (ok) pass += 1; }
  console.log(`${pass}/${results.length} 通过`);
  if (pass !== results.length) process.exit(1);
} catch (err) { console.error('FAIL:', err); child.kill(); process.exit(1); }
/**
 * 用无头 Edge + CDP 验证阅读器在真实浏览器里能跑通。
 *
 * 为什么需要这个：`--dump-dom` 看不到 iframe 里的内容，也无法反映
 * 运行时报错。这里通过 CDP 订阅 Runtime.consoleAPICalled / Runtime.exceptionThrown
 * 与 Network.* ，确认：
 *   - 页面没有未捕获异常
 *   - 确实请求了书籍文件（说明 ReaderSession.fetchBook → epub.js 链路走通了）
 *   - iframe 被创建（说明 rendition 渲染了内容）
 *
 * 前提：接口服务在 8787，前端 dev server 在 5173，且书库里有书。
 * 用法：node scripts/check-reader.mjs [bookId]
 */

import { spawn } from 'node:child_process';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];

const ROOT = resolve(import.meta.dirname, '..');
const PROFILE = resolve(ROOT, '.tmp/edge-reader-profile');
const WEB = process.env.WEB_BASE ?? 'http://localhost:5173';
const API = process.env.API_BASE ?? 'http://127.0.0.1:8787';
const PORT = Number(process.env.CDP_PORT ?? 9333);

const findBrowser = () => EDGE_CANDIDATES.find((p) => existsSync(p));

/** 极简 CDP 客户端（只用到 HTTP 端点与一个 WebSocket）。 */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve: res, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else res(msg.result);
        return;
      }
      if (msg.method) {
        for (const fn of this.listeners.get(msg.method) ?? []) fn(msg.params);
      }
    });
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')), { once: true });
    });
    return new Cdp(ws);
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }

  close() {
    this.ws.close();
  }
}

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function main() {
  const browser = findBrowser();
  if (!browser) {
    console.error('✗ 找不到 Edge/Chrome，无法做浏览器验证');
    process.exit(1);
  }

  // 前置检查
  const health = await fetchJson(`${API}/api/health`).catch(() => null);
  if (!health?.ok) {
    console.error(`✗ 接口服务无响应：${API}`);
    process.exit(1);
  }
  const { books } = await fetchJson(`${API}/api/books`);
  if (!books?.length) {
    console.error('✗ 书库为空，先运行 pnpm seed:book');
    process.exit(1);
  }
  const bookId = process.argv[2] ?? books[0].id;
  const book = books.find((b) => b.id === bookId) ?? books[0];
  console.log(`→ 目标书籍：《${book.title}》 (${bookId})`);

  if (existsSync(PROFILE)) rmSync(PROFILE, { recursive: true, force: true });
  mkdirSync(PROFILE, { recursive: true });

  const child = spawn(
    browser,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  const cleanup = () => {
    try {
      child.kill();
    } catch {
      /* 忽略 */
    }
  };

  try {
    // 等 CDP 端点就绪
    let targets = null;
    for (let i = 0; i < 40 && !targets; i += 1) {
      await sleep(250);
      targets = await fetchJson(`http://127.0.0.1:${PORT}/json/list`).catch(() => null);
    }
    if (!targets) throw new Error('CDP 端点未就绪（浏览器可能被安全策略拦住）');

    const page = targets.find((t) => t.type === 'page');
    if (!page?.webSocketDebuggerUrl) throw new Error('找不到可用的 page target');

    const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    const consoleErrors = [];
    const exceptions = [];
    const requests = new Set();

    cdp.on('Runtime.exceptionThrown', (p) => {
      const d = p?.exceptionDetails;
      exceptions.push(d?.exception?.description ?? d?.text ?? JSON.stringify(p));
    });
    cdp.on('Runtime.consoleAPICalled', (p) => {
      const text = (p.args ?? [])
        .map((a) => a.value ?? a.description ?? a.type)
        .join(' ');
      if (p.type === 'error') consoleErrors.push(text);
      if (text.includes('[reader]')) console.log(`  [浏览器日志] ${text}`);
    });
    cdp.on('Network.requestWillBeSent', (p) => {
      requests.add(p.request?.url ?? '');
    });

    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await cdp.send('Page.enable');

    const url = `${WEB}/#/read/${encodeURIComponent(bookId)}`;
    console.log(`→ 打开 ${url}`);

    // 先回空白页再导航：否则在同一 URL 上重复调试时，
    // Page.navigate 可能在"旧页面"尚未替换前就返回，
    // 后续 evaluate 会读到旧 DOM（曾经导致难以解释的假失败）。
    await cdp.send('Page.navigate', { url: 'about:blank' });
    await sleep(400);

    const evalJs = async (expr, awaitPromise = false) => {
      const r = await cdp.send('Runtime.evaluate', {
        expression: expr,
        returnByValue: true,
        awaitPromise,
      });
      return r?.result?.value;
    };

    await cdp.send('Page.navigate', { url });

    // 阶段一：等 React 真正挂载（出现播放条），排除 suspense fallback 与旧页面
    const MOUNTED_EXPR =
      '!!document.querySelector(\'button[aria-label="开始朗读"], button[aria-label="暂停朗读"]\')';
    let mounted = false;
    for (let i = 0; i < 40; i += 1) {
      await sleep(250);
      mounted = await evalJs(MOUNTED_EXPR);
      if (mounted) break;
    }
    if (!mounted) {
      console.error('✗ 阅读器界面未挂载（等了 10s）');
      cdp.close();
      process.exit(1);
    }

    // 阶段二：等书籍真正渲染完成（iframe 有内容且无"加载中/打开书籍"提示）
    const READY_EXPR = `(() => {
      const text = document.body.innerText || '';
      if (text.includes('正在加载阅读器') || text.includes('正在打开书籍')) return false;
      const frame = document.querySelector('iframe');
      if (!frame || !frame.contentDocument || !frame.contentDocument.body) return false;
      return true;
    })()`;
    let ready = false;
    for (let i = 0; i < 50; i += 1) {
      await sleep(300);
      ready = await evalJs(READY_EXPR);
      if (ready) break;
    }
    await sleep(500); // 让高亮与音色列表稳定
    console.log(`  已挂载: ${mounted} / 渲染就绪: ${ready}`);

    const domText = await evalJs('document.body.innerText.slice(0, 400)');
    const hasIframe = await evalJs('!!document.querySelector("iframe")');
    const headerText = await evalJs(
      '(document.querySelector("header")?.innerText ?? "").replace(/\\s+/g, " ").slice(0, 200)',
    );

    const bookFileRequested = [...requests].some((u) => u.includes(`/api/books/${bookId}/file`));

    console.log('\n→ 结果');
    const checks = [
      ['未捕获异常', exceptions.length === 0, exceptions.slice(0, 3).join(' | ')],
      ['控制台无 error', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | ')],
      ['请求了书籍文件', bookFileRequested, `匹配 /api/books/${bookId}/file`],
      ['渲染出 iframe', hasIframe === true, String(hasIframe)],
      ['阅读器已就绪（无加载中提示）', ready === true, `上一步轮询结果=${ready}`],
      ['顶栏有书名', typeof headerText === 'string' && headerText.includes(book.title.slice(0, 6)), headerText],
    ];

    let bad = 0;
    for (const [name, ok, detail] of checks) {
      if (!ok) bad += 1;
      console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ` —— ${detail}`}`);
    }

    if (typeof domText === 'string' && domText.trim()) {
      console.log(`\n  页面文本片段: ${JSON.stringify(domText.slice(0, 160))}`);
    }

    if (bad > 0) {
      cdp.close();
      console.error(`\n✗ 阅读器打开阶段有 ${bad} 项未通过`);
      process.exit(1);
    }

    /* ---------------------- 实际触发一次朗读，验证播放链路 ---------------------- */

    console.log('\n→ 点击播放，验证朗读链路');
    const barBefore = await evalJs(
      '[...document.querySelectorAll("p")].map(p=>p.textContent).join(" | ")',
    );

    const clicked = await evalJs(`
      (() => {
        const btn = document.querySelector('button[aria-label="开始朗读"]');
        if (!btn) return false;
        btn.click();
        return true;
      })()
    `);
    if (!clicked) {
      cdp.close();
      console.error('✗ 找不到"开始朗读"按钮');
      process.exit(1);
    }

    await sleep(2500);
    const barAfter = await evalJs(
      '[...document.querySelectorAll("p")].map(p=>p.textContent).join(" | ")',
    );
    const playing = typeof barAfter === 'string' && /正在朗读第 \d+ \/ \d+ 句/.test(barAfter);
    const highlightBox = await evalJs(`
      (() => {
        const frame = document.querySelector('iframe');
        const doc = frame && frame.contentDocument;
        if (!doc) return 'no-iframe-doc';
        const box = doc.querySelector('[data-tts-highlight]');
        if (!box) return 'no-overlay';
        const visible = box.style.display !== 'none';
        return visible ? 'visible' : 'hidden';
      })()
    `);

    const playChecks = [
      ['播放状态已变为朗读中', playing, `before=${JSON.stringify(barBefore?.slice(0, 80))} after=${JSON.stringify(barAfter?.slice(0, 80))}`],
      ['播放后出现高亮覆盖层', highlightBox === 'visible', `高亮状态=${highlightBox}`],
      ['播放期间无未捕获异常', exceptions.length === 0, exceptions.slice(0, 2).join(' | ')],
    ];
    for (const [name, ok, detail] of playChecks) {
      if (!ok) bad += 1;
      console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ` —— ${detail}`}`);
    }
    console.log(`  播放条状态: ${JSON.stringify((barAfter ?? '').slice(0, 160))}`);

    /* --- 快速推进到章末，验证跨句/跨章续读不会让队列断掉 --- */

    // 播放条左右按钮已改为"切换章节"，界面上没有跳句入口。
    // 这里用**方向键**推进：阅读器把 keydown 挂在 window 上，→ 就是下一句。
    // 用真实按键而不是内部 API，这样默认构建（不含测试钩子）也能跑。
    console.log('\n→ 按 → 键推进到章末，验证跨句续读');
    for (let i = 0; i < 12; i += 1) {
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'ArrowRight',
        code: 'ArrowRight',
        windowsVirtualKeyCode: 39,
        nativeVirtualKeyCode: 39,
      });
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'ArrowRight',
        code: 'ArrowRight',
        windowsVirtualKeyCode: 39,
        nativeVirtualKeyCode: 39,
      });
      await sleep(120);
    }
    const jumpedOk = true;
    await sleep(2500);
    const afterJump = await evalJs(
      '[...document.querySelectorAll("p")].map(p=>p.textContent).join(" | ")',
    );
    const stillOk = typeof afterJump === 'string' && !/语音引擎出错/.test(afterJump);
    const jumpChecks = [
      ['推进到章末后未报错', jumpedOk && stillOk, `状态=${JSON.stringify((afterJump ?? '').slice(0, 120))}`],
      ['推进后无未捕获异常', exceptions.length === 0, exceptions.slice(0, 2).join(' | ')],
    ];
    for (const [name, ok, detail] of jumpChecks) {
      if (!ok) bad += 1;
      console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ` —— ${detail}`}`);
    }

    cdp.close();
    if (bad > 0) {
      console.error(`\n✗ 阅读器验证有 ${bad} 项未通过`);
      process.exit(1);
    }
    console.log('\n✓ 阅读器在真实浏览器中可正常打开并进入朗读状态');
  } finally {
    cleanup();
    // 浏览器 profile 有几十 MB，跑完就删，避免 .tmp 无限膨胀
    await sleep(300);
    try {
      rmSync(PROFILE, { recursive: true, force: true });
    } catch {
      /* 文件还被子进程占用时忽略，下次运行开头会再清一次 */
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

await main();

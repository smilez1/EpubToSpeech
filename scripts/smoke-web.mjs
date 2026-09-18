/**
 * 前端冒烟测试（Node 侧，无需浏览器）。
 *
 * 三层检查：
 *  1) 转译层：向正在运行的 Vite dev server 请求每个模块，确认 JSX/TS、`@/`、`@shared/`
 *     别名与 Tailwind 都能被正确转译（失败会返回非 2xx 或错误页）。
 *  2) 加载层：把 Vite 转译结果里的 `/node_modules/.vite/deps/*` 重写回 node_modules，
 *     真正 import 一次 parseEpub，确认模块能被求值。
 *  3) 逻辑层：用真实 epub 跑 parseEpub，配一个最小 DOMParser（Node 没有），
 *     逐项核对书名/作者/语言/章节数/目录条目。
 *
 * 前提：Vite dev server 已在 http://localhost:5173 运行，且 .tmp/sample.epub 已生成。
 * 用法：node scripts/smoke-web.mjs
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripTypeScriptTypes, registerHooks } from 'node:module';

const BASE = process.env.WEB_BASE ?? 'http://localhost:5173';
const ROOT = resolve(import.meta.dirname, '..');
const TMP = resolve(ROOT, '.tmp');

/* ------------------------------- 1. 转译层检查 ------------------------------- */

const MODULES = [
  '/src/web/main.tsx',
  '/src/web/App.tsx',
  '/src/web/api.ts',
  '/src/web/styles.css',
  '/src/web/components/BookCard.tsx',
  '/src/web/components/Cover.tsx',
  '/src/web/components/PlayerBar.tsx',
  '/src/web/epub/parseEpub.ts',
  '/src/web/pages/LibraryPage.tsx',
  '/src/web/pages/ReaderPage.tsx',
  '/src/web/reader/highlight.ts',
  '/src/web/reader/sentences.ts',
  '/src/web/reader/session.ts',
  '/src/web/store/library.ts',
  '/src/web/store/readerPrefs.ts',
  '/src/web/tts/WebSpeechEngine.ts',
  '/src/web/tts/chunk.ts',
  '/src/web/tts/player.ts',
  '/src/web/tts/range.ts',
  '/src/web/tts/speech.ts',
  '/src/web/tts/types.ts',
];

async function checkTransforms() {
  const paths = [
    ...MODULES,
    // M2 渲染会用到 epub.js。这里确认 Vite 能解析并预构建这个包，
    // 避免到 M2 才发现依赖装不上或导出形态不对。
    '/node_modules/.vite/deps/epubjs.js',
  ];

  // 预热：先让 Vite 预构建 epubjs，否则 deps 路径可能尚未生成
  await fetch(`${BASE}/@id/epubjs`).catch(() => undefined);

  const failures = [];
  for (const p of paths) {
    let res;
    try {
      res = await fetch(`${BASE}${p}`);
    } catch (err) {
      failures.push({ path: p, status: 0, body: `请求失败: ${err.message}` });
      continue;
    }
    const body = await res.text();
    const bad =
      !res.ok ||
      body.includes('Internal server error') ||
      body.includes('Pre-transform error') ||
      body.includes('Failed to resolve import');
    // epubjs 的预构建产物如果没生成，Vite 会返回 404 —— 单独判断，避免误报
    if (p.includes('epubjs') && res.status === 404) {
      failures.push({ path: p, status: 404, body: 'epubjs 未被 Vite 预构建（M2 前需确认）' });
      continue;
    }
    if (bad) failures.push({ path: p, status: res.status, body: body.slice(0, 900) });
  }
  return { failures, total: paths.length };
}

/* ------------------------ 2. 让 Vite 的裸依赖写法能在 Node 解析 ------------------------ */

/**
 * Vite 会把 `import JSZip from 'jszip'` 重写成 `/node_modules/.vite/deps/jszip.js`。
 * 这些 URL 在 Node 里无法解析，这里把它们映射回 node_modules 的真实文件。
 */
const DEP_PREFIX = '/node_modules/.vite/deps/';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(DEP_PREFIX)) {
      const file = specifier.slice(DEP_PREFIX.length).replace(/[?&].*$/, '');
      const guesses = [
        resolve(ROOT, 'node_modules', file),
        // 预构建产物的真实位置在 .vite/deps 下，也可能带 hash 后缀
        resolve(ROOT, 'node_modules/.vite/deps', file),
      ];
      for (const g of guesses) {
        if (existsSync(g)) return { url: pathToFileURL(g).href, shortCircuit: true };
      }
      // 找不到就退回裸包名（去掉 hash）
      const pkg = file.replace(/-[A-Za-z0-9_]{8}\.js$/, '').replace(/\.js$/, '');
      return nextResolve(pkg, context);
    }
    return nextResolve(specifier, context);
  },
});

/* --------------------------- 3. 最小 DOMParser 桩 --------------------------- */

/**
 * 够用的 XML DOM：支持 parseEpub 用到的
 * getElementsByTagName(NS) / querySelector / children / attributes / textContent。
 */
function installDomStub() {
  class El {
    constructor(localName, namespaceURI) {
      this.localName = localName;
      this.namespaceURI = namespaceURI;
      this.children = [];
      this.attributes = {};
      /** 属性名 → 命名空间，供 getAttributeNS 使用（简化版不做前缀解析）。 */
      this.attrNs = {};
      this._text = '';
    }
    get textContent() {
      return this._text + this.children.map((c) => c.textContent).join('');
    }
    set textContent(v) {
      this._text = v;
    }
    getAttribute(n) {
      return Object.prototype.hasOwnProperty.call(this.attributes, n) ? this.attributes[n] : null;
    }
    getAttributeNS(_ns, n) {
      return this.getAttribute(n);
    }
    _descendants(out = []) {
      for (const c of this.children) {
        out.push(c);
        c._descendants(out);
      }
      return out;
    }
    getElementsByTagName(localName) {
      return this._descendants().filter((e) => e.localName === localName);
    }
    getElementsByTagNameNS(ns, localName) {
      return this._descendants().filter(
        (e) => e.localName === localName && (ns === '*' || e.namespaceURI === ns),
      );
    }
    querySelector(sel) {
      const m = /^([a-zA-Z]+)$/.exec(sel.trim());
      return m ? (this.getElementsByTagName(m[1].toLowerCase())[0] ?? null) : null;
    }
    querySelectorAll() {
      return [];
    }
  }

  /**
   * 极简但带命名空间的 XML 解析。
   * 关键点：parseEpub 大量用 getElementsByTagNameNS，桩必须正确解析
   * xmlns / xmlns:prefix 声明，并据此给元素与属性赋 namespaceURI。
   */
  function parseXml(text) {
    const root = new El('#document', null);
    const NS = { xml: 'http://www.w3.org/XML/1998/namespace' };
    const stack = [root];
    const nsStack = [{ ...NS }];

    const re =
      /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([A-Za-z0-9:_.-]+)\s*>|<([A-Za-z0-9:_.-]+)((?:\s+[^>]*?)?)\/?>|([^<]+)/g;

    let m;
    while ((m = re.exec(text)) !== null) {
      const [full, closeTag, openTag, attrsRaw, textNode] = m;

      if (closeTag) {
        if (stack.length > 1) {
          stack.pop();
          nsStack.pop();
        }
        continue;
      }

      if (openTag) {
        const parentNs = nsStack[nsStack.length - 1];
        const scope = { ...parentNs };

        // 先收集本元素上的命名空间声明
        const rawAttrs = [];
        const attrRe = /([A-Za-z0-9:_.-]+)\s*=\s*"([^"]*)"/g;
        let a;
        while ((a = attrRe.exec(attrsRaw ?? '')) !== null) rawAttrs.push([a[1], a[2]]);
        for (const [name, value] of rawAttrs) {
          if (name === 'xmlns') scope[''] = value;
          else if (name.startsWith('xmlns:')) scope[name.slice(6)] = value;
        }

        const el = new El(localNameOf(openTag), nsOf(openTag, scope));
        for (const [name, value] of rawAttrs) {
          el.attributes[name] = value;
          if (!name.startsWith('xmlns')) el.attrNs[name] = nsOf(name, scope);
        }

        stack[stack.length - 1].children.push(el);
        if (!/\/\s*$/.test(full)) {
          stack.push(el);
          nsStack.push(scope);
        }
        continue;
      }

      if (textNode && textNode.trim()) {
        stack[stack.length - 1]._text += textNode;
      }
    }

    // documentElement：真实 DOMParser 上总是存在的
    root.documentElement = root.children.find((c) => c.localName !== '#text') ?? null;
    return root;
  }

  function localNameOf(qname) {
    const i = qname.indexOf(':');
    return (i === -1 ? qname : qname.slice(i + 1)).toLowerCase();
  }

  function nsOf(qname, scope) {
    const i = qname.indexOf(':');
    const prefix = i === -1 ? '' : qname.slice(0, i);
    return scope[prefix] ?? null;
  }

  globalThis.DOMParser = class {
    parseFromString(text) {
      const doc = parseXml(text);
      doc.querySelector = () => null;
      return doc;
    }
  };
}

/* ---------------------------------- 主流程 ---------------------------------- */

async function main() {
  const health = await fetch(`${BASE}/api/health`).catch(() => null);
  if (!health?.ok) {
    console.error(`✗ ${BASE} 无响应，请先启动 pnpm dev:web`);
    process.exit(1);
  }
  console.log(`✓ dev server 在跑: ${BASE}`);

  console.log(`\n→ 检查模块转译（含 epub.js 预构建）`);
  const { failures, total } = await checkTransforms();
  if (failures.length) {
    for (const f of failures) {
      console.error(`  [FAIL] ${f.path} (HTTP ${f.status})`);
      console.error(f.body);
    }
    console.error(`\n✗ ${failures.length}/${total} 项转译失败`);
    process.exit(1);
  }
  console.log(`  ${total}/${total} 全部通过`);

  // 逻辑层：用真实 epub 验证解析器
  console.log('\n→ 用真实 EPUB 验证 parseEpub');
  const epubPath = resolve(ROOT, '.tmp/sample.epub');
  if (!existsSync(epubPath)) {
    console.error(`  [SKIP] 找不到 ${epubPath}，请先运行 scripts/make-epub 相关脚本`);
    process.exit(0);
  }
  const bytes = await readFile(epubPath);

  // 直接取 Vite 的转译结果：别名与依赖重写都已由 Vite 处理完
  const res = await fetch(`${BASE}/src/web/epub/parseEpub.ts`);
  if (!res.ok) {
    console.error(`  [FAIL] 无法从 Vite 取到 parseEpub (HTTP ${res.status})`);
    process.exit(1);
  }
  const transformed = await res.text();

  // Vite 产出的是 TS，Node 需要擦除类型后才能作为 ESM 执行（纯 JS API，无需子进程）
  const js = stripTypeScriptTypes(transformed, { mode: 'strip' });

  await mkdir(TMP, { recursive: true });
  const tmpFile = resolve(TMP, 'parseEpub.smoke.mjs');
  await writeFile(tmpFile, js, 'utf8');

  installDomStub();

  const { parseEpub, tocEntryCount } = await import(pathToFileURL(tmpFile).href);

  const file = new File([bytes], 'sample.epub', { type: 'application/epub+zip' });
  const parsed = await parseEpub(file);

  const expect = {
    书名: '测试书籍：语音朗读样例',
    作者: '测试作者',
    语言: 'zh-CN',
    章节数: 2,
    目录条目: 2,
  };
  const actual = {
    书名: parsed.title,
    作者: parsed.author,
    语言: parsed.language,
    章节数: parsed.chapterCount,
    目录条目: tocEntryCount(parsed.toc),
  };

  let bad = 0;
  for (const [k, want] of Object.entries(expect)) {
    const got = actual[k];
    const ok = got === want;
    if (!ok) bad += 1;
    console.log(`  ${ok ? '✓' : '✗'} ${k}: ${got}${ok ? '' : ` (期望 ${want})`}`);
  }
  console.log(`  目录内容: ${JSON.stringify(parsed.toc.map((t) => t.label))}`);
  console.log(`  警告: ${parsed.warnings.length ? parsed.warnings.join(' / ') : '无'}`);

  if (bad > 0) {
    console.error(`\n✗ 解析结果有 ${bad} 项与预期不符`);
    process.exit(1);
  }
  console.log('\n✓ 前端冒烟测试通过');
}

await main();

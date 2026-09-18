/**
 * 把样例 EPUB 导入书库，并写入与书内一致的中文元数据。
 *
 * 用法：node scripts/seed-sample-book.mjs
 *
 * 说明：这里不调用 epub.js 做交叉核对——epub.js 是浏览器库，它的加载链在 Node 下
 * 会停在 unsettled promise（需要 DOM/网络环境），强行 shim 不值得。
 * epub.js 的可用性改由 scripts/smoke-web.mjs 验证的路径覆盖：确认 Vite 能解析
 * 并预构建它（M2 渲染会用到）。此处只负责把样例数据落进书库。
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

const BASE = process.env.API_BASE ?? 'http://127.0.0.1:8787';
const ROOT = resolve(import.meta.dirname, '..');
const EPUB = resolve(ROOT, '.tmp/sample.epub');

/** 与 scripts/make-sample-epub.mjs 里写进 OPF/nav 的内容保持一致。 */
const EXPECT = {
  title: '测试书籍：语音朗读样例',
  author: '测试作者',
  language: 'zh-CN',
  publisher: '本地测试',
  chapterCount: 2,
  toc: [
    { label: '第一章 起点', href: 'OEBPS/chapter1.xhtml' },
    { label: '第二章 途中', href: 'OEBPS/chapter2.xhtml' },
  ],
};

async function main() {
  if (!existsSync(EPUB)) {
    console.error(`✗ 找不到 ${EPUB}，请先运行 pnpm sample:epub`);
    process.exit(1);
  }
  const health = await fetch(`${BASE}/api/health`).catch(() => null);
  if (!health?.ok) {
    console.error(`✗ ${BASE} 无响应，请先启动 pnpm dev:api`);
    process.exit(1);
  }

  const bytes = await readFile(EPUB);

  // 1. 导入
  const form = new FormData();
  form.append('file', new File([bytes], 'sample.epub', { type: 'application/epub+zip' }));
  const upRes = await fetch(`${BASE}/api/books`, { method: 'POST', body: form });
  if (!upRes.ok) {
    console.error(`✗ 上传失败 HTTP ${upRes.status}: ${await upRes.text()}`);
    process.exit(1);
  }
  const { book, deduped } = await upRes.json();
  console.log(`→ ${deduped ? '书已在库中（sha256 去重命中）' : '新导入'} id=${book.id}`);

  // 2. 写入中文元数据
  const patchRes = await fetch(`${BASE}/api/books/${book.id}/meta`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: EXPECT.title,
      author: EXPECT.author,
      language: EXPECT.language,
      publisher: EXPECT.publisher,
      chapterCount: EXPECT.chapterCount,
      toc: EXPECT.toc,
    }),
  });
  if (!patchRes.ok) {
    console.error(`✗ 元数据写入失败 HTTP ${patchRes.status}: ${await patchRes.text()}`);
    process.exit(1);
  }
  const patched = (await patchRes.json()).book;

  // 3. 重新读回来校验，而不是相信 PATCH 的返回值
  const list = await (await fetch(`${BASE}/api/books`)).json();
  const reread = list.books.find((b) => b.id === book.id);

  let bad = 0;
  const check = (label, got, want) => {
    const ok = got === want;
    if (!ok) bad += 1;
    console.log(`  ${ok ? '✓' : '✗'} ${label}: ${JSON.stringify(got)}${ok ? '' : ` (期望 ${JSON.stringify(want)})`}`);
  };
  console.log('→ 回读校验');
  check('书名', reread?.title, EXPECT.title);
  check('作者', reread?.author, EXPECT.author);
  check('语言', reread?.language, EXPECT.language);
  check('出版社', reread?.publisher, EXPECT.publisher);
  check('章节数', reread?.chapterCount, EXPECT.chapterCount);
  check('目录条目数', reread?.toc?.length, EXPECT.toc.length);
  check('目录首条', reread?.toc?.[0]?.label, EXPECT.toc[0].label);
  check('metaParsed', reread?.metaParsed, true);
  console.log(`  目录: ${JSON.stringify(reread?.toc?.map((t) => t.label))}`);

  // 4. 确认 epub 原文可取（M2 要拿它交给 epub.js）
  const fileRes = await fetch(`${BASE}/api/books/${book.id}/file`);
  check('epub 文件可下载', fileRes.status, 200);
  check('epub 字节数', Number(fileRes.headers.get('content-length')), bytes.length);
  void patched;

  if (bad > 0) {
    console.error(`\n✗ 有 ${bad} 项校验未通过`);
    process.exit(1);
  }
  console.log('\n✓ 样例书已就绪，打开 http://localhost:5173 即可在书架看到它');
}

await main();

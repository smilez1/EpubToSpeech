/**
 * 中文（UTF-8）端到端往返测试。
 *
 * 背景：用 PowerShell 5.1 的 Invoke-RestMethod -Body <string> 发 JSON 时，
 * 会按本地代码页编码，中文会被写成字面 '?' 落盘。那是测试手段的问题，
 * 不是服务端的问题。这个脚本用 fetch 明确按 UTF-8 发送，验证：
 *   上传 → PATCH 元数据（中文书名/作者/目录）→ 重新读取，字符完全无损。
 *
 * 用法：node scripts/check-utf8.mjs
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

const BASE = process.env.API_BASE ?? 'http://127.0.0.1:8787';
const ROOT = resolve(import.meta.dirname, '..');

const TITLE = '中文书名测试：《论语》选段——附注';
const AUTHOR = '测试作者·张三';
const TOC = [
  { label: '第一章 学而时习之', href: 'OEBPS/chapter1.xhtml' },
  { label: '第二章 为政以德', href: 'OEBPS/chapter2.xhtml' },
];

function assertEqual(label, got, want) {
  const ok = got === want;
  console.log(`  ${ok ? '✓' : '✗'} ${label}: ${JSON.stringify(got)}${ok ? '' : ` (期望 ${JSON.stringify(want)})`}`);
  return ok;
}

async function main() {
  const health = await fetch(`${BASE}/api/health`).catch(() => null);
  if (!health?.ok) {
    console.error(`✗ ${BASE} 无响应，请先启动 pnpm dev:api`);
    process.exit(1);
  }

  const epubPath = resolve(ROOT, '.tmp/sample.epub');
  if (!existsSync(epubPath)) {
    console.error(`✗ 找不到 ${epubPath}，请先运行 pnpm sample:epub`);
    process.exit(1);
  }

  // 1. 上传
  // 注意：书籍 id 是内容 sha256，同一份样例文件重复上传会命中服务端去重，
  // 拿回的是"旧记录"（它的 originalFileName 是首次导入时的值），
  // 那样断言 originalFileName 就会误报。这里往末尾追加一个唯一标记，
  // 保证每次都是全新内容（zip 末尾的注释字节不影响解析）。
  const bytes = await readFile(epubPath);
  const unique = Buffer.from(`\n<!-- utf8-check-${Date.now()}-${Math.random()} -->\n`, 'utf8');
  const payload = new Uint8Array(bytes.length + unique.length);
  payload.set(bytes, 0);
  payload.set(unique, bytes.length);

  const form = new FormData();
  form.append('file', new File([payload], '中文测试.epub', { type: 'application/epub+zip' }));
  const upRes = await fetch(`${BASE}/api/books`, { method: 'POST', body: form });
  if (!upRes.ok) {
    console.error(`✗ 上传失败 HTTP ${upRes.status}: ${await upRes.text()}`);
    process.exit(1);
  }
  const { book, deduped } = await upRes.json();
  if (deduped) {
    console.error('✗ 期望全新导入，却命中了去重（测试夹具不唯一）');
    process.exit(1);
  }
  console.log(`✓ 上传成功 id=${book.id}`);
  console.log(`  服务端记录的原始文件名: ${JSON.stringify(book.originalFileName)}`);

  let ok = true;
  ok = assertEqual('originalFileName 中文无损', book.originalFileName, '中文测试.epub') && ok;

  // 2. PATCH 中文元数据（fetch 会以 UTF-8 编码 body）
  const patchRes = await fetch(`${BASE}/api/books/${book.id}/meta`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: TITLE, author: AUTHOR, language: 'zh-CN', toc: TOC, chapterCount: 2 }),
  });
  if (!patchRes.ok) {
    console.error(`✗ PATCH 失败 HTTP ${patchRes.status}: ${await patchRes.text()}`);
    process.exit(1);
  }
  const patched = (await patchRes.json()).book;

  // 3. 重新从列表读取，确认不是本地乐观结果
  const list = await (await fetch(`${BASE}/api/books`)).json();
  const reread = list.books.find((b) => b.id === book.id);

  console.log('\n→ 校验往返后的字符');
  ok = assertEqual('title（PATCH 返回值）', patched.title, TITLE) && ok;
  ok = assertEqual('author（PATCH 返回值）', patched.author, AUTHOR) && ok;
  ok = assertEqual('title（重新读取）', reread?.title, TITLE) && ok;
  ok = assertEqual('author（重新读取）', reread?.author, AUTHOR) && ok;
  ok = assertEqual('toc[0].label', reread?.toc?.[0]?.label, TOC[0].label) && ok;
  ok = assertEqual('toc[1].label', reread?.toc?.[1]?.label, TOC[1].label) && ok;

  // 4. 直接读 index.json，确认落盘文件本身也是 UTF-8
  const onDisk = JSON.parse(await readFile(resolve(ROOT, 'data/index.json'), 'utf8'));
  const diskBook = onDisk.find((b) => b.id === book.id);
  console.log('\n→ 校验落盘文件（data/index.json）');
  ok = assertEqual('落盘 title', diskBook?.title, TITLE) && ok;
  ok = assertEqual('落盘 author', diskBook?.author, AUTHOR) && ok;

  // 5. 清理测试数据
  const delRes = await fetch(`${BASE}/api/books/${book.id}`, { method: 'DELETE' });
  console.log(`\n→ 清理测试书籍: HTTP ${delRes.status}`);

  if (!ok) {
    console.error('\n✗ UTF-8 往返存在字符损坏');
    process.exit(1);
  }
  console.log('\n✓ UTF-8 中文往返无损');
}

await main();

/**
 * 诊断章节/目录错位：把书库里的目录树与 epub.js 的 spine 对照起来，
 * 看「目录第 N 项」与「正文第 N 节」是否真的一一对应。
 *
 * 用法：node scripts/diagnose-toc.mjs [bookId] [看多少条]
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import JSZip from 'jszip';

const ROOT = resolve(import.meta.dirname, '..');
const API = process.env.API_BASE ?? 'http://127.0.0.1:8787';

const books = await (await fetch(`${API}/api/books`)).json();
const book = process.argv[2]
  ? books.books.find((b) => b.id === process.argv[2])
  : books.books[0];
if (!book) {
  console.error('✗ 找不到书');
  process.exit(1);
}
const limit = Number(process.argv[3] ?? 12);

console.log(`书：《${book.title}》  id=${book.id}`);
console.log(`chapterCount=${book.chapterCount}  toc 顶层项=${book.toc?.length ?? 0}`);
console.log(`进度: chapterIndex=${book.progress?.chapterIndex} percent=${book.progress?.percent}`);

/* ---------- 1. 书库里的目录（前端解析并回填的） ---------- */

const flatten = (list, depth = 0, out = []) => {
  for (const e of list ?? []) {
    out.push({ depth, label: e.label, href: e.href });
    if (e.children?.length) flatten(e.children, depth + 1, out);
  }
  return out;
};
const tocFlat = flatten(book.toc);

console.log(`\n=== 书库目录（拍平后共 ${tocFlat.length} 项）前 ${limit} 条 ===`);
tocFlat.slice(0, limit).forEach((e, i) => {
  console.log(`  [${String(i).padStart(3)}] ${'  '.repeat(e.depth)}${e.label}   -> ${e.href}`);
});

/* ---------- 2. 直接从 epub 里读 OPF spine（正文真实顺序） ---------- */

const zip = await JSZip.loadAsync(await readFile(resolve(ROOT, 'data/books', `${book.id}.epub`)));
const containerXml = await zip.file('META-INF/container.xml').async('text');
const opfPath = /full-path="([^"]+)"/.exec(containerXml)?.[1];
const opf = await zip.file(opfPath).async('text');

const manifest = new Map();
for (const m of opf.matchAll(/<item\b[^>]*>/g)) {
  const tag = m[0];
  const id = /id="([^"]+)"/.exec(tag)?.[1];
  const href = /href="([^"]+)"/.exec(tag)?.[1];
  if (id && href) manifest.set(id, href);
}

const spine = [];
for (const m of opf.matchAll(/<itemref\b[^>]*>/g)) {
  const idref = /idref="([^"]+)"/.exec(m[0])?.[1];
  if (idref) spine.push(manifest.get(idref));
}

console.log(`\n=== OPF spine（正文真实顺序，共 ${spine.length} 节）前 ${limit} 条 ===`);
spine.slice(0, limit).forEach((href, i) => {
  console.log(`  [${String(i).padStart(3)}] ${href}`);
});

/* ---------- 3. 逐项对照 ---------- */

console.log(`\n=== 对照：目录项 i  vs  spine 第 i 节 ===`);
let mismatch = 0;
for (let i = 0; i < Math.min(tocFlat.length, spine.length, limit); i += 1) {
  const label = tocFlat[i].label;
  const tocHref = (tocFlat[i].href ?? '').split('/').pop();
  const spineHref = (spine[i] ?? '').split('/').pop();
  const same = tocHref && spineHref && tocHref === spineHref;
  if (!same) mismatch += 1;
  console.log(
    `  ${same ? '✓' : '✗'} [${i}] 目录「${label}」(${tocHref})   spine: ${spineHref}`,
  );
}

const total = Math.min(tocFlat.length, spine.length);
console.log(
  `\n结论：前 ${total} 项里 ${mismatch} 项不对应` +
    (total > limit ? `（只看了 ${limit} 项，下面统计全量）` : ''),
);

/* ---------- 4. 全量统计 ---------- */

// 用「目录项的 href 在 spine 中的位置」建立正确映射，看偏差分布
const spineIndexByHref = new Map();
spine.forEach((h, i) => {
  if (h) spineIndexByHref.set(h.split('/').pop(), i);
});

let mapped = 0;
let unmapped = 0;
const offsets = new Map();
tocFlat.forEach((e, i) => {
  const key = (e.href ?? '').split('/').pop();
  const si = spineIndexByHref.get(key);
  if (si === undefined) {
    unmapped += 1;
    return;
  }
  mapped += 1;
  const off = si - i;
  offsets.set(off, (offsets.get(off) ?? 0) + 1);
});

console.log(`\n=== 全量 ===`);
console.log(`  目录项 ${tocFlat.length} 条，能在 spine 里找到的 ${mapped} 条，找不到的 ${unmapped} 条`);
console.log(`  目录序号 i 与 spine 序号 si 的差值分布（差值→条数）：`);
for (const [off, count] of [...offsets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
  console.log(`     si - i = ${String(off).padStart(4)}  →  ${count} 条`);
}

/* ---------- 5. 哪些 spine 节没有被目录覆盖（这些节用序号取标题必然错位） ---------- */

const tocHrefs = new Set(tocFlat.map((e) => (e.href ?? '').split('/').pop()).filter(Boolean));
const uncovered = [];
spine.forEach((h, i) => {
  const key = (h ?? '').split('/').pop();
  if (!tocHrefs.has(key)) uncovered.push(`${i}:${key}`);
});
console.log(`\n=== 目录未覆盖的 spine 节（共 ${uncovered.length} 个）===`);
console.log('  ' + (uncovered.slice(0, 20).join('  ') || '（无）'));

/* ---------- 6. 用 href 映射校验：spine 第 106 节到底该叫什么 ---------- */

const labelByHref = new Map();
tocFlat.forEach((e) => {
  const key = (e.href ?? '').split('/').pop();
  if (key && !labelByHref.has(key)) labelByHref.set(key, e.label);
});
console.log('\n=== 用 href 匹配（正确做法）观察第 104~108 节 ===');
for (let i = 104; i <= 108; i += 1) {
  const href = spine[i];
  if (!href) continue;
  const key = href.split('/').pop();
  const byHref = labelByHref.get(key) ?? '(目录未覆盖)';
  const byIndex = tocFlat[i]?.label ?? '(越界)';
  console.log(`  spine[${i}] ${key}`);
  console.log(`     按 href 取名 → ${byHref}`);
  console.log(`     按序号取名 → ${byIndex}   ${byHref === byIndex ? '' : '❌ 不一致'}`);
}

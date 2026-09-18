/**
 * 设置某本书的阅读进度，用于测试断点续读与失效 CFI 回退。
 *
 * 用法：
 *   node scripts/set-progress.mjs <bookId> <percent> [cfi]
 *   node scripts/set-progress.mjs <bookId> --corrupt    写入一个必然失效的 CFI
 *   node scripts/set-progress.mjs <bookId> --clear      清空进度
 */

const API = process.env.API_BASE ?? 'http://127.0.0.1:8787';

const [bookId, mode, maybeCfi] = process.argv.slice(2);
if (!bookId) {
  console.error('用法: node scripts/set-progress.mjs <bookId> <percent|--corrupt|--clear> [cfi]');
  process.exit(1);
}

const books = await (await fetch(`${API}/api/books`)).json();
const book = books.books.find((b) => b.id === bookId);
if (!book) {
  console.error(`✗ 书库中找不到 ${bookId}`);
  process.exit(1);
}

if (mode === '--clear') {
  // 光把 percent 设成 0 是不够的：阅读器恢复位置时**优先用 href/cfi**，
  // 残留的 href 会让它又跳回上次的章节（实测踩到过：percent=0 却仍在最后一章）。
  // 服务端把空串当普通字符串写入，因此传空串即可清掉。
  const res = await fetch(`${API}/api/books/${bookId}/progress`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      percent: 0,
      cfi: '',
      href: '',
      chapterIndex: 0,
      sentenceIndex: 0,
    }),
  });
  const body = await res.json().catch(() => ({}));
  const p = body.book?.progress;
  console.log(
    `→ 已清空进度: HTTP ${res.status}  percent=${p?.percent ?? '?'} href=${JSON.stringify(p?.href ?? null)}`,
  );
} else {
  const percent = mode === '--corrupt' ? 0.5 : Number(mode);
  if (Number.isNaN(percent)) {
    console.error(`✗ 无法解析 percent: ${mode}`);
    process.exit(1);
  }
  // 故意构造一个结构上"像" CFI 但指向不存在内容的路径
  const cfi = mode === '--corrupt' ? 'epubcfi(/6/999999!/4/9999/9999)' : maybeCfi;

  const res = await fetch(`${API}/api/books/${bookId}/progress`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      percent,
      cfi,
      href: mode === '--corrupt' ? undefined : maybeCfi ? undefined : 'OEBPS/chapter1.xhtml',
      chapterIndex: 0,
      sentenceIndex: 0,
    }),
  });
  const body = await res.json();
  console.log(
    `→ 《${book.title}》进度已设为 ${Math.round((body.book?.progress?.percent ?? percent) * 100)}%，cfi=${JSON.stringify(cfi ?? null)}`,
  );
}

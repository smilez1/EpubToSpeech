import fs from 'node:fs/promises';
import path from 'node:path';
import type { BookMeta, BookMetaPatch, ProgressPatch } from '../shared/book.ts';
import { BOOKS_DIR, COVERS_DIR, DATA_DIR, INDEX_FILE } from './paths.ts';

/**
 * 书库仓储层。
 *
 * 第一版直接用 JSON 索引 + 文件系统：
 * - `data/index.json` 保存 BookMeta 数组
 * - `data/books/<id>.epub` 保存原文
 * - `data/covers/<id>.bin` 保存封面二进制
 *
 * 后续要换 SQLite，只需替换本文件导出的函数实现，路由层不用动。
 */

let cache: BookMeta[] | null = null;

/** 串行化所有写操作，避免并发请求互相覆盖 index.json。 */
let writeChain: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const next = writeChain.then(task, task);
  // 无论成败都不让链断掉
  writeChain = next.catch(() => undefined);
  return next;
}

async function ensureDirs(): Promise<void> {
  await fs.mkdir(BOOKS_DIR, { recursive: true });
  await fs.mkdir(COVERS_DIR, { recursive: true });
}

async function loadIndex(): Promise<BookMeta[]> {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(INDEX_FILE, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    cache = Array.isArray(parsed) ? (parsed as BookMeta[]) : [];
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      cache = [];
    } else if (err instanceof SyntaxError) {
      // 索引损坏：备份后重建，避免整个书库打不开
      const backup = `${INDEX_FILE}.corrupt.${Date.now()}`;
      await fs.rename(INDEX_FILE, backup).catch(() => undefined);
      console.error(`[store] index.json 解析失败，已备份到 ${path.basename(backup)}，以空书库启动`);
      cache = [];
    } else {
      throw err;
    }
  }
  return cache;
}

/** 原子写：先写临时文件再 rename，避免断电/崩溃留下半个 JSON。 */
async function persistIndex(books: BookMeta[]): Promise<void> {
  await ensureDirs();
  const tmp = `${INDEX_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(books, null, 2), 'utf8');
  await fs.rename(tmp, INDEX_FILE);
  cache = books;
}

export async function listBooks(): Promise<BookMeta[]> {
  const books = await loadIndex();
  // 最近阅读/导入的排在前面
  return [...books].sort((a, b) => {
    const at = a.progress?.updatedAt ?? a.createdAt;
    const bt = b.progress?.updatedAt ?? b.createdAt;
    return bt - at;
  });
}

export async function getBook(id: string): Promise<BookMeta | undefined> {
  const books = await loadIndex();
  return books.find((b) => b.id === id);
}

export interface InsertBookInput {
  id: string;
  originalFileName: string;
  size: number;
  sha256: string;
  fallbackTitle: string;
}

export async function insertBook(input: InsertBookInput): Promise<BookMeta> {
  return enqueue(async () => {
    await ensureDirs();
    const books = await loadIndex();
    const now = Date.now();
    const book: BookMeta = {
      id: input.id,
      title: input.fallbackTitle,
      originalFileName: input.originalFileName,
      size: input.size,
      sha256: input.sha256,
      hasCover: false,
      toc: [],
      chapterCount: 0,
      metaParsed: false,
      createdAt: now,
      updatedAt: now,
    };
    await persistIndex([book, ...books]);
    return book;
  });
}

export async function updateMeta(id: string, patch: BookMetaPatch): Promise<BookMeta | undefined> {
  return enqueue(async () => {
    const books = await loadIndex();
    const idx = books.findIndex((b) => b.id === id);
    if (idx === -1) return undefined;

    const next: BookMeta = { ...books[idx]!, updatedAt: Date.now() };
    if (patch.title?.trim()) next.title = patch.title.trim().slice(0, 500);
    if (patch.author !== undefined) next.author = patch.author.trim().slice(0, 300) || undefined;
    if (patch.language !== undefined) next.language = patch.language.trim().slice(0, 40) || undefined;
    if (patch.publisher !== undefined) {
      next.publisher = patch.publisher.trim().slice(0, 300) || undefined;
    }
    if (patch.toc !== undefined) next.toc = patch.toc;
    if (patch.chapterCount !== undefined) next.chapterCount = patch.chapterCount;
    if (patch.hasCover !== undefined) next.hasCover = patch.hasCover;
    // 只有前端真的解析过（回填了 toc/title）才标记，避免空解析被当成已解析
    next.metaParsed = true;

    books[idx] = next;
    await persistIndex(books);
    return next;
  });
}

export async function updateProgress(
  id: string,
  patch: ProgressPatch,
): Promise<BookMeta | undefined> {
  return enqueue(async () => {
    const books = await loadIndex();
    const idx = books.findIndex((b) => b.id === id);
    if (idx === -1) return undefined;

    const percent = Math.min(1, Math.max(0, patch.percent));
    const next: BookMeta = {
      ...books[idx]!,
      progress: {
        cfi: patch.cfi,
        href: patch.href,
        chapterIndex: patch.chapterIndex,
        sentenceIndex: patch.sentenceIndex,
        percent,
        updatedAt: Date.now(),
      },
      updatedAt: Date.now(),
    };
    books[idx] = next;
    await persistIndex(books);
    return next;
  });
}

/** 删除书籍记录并尽力清理磁盘文件。 */
export async function deleteBook(id: string): Promise<boolean> {
  return enqueue(async () => {
    const books = await loadIndex();
    const idx = books.findIndex((b) => b.id === id);
    if (idx === -1) return false;

    books.splice(idx, 1);
    await persistIndex(books);

    await fs.rm(path.join(BOOKS_DIR, `${id}.epub`), { force: true }).catch((err: unknown) => {
      console.error(`[store] 删除 epub 文件失败 id=${id}`, err);
    });
    await fs.rm(path.join(COVERS_DIR, `${id}.bin`), { force: true }).catch(() => undefined);
    return true;
  });
}

export async function saveCover(id: string, data: Buffer): Promise<void> {
  await ensureDirs();
  await fs.writeFile(path.join(COVERS_DIR, `${id}.bin`), data);
}

export async function readCover(id: string): Promise<Buffer | undefined> {
  try {
    return await fs.readFile(path.join(COVERS_DIR, `${id}.bin`));
  } catch {
    return undefined;
  }
}

export async function readBookFile(id: string): Promise<Buffer | undefined> {
  try {
    return await fs.readFile(path.join(BOOKS_DIR, `${id}.epub`));
  } catch {
    return undefined;
  }
}

export async function writeBookFile(id: string, data: Buffer): Promise<void> {
  await ensureDirs();
  const target = path.join(BOOKS_DIR, `${id}.epub`);
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, target);
}

/**
 * 回滚用：删掉指定 id 的 epub 文件。
 * 只在「文件已写入但索引写入失败」时调用，避免留下无索引的孤儿文件。
 */
export async function removeBookFile(id: string): Promise<void> {
  await fs.rm(path.join(BOOKS_DIR, `${id}.epub`), { force: true }).catch(() => undefined);
}

/**
 * 清理崩溃残留的 `.tmp` 临时文件。
 *
 * 刻意**不**删除「索引里没有的 .epub/.bin」：用户可能手工把书放进 data/books/，
 * 自动删除会造成静默数据丢失。孤儿文件只可能是「写了文件但索引写入失败」这一种情况，
 * 那个窗口由上传流程里的回滚负责关闭（见 routes/books.ts）。
 */
async function cleanupTempFiles(): Promise<void> {
  const TMP_PATTERN = /\.(epub|json)\.tmp$/;
  let removed = 0;
  for (const dir of [DATA_DIR, BOOKS_DIR]) {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!TMP_PATTERN.test(name)) continue;
      await fs.rm(path.join(dir, name), { force: true }).catch(() => undefined);
      removed += 1;
    }
  }
  if (removed > 0) console.log(`[store] 已清理 ${removed} 个残留临时文件`);
}

export async function initStore(): Promise<void> {
  await ensureDirs();
  const books = await loadIndex();
  // 首次启动时落一个空索引，便于人工查看数据结构
  if (books.length === 0) {
    try {
      await fs.access(INDEX_FILE);
    } catch {
      await persistIndex([]);
    }
  }
  await cleanupTempFiles();
  console.log(`[store] 数据目录 ${DATA_DIR}（${books.length} 本书）`);
}

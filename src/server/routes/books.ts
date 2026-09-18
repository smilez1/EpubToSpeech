import type { FastifyInstance } from 'fastify';
import type { MultipartFile } from '@fastify/multipart';
import type { BookListResponse, UploadBookResponse } from '../../shared/book.ts';
import { bookIdFromSha256, looksLikeEpub, sanitizeFileName, sha256Of } from '../ids.ts';
import {
  deleteBook,
  getBook,
  insertBook,
  listBooks,
  readBookFile,
  readCover,
  removeBookFile,
  saveCover,
  updateMeta,
  updateProgress,
  writeBookFile,
} from '../storage.ts';

const MAX_COVER_BYTES = 8 * 1024 * 1024;

/** 从上传文件名猜一个兜底书名（前端解析出真名后会覆盖）。 */
function fallbackTitleFromFileName(fileName: string): string {
  const base = fileName.replace(/\.epub$/i, '');
  return base.trim() || '未命名书籍';
}

function isImageMagic(buf: Buffer): boolean {
  if (buf.length < 4) return false;
  // JPEG
  if (buf[0] === 0xff && buf[1] === 0xd8) return true;
  // PNG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true;
  // GIF
  if (buf.subarray(0, 3).toString('latin1') === 'GIF') return true;
  // WEBP: RIFF....WEBP
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') {
    return true;
  }
  return false;
}

export async function registerBookRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/books', async (): Promise<BookListResponse> => {
    return { books: await listBooks() };
  });

  /**
   * 上传 epub。multipart 字段：
   * - file  : 必填，epub 二进制
   * - cover : 可选，封面图（前端解析 epub 后一并带上，服务端不解析 epub）
   *
   * 注意：这里不用 schema 校验 metadata，因为字段顺序不保证；
   * 手动遍历 parts 更可控。
   */
  app.post('/api/books', async (request, reply) => {
    if (!request.isMultipart()) {
      return reply.code(400).send({ error: { code: 'NOT_MULTIPART', message: '请求必须是 multipart/form-data' } });
    }

    let epubBuffer: Buffer | undefined;
    let epubFileName = 'unknown.epub';
    let coverBuffer: Buffer | undefined;

    for await (const part of request.parts()) {
      if (part.type === 'file' && part.fieldname === 'file') {
        const file = part as MultipartFile;
        epubFileName = sanitizeFileName(file.filename || 'unknown.epub');
        epubBuffer = await file.toBuffer();
      } else if (part.type === 'file' && part.fieldname === 'cover') {
        const file = part as MultipartFile;
        const buf = await file.toBuffer();
        if (buf.length > MAX_COVER_BYTES) {
          return reply.code(413).send({ error: { code: 'COVER_TOO_LARGE', message: '封面图超过 8MB' } });
        }
        if (isImageMagic(buf)) coverBuffer = buf;
      } else if (part.type === 'file') {
        // 未知文件字段：消费掉，否则流不会结束
        await part.toBuffer();
      }
    }

    if (!epubBuffer || epubBuffer.length === 0) {
      return reply.code(400).send({ error: { code: 'NO_FILE', message: '没有收到 epub 文件（字段名应为 file）' } });
    }
    if (!looksLikeEpub(epubBuffer)) {
      return reply.code(400).send({
        error: { code: 'NOT_EPUB', message: '这个文件不是有效的 EPUB（缺少 zip/mimetype 结构）' },
      });
    }

    const sha256 = sha256Of(epubBuffer);
    const id = bookIdFromSha256(sha256);

    const existing = await getBook(id);
    if (existing) {
      // 去重命中：不重复写文件，但如果这次带了封面而之前没有，补上
      if (coverBuffer && !existing.hasCover) {
        await saveCover(id, coverBuffer);
        const updated = await updateMeta(id, { hasCover: true });
        return reply.send({ book: updated ?? existing, deduped: true } satisfies UploadBookResponse);
      }
      return reply.send({ book: existing, deduped: true } satisfies UploadBookResponse);
    }

    await writeBookFile(id, epubBuffer);
    if (coverBuffer) await saveCover(id, coverBuffer);

    // 索引写入失败时回滚文件，否则会留下无索引的孤儿 epub
    let book;
    try {
      book = await insertBook({
        id,
        originalFileName: epubFileName,
        size: epubBuffer.length,
        sha256,
        fallbackTitle: fallbackTitleFromFileName(epubFileName),
      });
    } catch (err) {
      await removeBookFile(id);
      request.log.error({ err, id }, '索引写入失败，已回滚 epub 文件');
      return reply
        .code(500)
        .send({ error: { code: 'INDEX_WRITE_FAILED', message: '保存书籍索引失败，文件已回滚' } });
    }

    if (coverBuffer) {
      const updated = await updateMeta(id, { hasCover: true });
      return reply.code(201).send({ book: updated ?? book, deduped: false } satisfies UploadBookResponse);
    }
    return reply.code(201).send({ book, deduped: false } satisfies UploadBookResponse);
  });

  app.get<{ Params: { id: string } }>('/api/books/:id/file', async (request, reply) => {
    const { id } = request.params;
    const book = await getBook(id);
    if (!book) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '书不存在' } });
    }
    const buf = await readBookFile(id);
    if (!buf) {
      return reply.code(410).send({ error: { code: 'FILE_MISSING', message: '书文件已丢失，请重新导入' } });
    }
    return reply
      .header('Content-Type', 'application/epub+zip')
      .header('Content-Length', String(buf.length))
      .header('Cache-Control', 'private, max-age=31536000, immutable')
      .send(buf);
  });

  app.get<{ Params: { id: string } }>('/api/books/:id/cover', async (request, reply) => {
    const { id } = request.params;
    const buf = await readCover(id);
    if (!buf) {
      return reply.code(404).send({ error: { code: 'NO_COVER', message: '这本书没有封面' } });
    }
    return reply
      .header('Content-Type', 'application/octet-stream')
      .header('Cache-Control', 'private, max-age=31536000, immutable')
      .send(buf);
  });

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/books/:id/meta',
    async (request, reply) => {
      const { id } = request.params;
      const body = request.body ?? {};
      const patch: Parameters<typeof updateMeta>[1] = {};

      if (typeof body.title === 'string') patch.title = body.title;
      if (typeof body.author === 'string') patch.author = body.author;
      if (typeof body.language === 'string') patch.language = body.language;
      if (typeof body.publisher === 'string') patch.publisher = body.publisher;
      if (typeof body.chapterCount === 'number') patch.chapterCount = body.chapterCount;
      if (typeof body.hasCover === 'boolean') patch.hasCover = body.hasCover;
      if (Array.isArray(body.toc)) patch.toc = body.toc as Parameters<typeof updateMeta>[1]['toc'];

      const updated = await updateMeta(id, patch);
      if (!updated) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '书不存在' } });
      }
      return reply.send({ book: updated });
    },
  );

  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/books/:id/progress',
    async (request, reply) => {
      const { id } = request.params;
      const body = request.body ?? {};
      const percentRaw = body.percent;
      if (typeof percentRaw !== 'number' || Number.isNaN(percentRaw)) {
        return reply.code(400).send({ error: { code: 'BAD_PERCENT', message: 'percent 必须是 0~1 的数字' } });
      }

      const updated = await updateProgress(id, {
        percent: percentRaw,
        cfi: typeof body.cfi === 'string' ? body.cfi : undefined,
        href: typeof body.href === 'string' ? body.href : undefined,
        chapterIndex: typeof body.chapterIndex === 'number' ? body.chapterIndex : undefined,
        sentenceIndex: typeof body.sentenceIndex === 'number' ? body.sentenceIndex : undefined,
      });
      if (!updated) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '书不存在' } });
      }
      return reply.send({ book: updated });
    },
  );

  app.delete<{ Params: { id: string } }>('/api/books/:id', async (request, reply) => {
    const { id } = request.params;
    const ok = await deleteBook(id);
    if (!ok) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '书不存在' } });
    }
    return reply.code(204).send();
  });
}

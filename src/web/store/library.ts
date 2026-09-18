import { create } from 'zustand';
import type { BookMeta } from '@shared/book.ts';
import { api, ApiError } from '@/api';
import { parseEpub, type ParsedEpub } from '@/epub/parseEpub';

export type ImportStatus = 'pending' | 'uploading' | 'parsing' | 'saving' | 'done' | 'error';

export interface ImportTask {
  key: string;
  fileName: string;
  status: ImportStatus;
  /** 0~1，粗略进度（上传占大头）。 */
  progress: number;
  error?: string;
  warnings?: string[];
  /** 命中了 sha256 去重。 */
  deduped?: boolean;
}

interface LibraryState {
  books: BookMeta[];
  loading: boolean;
  loadError?: string;
  imports: ImportTask[];
  /** 被删/被改的书名，用于轻量提示。 */
  toast?: { kind: 'info' | 'error'; text: string };

  load: () => Promise<void>;
  importFiles: (files: File[]) => Promise<void>;
  remove: (id: string) => Promise<void>;
  clearFinishedImports: () => void;
  setToast: (toast?: LibraryState['toast']) => void;
}

/** 用文件名+大小+时间戳做任务 key，同一批里重名文件也能区分。 */
function taskKey(file: File, index: number): string {
  return `${file.name}::${file.size}::${index}`;
}

export const useLibrary = create<LibraryState>((set, get) => ({
  books: [],
  loading: true,
  imports: [],

  async load() {
    set({ loading: true, loadError: undefined });
    try {
      const books = await api.listBooks();
      set({ books, loading: false });
    } catch (err) {
      set({
        loading: false,
        loadError: err instanceof ApiError ? err.message : String(err),
      });
    }
  },

  async importFiles(files) {
    const existingKeys = new Set(get().imports.map((t) => t.key));
    const fresh = files
      .map((file, i) => ({ file, key: taskKey(file, i) }))
      .filter((x) => !existingKeys.has(x.key));
    if (fresh.length === 0) return;

    set((s) => ({
      imports: [
        ...s.imports,
        ...fresh.map<ImportTask>(({ file, key }) => ({
          key,
          fileName: file.name,
          status: 'pending',
          progress: 0,
        })),
      ],
    }));

    const patchTask = (key: string, patch: Partial<ImportTask>) =>
      set((s) => ({
        imports: s.imports.map((t) => (t.key === key ? { ...t, ...patch } : t)),
      }));

    for (const { file, key } of fresh) {
      try {
        // 阶段 1：上传（服务端算 sha256 去重并落盘）
        patchTask(key, { status: 'uploading', progress: 0.15 });
        const { book, deduped } = await api.uploadBook(file);
        patchTask(key, { status: 'saving', progress: 0.55, deduped });

        // 阶段 2：本地解析元数据。失败不中断导入——书已经在库里了。
        patchTask(key, { status: 'parsing', progress: 0.7 });
        let parsed: ParsedEpub | undefined;
        let warnings: string[] = [];
        if (!deduped || !book.metaParsed) {
          try {
            parsed = await parseEpub(file);
            warnings = parsed.warnings;
          } catch (err) {
            warnings = [`元数据解析失败：${(err as Error).message}`];
          }
        }

        // 阶段 3：回填元数据 + 封面
        let finalBook = book;
        if (parsed) {
          patchTask(key, { status: 'saving', progress: 0.85, warnings });
          // 封面单独走一次上传（服务端不解析 epub，只存二进制）
          if (parsed.cover) {
            try {
              const withCover = await api.uploadBook(file, parsed.cover);
              finalBook = withCover.book;
            } catch {
              warnings = [...warnings, '封面上传失败，不影响阅读'];
            }
          }
          const updated = await api.updateMeta(book.id, {
            title: parsed.title,
            author: parsed.author,
            language: parsed.language,
            publisher: parsed.publisher,
            toc: parsed.toc,
            chapterCount: parsed.chapterCount,
            hasCover: Boolean(parsed.cover) || book.hasCover,
          });
          finalBook = { ...finalBook, ...updated };
        }

        patchTask(key, {
          status: 'done',
          progress: 1,
          warnings: warnings.length ? warnings : undefined,
          deduped,
        });

        set((s) => {
          const others = s.books.filter((b) => b.id !== finalBook.id);
          return { books: [finalBook, ...others] };
        });
      } catch (err) {
        const message = err instanceof ApiError ? err.message : String(err);
        patchTask(key, { status: 'error', progress: 0, error: message });
      }
    }

    // 有成功导入时按后端排序重新拉一次，保证顺序一致
    const anyDone = get().imports.some((t) => fresh.some((f) => f.key === t.key) && t.status === 'done');
    if (anyDone) {
      try {
        set({ books: await api.listBooks() });
      } catch {
        /* 保留本地乐观结果 */
      }
    }
  },

  async remove(id) {
    const target = get().books.find((b) => b.id === id);
    await api.deleteBook(id);
    set((s) => ({ books: s.books.filter((b) => b.id !== id) }));
    set({
      toast: { kind: 'info', text: `已删除《${target?.title ?? id}》` },
    });
  },

  clearFinishedImports() {
    // 只清掉已结束（成功/失败）的任务，进行中的要保留
    set((s) => ({
      imports: s.imports.filter((t) => t.status !== 'done' && t.status !== 'error'),
    }));
  },

  setToast(toast) {
    set({ toast });
  },
}));

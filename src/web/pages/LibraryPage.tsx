import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BookMeta } from '@shared/book.ts';
import { api } from '@/api';
import { BookCard } from '@/components/BookCard';
import { useLibrary } from '@/store/library';

type SortKey = 'recent' | 'title' | 'added';

const SORT_LABELS: Record<SortKey, string> = {
  recent: '最近阅读',
  title: '按书名',
  added: '按导入时间',
};

export function LibraryPage() {
  const books = useLibrary((s) => s.books);
  const loading = useLibrary((s) => s.loading);
  const imports = useLibrary((s) => s.imports);
  const importFiles = useLibrary((s) => s.importFiles);
  const remove = useLibrary((s) => s.remove);
  const clearFinishedImports = useLibrary((s) => s.clearFinishedImports);
  const setToast = useLibrary((s) => s.setToast);

  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('recent');
  const [dragging, setDragging] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<BookMeta | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [health, setHealth] = useState<'checking' | 'ok' | 'down'>('checking');

  const inputRef = useRef<HTMLInputElement>(null);
  // dragenter/dragleave 会在子元素间反复触发，用计数器判断是否真的离开
  const dragDepth = useRef(0);

  useEffect(() => {
    let cancelled = false;
    api
      .health()
      .then(() => !cancelled && setHealth('ok'))
      .catch(() => !cancelled && setHealth('down'));
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? books.filter(
          (b) =>
            b.title.toLowerCase().includes(q) ||
            (b.author ?? '').toLowerCase().includes(q) ||
            b.originalFileName.toLowerCase().includes(q),
        )
      : books;
    const sorted = [...list];
    switch (sort) {
      case 'title':
        sorted.sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'));
        break;
      case 'added':
        sorted.sort((a, b) => b.createdAt - a.createdAt);
        break;
      default:
        sorted.sort((a, b) => {
          const at = a.progress?.updatedAt ?? a.createdAt;
          const bt = b.progress?.updatedAt ?? b.createdAt;
          return bt - at;
        });
    }
    return sorted;
  }, [books, query, sort]);

  const pick = useCallback(
    (files: FileList | null) => {
      if (!files?.length) return;
      const list = Array.from(files).filter((f) => /\.epub$/i.test(f.name));
      const rejected = files.length - list.length;
      if (rejected > 0) {
        setToast({ kind: 'error', text: `已忽略 ${rejected} 个非 .epub 文件` });
      }
      if (list.length) void importFiles(list);
    },
    [importFiles, setToast],
  );

  const onDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    if (!e.dataTransfer.types.includes('Files')) return;
    dragDepth.current += 1;
    setDragging(true);
  };
  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    pick(e.dataTransfer.files);
  };

  const activeImports = imports.filter((t) => t.status !== 'done');
  const finishedImports = imports.filter((t) => t.status === 'done' || t.status === 'error');

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await remove(pendingDelete.id);
      setPendingDelete(null);
    } catch (err) {
      setToast({ kind: 'error', text: `删除失败：${(err as Error).message}` });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div
      className="min-h-full"
      onDragEnter={onDragEnter}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <header className="sticky top-0 z-20 border-b border-edge bg-surface/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-5 py-3">
          <h1 className="text-lg font-semibold tracking-tight">
            EPUB 朗读器
            <span className="ml-2 text-sm font-normal text-ink-faint">{books.length} 本</span>
          </h1>

          <HealthBadge state={health} />

          <div className="ml-auto flex flex-wrap items-center gap-2">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索书名 / 作者"
              className="w-44 rounded-lg border border-edge bg-surface-2 px-3 py-1.5 text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
            />
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              className="rounded-lg border border-edge bg-surface-2 px-2.5 py-1.5 text-sm text-ink focus:border-accent focus:outline-none"
            >
              {(Object.keys(SORT_LABELS) as SortKey[]).map((k) => (
                <option key={k} value={k}>
                  {SORT_LABELS[k]}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => { window.location.hash = '#/voices'; }}
              className="rounded-lg border border-edge px-3.5 py-1.5 text-sm text-ink-muted transition hover:bg-surface-3"
            >
              语音包
            </button>
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="rounded-lg bg-accent px-3.5 py-1.5 text-sm font-medium text-surface transition hover:bg-accent-strong"
            >
              导入 EPUB
            </button>
            <input
              ref={inputRef}
              type="file"
              accept=".epub,application/epub+zip"
              multiple
              className="hidden"
              onChange={(e) => {
                pick(e.target.files);
                e.target.value = '';
              }}
            />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-5 py-6">
        {activeImports.length > 0 && (
          <section className="mb-5 rounded-xl bg-surface-2 p-4 ring-1 ring-edge">
            <h2 className="mb-3 text-sm font-medium text-ink-muted">
              正在导入 {activeImports.length} 个文件
            </h2>
            <ul className="flex flex-col gap-2">
              {activeImports.map((t) => (
                <li key={t.key} className="flex items-center gap-3 text-sm">
                  <span className="w-8 shrink-0 text-xs text-ink-faint">
                    {Math.round(t.progress * 100)}%
                  </span>
                  <span className="w-52 shrink-0 truncate" title={t.fileName}>
                    {t.fileName}
                  </span>
                  <div className="h-1 flex-1 overflow-hidden rounded-full bg-surface-3">
                    <div
                      className={`h-full rounded-full transition-[width] ${t.status === 'error' ? 'bg-bad' : 'bg-accent'}`}
                      style={{ width: `${Math.max(t.progress, 0.03) * 100}%` }}
                    />
                  </div>
                  <span className="w-16 shrink-0 text-right text-xs text-ink-muted">
                    {IMPORT_STATUS_LABEL[t.status]}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {finishedImports.length > 0 && (
          <section className="mb-5 flex flex-col gap-2">
            {finishedImports.map((t) => (
              <div
                key={t.key}
                className={`flex items-start gap-3 rounded-lg px-3 py-2 text-sm ring-1 ${
                  t.status === 'error'
                    ? 'bg-bad/10 text-bad ring-bad/25'
                    : 'bg-surface-2 text-ink-muted ring-edge'
                }`}
              >
                <span className="shrink-0">
                  {t.status === 'error' ? '✕' : t.deduped ? '↺' : '✓'}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate">
                    {t.fileName}
                    {t.deduped && ' —— 已在库中，未重复导入'}
                  </p>
                  {t.error && <p className="mt-0.5 text-xs opacity-90">{t.error}</p>}
                  {t.warnings?.map((w) => (
                    <p key={w} className="mt-0.5 text-xs text-warn">
                      {w}
                    </p>
                  ))}
                </div>
              </div>
            ))}
            <button
              type="button"
              onClick={clearFinishedImports}
              className="self-start text-xs text-ink-faint underline hover:text-ink-muted"
            >
              清空这些提示
            </button>
          </section>
        )}

        {loading ? (
          <SkeletonGrid />
        ) : books.length === 0 ? (
          <EmptyState onPick={() => inputRef.current?.click()} />
        ) : filtered.length === 0 ? (
          <p className="py-16 text-center text-sm text-ink-muted">
            没有匹配「{query}」的书
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
            {filtered.map((book) => (
              <BookCard
                key={book.id}
                book={book}
                onDelete={setPendingDelete}
                onOpen={(b) => {
                  window.location.hash = `#/read/${b.id}`;
                }}
              />
            ))}
          </div>
        )}

        <p className="mt-8 text-center text-xs text-ink-faint">
          点封面即可打开阅读。空格键播放/暂停，←/→ 切换句子，点正文任意位置从该句开始朗读。
        </p>
      </main>

      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-30 flex items-center justify-center bg-accent/10 backdrop-blur-sm">
          <div className="rounded-2xl border-2 border-dashed border-accent bg-surface-2/95 px-10 py-8 text-center">
            <p className="text-lg font-medium text-accent">松手即可导入 EPUB</p>
            <p className="mt-1 text-sm text-ink-muted">支持一次拖入多个文件</p>
          </div>
        </div>
      )}

      {pendingDelete && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-6">
          <div className="w-full max-w-sm rounded-xl bg-surface-2 p-5 ring-1 ring-edge">
            <h2 className="text-base font-semibold">删除这本书？</h2>
            <p className="mt-2 text-sm text-ink-muted">
              《{pendingDelete.title}》会从书库移除，本地文件与阅读进度一并删除，无法撤销。
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                disabled={deleting}
                onClick={() => setPendingDelete(null)}
                className="rounded-lg px-3.5 py-1.5 text-sm text-ink-muted ring-1 ring-edge hover:bg-surface-3 disabled:opacity-50"
              >
                取消
              </button>
              <button
                type="button"
                disabled={deleting}
                onClick={() => void confirmDelete()}
                className="rounded-lg bg-bad/90 px-3.5 py-1.5 text-sm font-medium text-surface hover:bg-bad disabled:opacity-50"
              >
                {deleting ? '删除中…' : '确认删除'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const IMPORT_STATUS_LABEL: Record<string, string> = {
  pending: '排队中',
  uploading: '上传中',
  parsing: '解析中',
  saving: '保存中',
  done: '完成',
  error: '失败',
};

function HealthBadge({ state }: { state: 'checking' | 'ok' | 'down' }) {
  if (state === 'checking') {
    return <span className="text-xs text-ink-faint">检查服务…</span>;
  }
  return state === 'ok' ? (
    <span className="flex items-center gap-1.5 text-xs text-good">
      <span className="h-1.5 w-1.5 rounded-full bg-good" />
      服务正常
    </span>
  ) : (
    <span className="flex items-center gap-1.5 text-xs text-bad">
      <span className="h-1.5 w-1.5 rounded-full bg-bad" />
      接口未连接
    </span>
  );
}

function SkeletonGrid() {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="overflow-hidden rounded-xl bg-surface-2 ring-1 ring-edge">
          <div className="skeleton aspect-[2/3] w-full" />
          <div className="flex flex-col gap-2 p-3">
            <div className="skeleton h-3.5 w-4/5 rounded" />
            <div className="skeleton h-3 w-1/2 rounded" />
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyState({ onPick }: { onPick: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-edge py-20 text-center">
      <div className="mb-4 text-5xl">📚</div>
      <h2 className="text-lg font-medium">书库还是空的</h2>
      <p className="mt-2 max-w-md text-sm text-ink-muted">
        把 EPUB 文件拖到页面任意位置，或点击下面的按钮导入。文件只保存在这台电脑上。
      </p>
      <button
        type="button"
        onClick={onPick}
        className="mt-5 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-surface hover:bg-accent-strong"
      >
        选择 EPUB 文件
      </button>
    </div>
  );
}

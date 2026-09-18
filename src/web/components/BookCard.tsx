import type { BookMeta } from '@shared/book.ts';
import { Cover, ProgressBar, formatBytes, formatRelativeTime } from '@/components/Cover';

export function BookCard({
  book,
  onDelete,
  onOpen,
  busy,
}: {
  book: BookMeta;
  onDelete: (book: BookMeta) => void;
  onOpen: (book: BookMeta) => void;
  busy?: boolean;
}) {
  const percent = book.progress?.percent ?? 0;
  const started = percent > 0.001;

  return (
    <article
      className="group relative flex flex-col overflow-hidden rounded-xl bg-surface-2 ring-1 ring-edge transition hover:ring-accent/50 focus-within:ring-accent"
      title={book.title}
    >
      <div className="relative aspect-[2/3] w-full overflow-hidden bg-surface-3">
        <Cover
          bookId={book.id}
          updatedAt={book.updatedAt}
          hasCover={book.hasCover}
          title={book.title}
        />

        {/* 整块封面即"打开"入口 */}
        <button
          type="button"
          onClick={() => onOpen(book)}
          aria-label={`打开《${book.title}》`}
          className="absolute inset-0 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        />

        {started && (
          <span className="pointer-events-none absolute right-2 top-2 rounded-full bg-black/65 px-2 py-0.5 text-xs font-medium text-white backdrop-blur-sm">
            {Math.round(percent * 100)}%
          </span>
        )}

        {/* 悬停/聚焦时露出删除按钮 */}
        <button
          type="button"
          disabled={busy}
          onClick={() => onDelete(book)}
          aria-label={`删除《${book.title}》`}
          className="absolute left-2 top-2 rounded-md bg-black/65 px-2 py-1 text-xs text-white opacity-0 backdrop-blur-sm transition hover:bg-bad/80 focus-visible:opacity-100 group-hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-40"
        >
          删除
        </button>
      </div>

      <div className="flex flex-1 flex-col gap-1.5 p-3">
        <h3 className="line-clamp-2 text-sm font-medium leading-snug text-ink">{book.title}</h3>
        <p className="line-clamp-1 text-xs text-ink-muted">
          {book.author || '未知作者'}
          {book.chapterCount > 0 && ` · ${book.chapterCount} 章`}
        </p>

        <div className="mt-auto flex flex-col gap-1.5 pt-1.5">
          <ProgressBar value={percent} />
          <div className="flex items-center justify-between text-[11px] text-ink-faint">
            <span>
              {book.progress
                ? `上次读到 ${formatRelativeTime(book.progress.updatedAt)}`
                : '尚未开始'}
            </span>
            <span>{formatBytes(book.size)}</span>
          </div>
          {!book.metaParsed && (
            <span className="text-[11px] text-warn" title="导入时未能解析出书名/目录">
              元数据未解析
            </span>
          )}
        </div>
      </div>
    </article>
  );
}

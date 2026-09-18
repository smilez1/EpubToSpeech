/**
 * 前端共享的小组件：封面、进度环/条、提示条等。
 * 刻意保持无状态，方便后面阅读器页复用。
 */
import { useState } from 'react';

/** 封面图 + 无封面时的占位（用书名首字上色做视觉区分）。 */
export function Cover({
  bookId,
  updatedAt,
  hasCover,
  title,
  className = '',
}: {
  bookId: string;
  updatedAt: number;
  hasCover: boolean;
  title: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const showImage = hasCover && !failed;

  if (showImage) {
    return (
      <img
        src={`/api/books/${bookId}/cover?v=${updatedAt}`}
        alt={`《${title}》封面`}
        loading="lazy"
        onError={() => setFailed(true)}
        className={`h-full w-full object-cover ${className}`}
      />
    );
  }

  const initial = title.trim().charAt(0) || '书';
  // 用 id 稳定地挑一个色相，避免每次渲染都变色
  const hue = hashHue(bookId);
  return (
    <div
      className={`flex h-full w-full items-center justify-center ${className}`}
      style={{
        background: `linear-gradient(150deg, hsl(${hue} 32% 26%), hsl(${(hue + 40) % 360} 30% 16%))`,
      }}
    >
      <span className="select-none text-5xl font-semibold text-white/70">{initial}</span>
    </div>
  );
}

function hashHue(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) {
    h = (h * 31 + seed.charCodeAt(i)) % 360;
  }
  return h;
}

/** 细进度条，0~1。 */
export function ProgressBar({ value, className = '' }: { value: number; className?: string }) {
  const pct = Math.min(100, Math.max(0, Math.round(value * 100)));
  return (
    <div
      className={`h-1 w-full overflow-hidden rounded-full bg-surface-3 ${className}`}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
    >
      <div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${pct}%` }} />
    </div>
  );
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`;
  return new Date(ts).toLocaleDateString('zh-CN');
}

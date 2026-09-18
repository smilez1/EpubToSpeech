/** 前后端共享的书籍领域模型。 */

/** 目录条目。epub 的目录天然是树形（部/卷 → 章）。 */
export interface TocEntry {
  label: string;
  /** EPUB CFI 或 spine 内 href；用于跳转定位。 */
  href: string;
  children?: TocEntry[];
}

/**
 * 阅读进度。两种定位方式并存：
 * - cfi / href：精确位置，优先使用
 * - percent：CFI 失效（换了同书不同版本）时的兜底
 */
export interface ReadingProgress {
  /** EPUB CFI 字符串，最精确。 */
  cfi?: string;
  /** spine 内相对 href（如 `text/chapter3.xhtml`），CFI 不可用时的次级定位。 */
  href?: string;
  /** 章节序号，便于目录高亮。 */
  chapterIndex?: number;
  /** 章节内句子序号，供 TTS 从该句续读。 */
  sentenceIndex?: number;
  /** 0~1 的整书进度，兜底定位。 */
  percent: number;
  /** Unix 毫秒时间戳。 */
  updatedAt: number;
}

export interface BookMeta {
  id: string;
  title: string;
  author?: string;
  language?: string;
  publisher?: string;
  /** 原始上传文件名，便于识别。 */
  originalFileName: string;
  /** 字节数。 */
  size: number;
  /** epub 文件内容的 sha256，用于去重。 */
  sha256: string;
  /** 是否有封面图（有则可通过 /api/books/:id/cover 取）。 */
  hasCover: boolean;
  /** 目录，可能为空数组（解析失败或书本身没有）。 */
  toc: TocEntry[];
  /** 章节数（spine 长度）。 */
  chapterCount: number;
  /** 元数据是否已由前端解析回填过。 */
  metaParsed: boolean;
  createdAt: number;
  updatedAt: number;
  progress?: ReadingProgress;
}

/* ------------------------------- API 契约 ------------------------------- */

export interface BookListResponse {
  books: BookMeta[];
}

export interface UploadBookResponse {
  book: BookMeta;
  /** true 表示命中 sha256 去重，未重新写入文件。 */
  deduped: boolean;
}

/** 前端解析 epub 后回填的元数据。 */
export interface BookMetaPatch {
  title?: string;
  author?: string;
  language?: string;
  publisher?: string;
  toc?: TocEntry[];
  chapterCount?: number;
  hasCover?: boolean;
}

export interface ProgressPatch {
  cfi?: string;
  href?: string;
  chapterIndex?: number;
  sentenceIndex?: number;
  percent: number;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
  };
}

export function isApiErrorBody(v: unknown): v is ApiErrorBody {
  return (
    typeof v === 'object' &&
    v !== null &&
    'error' in v &&
    typeof (v as ApiErrorBody).error?.message === 'string'
  );
}

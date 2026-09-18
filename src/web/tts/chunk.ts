/**
 * 分句与切块（纯函数，不依赖 DOM / 不导入任何包，便于直接单测）。
 *
 * 为什么必须切块：Chrome 系的 speechSynthesis 对过长的 utterance 会静默截断
 * （历史上约 15 秒上限），而且一次喂太长会让"跳到下一句"失去粒度。
 *
 * 切块策略：
 *   1. 按中英文句末标点切句（。！？；… . ! ? ; 以及后置引号/括号）
 *   2. 保护常见缩写（Mr. / U.S. / 第1. 等）与小数点，避免误切
 *   3. 过短的句子向后合并，避免产生一堆语气碎片
 *   4. 超长句在逗号/分号等次级标点处二次切分，硬上限兜底
 *
 * 所有 chunk 都带 `start` / `end`，即**原始文本中的字符下标（UTF-16 code unit）**，
 * 这是后续把朗读进度映射回 DOM 做高亮的关键。
 */

/** 句末标点（全角与半角）。 */
const SENTENCE_END = new Set(['。', '！', '？', '；', '…', '.', '!', '?', ';']);
/** 允许跟在句末标点之后的收尾字符，仍算作该句的一部分。 */
const TRAILING = new Set(['”', '’', '"', "'", '）', ')', '】', ']', '》', '〉', '」', '』', '…']);
/** 次级切分点：句子太长时优先在这里断开。 */
const SECONDARY = new Set(['，', ',', '、', '：', ':', '—', '–', '·']);

/** 超过这个长度就强制二次切分（经验值：中文约 10~15 秒语音）。 */
export const MAX_CHUNK_CHARS = 150;
/** 低于这个长度的句子向后合并（除非后面没有了）。 */
export const MIN_MERGE_CHARS = 12;

/** 句末标点前若命中这些词，说明是缩写/序数，不是句末。 */
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'inc', 'ltd', 'co',
  'fig', 'no', 'vol', 'ch', 'sec', 'ed', 'al', 'ca', 'cf', 'eg', 'ie',
]);

/** 判断下标 i 处的字符是否属于字母（用于缩写识别）。 */
function isLetter(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z]/.test(ch);
}

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && /[0-9]/.test(ch);
}

/**
 * 判断 `idx` 处的句末标点是否真的是句子边界。
 * `text[idx]` 必须是 SENTENCE_END 中的字符。
 */
function isRealBoundary(text: string, idx: number): boolean {
  const ch = text[idx]!;

  // 省略号：'…' 单独出现或连续时都视为句末，直接通过
  if (ch === '…') return true;

  // 半角句点：需要排除小数、缩写、以及连续点
  if (ch === '.') {
    if (isDigit(text[idx - 1]) && isDigit(text[idx + 1])) return false; // 3.14
    if (text[idx + 1] === '.') return false; // 连续点，留给后一个处理

    // 向左取一个词，检查是否是缩写
    let s = idx - 1;
    while (s >= 0 && isLetter(text[s])) s -= 1;
    const word = text.slice(s + 1, idx).toLowerCase();
    if (word && ABBREVIATIONS.has(word)) return false;
    // 单字母缩写，如 "J. K. Rowling"
    if (word.length === 1) return false;
    // 纯大写缩写里的点，如 "U.S."（前一个字符是大写字母且再之前也是点/字母）
    if (word.length > 0 && word === word.toUpperCase() && isLetter(text[idx + 1]) === false) {
      // 形如 "U.S." 的最后一个点其实是句末，放过；中间的由后续判断处理
      return true;
    }
    return true;
  }

  return true;
}

/**
 * 把一段文本切成句子区间（不修改文本，返回下标区间）。
 * 返回值保证覆盖全部非空白内容，且区间互不重叠、按顺序排列。
 */
function sentenceSpans(text: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  const len = text.length;
  let start = 0;
  let i = 0;

  while (i < len) {
    const ch = text[i]!;
    if (SENTENCE_END.has(ch) && isRealBoundary(text, i)) {
      let end = i + 1;
      // 吸收紧跟的收尾引号/括号与连续句末标点
      while (end < len && (TRAILING.has(text[end]!) || SENTENCE_END.has(text[end]!))) end += 1;
      spans.push({ start, end });
      start = end;
      i = end;
      continue;
    }
    i += 1;
  }

  if (start < len) spans.push({ start, end: len });
  return spans;
}

/** 去掉区间首尾空白，返回调整后的区间（可能为空区间）。 */
function trimSpan(text: string, span: { start: number; end: number }) {
  let { start, end } = span;
  while (start < end && /\s/.test(text[start]!)) start += 1;
  while (end > start && /\s/.test(text[end - 1]!)) end -= 1;
  return { start, end };
}

/**
 * 句子过长时在次级标点处二次切分。
 * 返回若干区间，尽量让每段不超过 MAX_CHUNK_CHARS。
 */
function splitLongSpan(
  text: string,
  span: { start: number; end: number },
): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  let cursor = span.start;

  while (span.end - cursor > MAX_CHUNK_CHARS) {
    const limit = cursor + MAX_CHUNK_CHARS;
    // 在 [cursor+下限, limit) 范围内从右往左找次级标点
    const floor = cursor + Math.floor(MAX_CHUNK_CHARS * 0.5);
    let cut = -1;
    for (let j = limit - 1; j >= floor; j -= 1) {
      if (SECONDARY.has(text[j]!)) {
        cut = j + 1;
        break;
      }
    }
    if (cut === -1) {
      // 再退一步找空白
      for (let j = limit - 1; j >= floor; j -= 1) {
        if (/\s/.test(text[j]!)) {
          cut = j + 1;
          break;
        }
      }
    }
    if (cut === -1) cut = limit; // 硬切
    out.push({ start: cursor, end: cut });
    cursor = cut;
  }

  if (cursor < span.end) out.push({ start: cursor, end: span.end });
  return out;
}

export interface ChunkOptions {
  maxChars?: number;
  minMergeChars?: number;
}

/**
 * 把文本切成朗读块。
 *
 * 返回的 chunk 保留了原始下标，因此可以直接用来定位 DOM 范围做高亮。
 * 空白/空串会被跳过。
 */
export function chunkText(text: string, options: ChunkOptions = {}): TextChunk[] {
  const maxChars = options.maxChars ?? MAX_CHUNK_CHARS;
  const minMerge = options.minMergeChars ?? MIN_MERGE_CHARS;
  if (!text || !text.trim()) return [];

  // 1. 切句 + 去空白
  let spans = sentenceSpans(text).map((s) => trimSpan(text, s)).filter((s) => s.end > s.start);

  // 2. 超长句二次切分
  const expanded: Array<{ start: number; end: number }> = [];
  for (const s of spans) {
    if (s.end - s.start > maxChars) expanded.push(...splitLongSpan(text, s));
    else expanded.push(s);
  }

  // 3. 过短句向后合并（不影响下标正确性）
  const merged: Array<{ start: number; end: number }> = [];
  for (const s of expanded) {
    const prev = merged[merged.length - 1];
    const length = s.end - s.start;
    if (prev && prev.end - prev.start < minMerge && s.end - prev.start <= maxChars) {
      prev.end = s.end;
    } else if (prev && length < minMerge && s.end - prev.start <= maxChars) {
      // 前一段已达标但当前太短：并进前一段
      prev.end = s.end;
    } else {
      merged.push({ ...s });
    }
  }

  // 4. 输出
  return merged.map((s) => ({
    text: text.slice(s.start, s.end),
    start: s.start,
    end: s.end,
  }));
}

export interface TextChunk {
  /** 朗读文本（已去首尾空白）。 */
  text: string;
  /** 在原文中的起始下标（UTF-16 code unit）。 */
  start: number;
  /** 在原文中的结束下标（不含）。 */
  end: number;
}

/**
 * 估算朗读时长（秒），仅用于 UI 上给个大致预期。
 * 中文按每字约 0.18s、英文字母按每字符约 0.06s 粗估，再按语速缩放。
 */
export function estimateSpeechSeconds(text: string, rate = 1): number {
  const han = (text.match(/[\u4e00-\u9fff\u3040-\u30ff]/g) ?? []).length;
  const rest = text.length - han;
  const seconds = han * 0.18 + rest * 0.05;
  return rate > 0 ? seconds / rate : seconds;
}

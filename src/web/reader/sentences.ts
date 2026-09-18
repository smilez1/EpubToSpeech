/**
 * 句子抽取（依赖标准 DOM，可用 DOM 桩单测）。
 *
 * 为什么不能只按 `<p>` 简单切：一个"句子"在 DOM 里可能被 `<em>` / `<a>` 等行内标签
 * 切成多个文本节点，而朗读又需要把整章拼成连续文本交给引擎。
 * 因此这里同时产出两样东西：
 *
 *  1. `sentences` —— 每句在「整章朗读文本」中的 `[start, end)` 区间（朗读队列的最小单位）；
 *  2. `nodes`     —— 按文档顺序排列的文本节点及其在朗读文本中的累计下标。
 *
 * 有了 2，任何一个朗读文本区间都能还原成精确的 DOM Range；
 * 反过来，鼠标点击的位置（文本节点 + 节点内偏移）也能换算回朗读文本下标。
 * 两边使用同一套坐标，所以高亮不会随朗读推进而偏移。
 *
 * 实现要点：**位置一律由 `textParts.join('').length` 推导**，不另外维护计数器。
 * 早期版本用一个手工 cursor 与 parts 数组并行维护，两者一旦不同步就会出现
 * 整段 1~N 字符的系统性偏移，且极难排查。现在这个不变量在结构上无法被破坏。
 */

import { chunkText, MIN_MERGE_CHARS } from '../tts/chunk';
import { buildTextMap } from '../tts/range';

/** 块级元素：按这些元素逐个提取文本，保证段落边界被保留。 */
const BLOCK_SELECTOR = [
  'p',
  'li',
  'dd',
  'dt',
  'blockquote',
  'figcaption',
  'td',
  'th',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'pre',
  'div',
  'section',
  'article',
  'aside',
  'header',
  'footer',
  'main',
  'body',
].join(',');

/** 这些标签里的内容不是正文，必须排除。 */
const SKIP_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'NAV',
  'SVG',
  'MATH',
  'TEMPLATE',
  'HEAD',
  'TITLE',
  'AUDIO',
  'VIDEO',
  'IFRAME',
  'OBJECT',
  'CANVAS',
  'FORM',
  'BUTTON',
]);

/** 段落之间用空格连接，避免把相邻两段粘成一句。 */
const JOINER = ' ';

/** 一个朗读单元（句子）。 */
export interface Sentence {
  start: number;
  end: number;
  text: string;
  /** 所属段落序号。 */
  blockIndex: number;
}

/** 一个段落在朗读文本中的范围。 */
export interface Paragraph {
  start: number;
  end: number;
  sentenceStart: number;
  sentenceEnd: number;
}

export interface ChapterTextNode {
  node: Text;
  /** 该节点首字符在整章朗读文本中的下标。 */
  start: number;
  length: number;
}

export interface ChapterSentences {
  /** 整章朗读文本，可直接送进 Player。 */
  text: string;
  /** 最小朗读单元。 */
  sentences: Sentence[];
  /** 段落范围（点击定位、章节内导航用）。 */
  paragraphs: Paragraph[];
  /** 覆盖整章的文本节点表。 */
  nodes: ChapterTextNode[];
  totalLength: number;
  warnings: string[];
}

export interface ExtractOptions {
  minMergeChars?: number;
}

/** 判断元素是否含有块级子元素。 */
function hasBlockChild(el: Element): boolean {
  for (const child of Array.from(el.children)) {
    if (child.matches(BLOCK_SELECTOR)) return true;
  }
  return false;
}

/** 收集"叶子块"：自身不含块级子元素、且有可见文本的元素。 */
function collectLeafBlocks(root: Element): Element[] {
  const out: Element[] = [];

  const walk = (el: Element): void => {
    if (SKIP_TAGS.has(el.tagName)) return;
    // 装饰性内容（如注脚标记）常标 contenteditable=false
    if (el.getAttribute('contenteditable') === 'false') return;
    if (el.hasAttribute('hidden')) return;
    const style = el.getAttribute('style');
    if (style && /display\s*:\s*none/i.test(style)) return;

    if (hasBlockChild(el)) {
      for (const child of Array.from(el.children)) walk(child);
      return;
    }
    if ((el.textContent ?? '').trim().length > 0) out.push(el);
  };

  walk(root);
  return out;
}

/**
 * 抽取整章的句子与文本节点映射。
 *
 * `root` 通常是 epub.js 渲染出来的 iframe 里的 body。
 */
export function extractChapterSentences(
  root: Element,
  options: ExtractOptions = {},
): ChapterSentences {
  const minMergeChars = options.minMergeChars ?? MIN_MERGE_CHARS;
  const leaves = collectLeafBlocks(root);

  const warnings: string[] = [];
  const sentences: Sentence[] = [];
  const paragraphs: Paragraph[] = [];
  const nodes: ChapterTextNode[] = [];
  /** 整章朗读文本按写入顺序分片；当前位置 = 各分片长度之和。 */
  const textParts: string[] = [];

  /**
   * 追加一段文本，返回它在整章文本中的起始下标。
   * 位置只从 textParts 推导，避免与手工计数器不同步。
   */
  const appendText = (s: string): number => {
    const at = textParts.reduce((n, p) => n + p.length, 0);
    textParts.push(s);
    return at;
  };

  for (const leaf of leaves) {
    const map = buildTextMap(leaf);
    if (map.nodes.length === 0 || !map.text.trim()) continue;

    // 段内含换行时，行内偏移与 chunk 偏移不再一致，退化为"整段一句"，
    // 宁可少切分也不让高亮错位。
    const hasBreaks = /\n/.test(map.text);
    let pieces: Array<{ text: string; start: number; end: number }>;
    if (hasBreaks) {
      pieces = [{ text: map.text, start: 0, end: map.text.length }];
      if (chunkText(map.text, { minMergeChars }).length > 1) {
        warnings.push('段落内含换行，已退化为整段朗读以避免高亮偏移');
      }
    } else {
      pieces = chunkText(map.text, { minMergeChars });
    }
    if (pieces.length === 0) continue;

    // 段落之间的分隔空格
    if (paragraphs.length > 0) appendText(JOINER);

    const firstSentenceIndex = sentences.length;
    const paragraphStart = textParts.reduce((n, p) => n + p.length, 0);

    // 段内句间分隔空格会给后续句子带来额外位移。
    // 先把每片的位移前缀算出来，登记节点时才能把这段位移算进去
    // （否则同一段里第二个文本节点会少 1 个字符，与句子区间错位）。
    const pieceShift: number[] = [];
    let shift = 0;
    for (let i = 0; i < pieces.length; i += 1) {
      if (i > 0) shift += JOINER.length;
      pieceShift.push(shift);
    }

    // 段内文本节点整体登记一次：chunk 是按顺序连续写入的，
    // 但每片起点的段内位置 = 片内字符偏移 + 该片此前累计的连接空格。
    for (const entry of map.nodes) {
      // 找到该节点属于哪一片（片区间互不重叠，第二片起点可能与第一片终点重合）
      let idx = 0;
      for (let i = pieces.length - 1; i >= 0; i -= 1) {
        if (entry.start >= pieces[i]!.start) {
          idx = i;
          break;
        }
      }
      nodes.push({
        node: entry.node,
        start: paragraphStart + entry.start + pieceShift[idx]!,
        length: entry.length,
      });
    }

    for (let i = 0; i < pieces.length; i += 1) {
      const piece = pieces[i]!;
      // 句间分隔空格
      if (i > 0) appendText(JOINER);

      // 注意：chunkText 会去掉 chunk 首尾空白，所以 chunk 的 [start,end)
      // 比它的 text 更宽。这段空白必须一并写入，否则后面所有坐标都会偏移。
      const raw = map.text.slice(piece.start, piece.end);
      const rawStart = appendText(raw);

      const leading = raw.length - raw.trimStart().length;
      const trailing = raw.length - raw.trimEnd().length;
      sentences.push({
        text: piece.text,
        start: rawStart + leading,
        end: rawStart + raw.length - trailing,
        blockIndex: paragraphs.length,
      });
    }

    paragraphs.push({
      start: paragraphStart,
      end: textParts.reduce((n, p) => n + p.length, 0),
      sentenceStart: firstSentenceIndex,
      sentenceEnd: sentences.length,
    });
  }

  const text = textParts.join('');

  // 用最终文本回填句子文本，保证与 text 完全一致
  for (const s of sentences) s.text = text.slice(s.start, s.end);

  // 节点按朗读文本下标排序，便于二分定位
  nodes.sort((a, b) => a.start - b.start);

  return { text, sentences, paragraphs, nodes, totalLength: text.length, warnings };
}

/** 「第一个 end > index」的节点：落在边界时归到前一个节点末尾。 */
export function nodePositionAt(
  nodes: ChapterTextNode[],
  index: number,
): { node: Text; offset: number } | null {
  if (nodes.length === 0) return null;
  const clamped = Math.max(0, index);

  let lo = 0;
  let hi = nodes.length - 1;
  let chosen = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const entry = nodes[mid]!;
    if (entry.start + entry.length > clamped) {
      chosen = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  if (chosen === -1) {
    const last = nodes[nodes.length - 1]!;
    return { node: last.node, offset: last.length };
  }
  const entry = nodes[chosen]!;
  return { node: entry.node, offset: Math.max(0, Math.min(clamped - entry.start, entry.length)) };
}

/** 整章文本下标区间 → DOM Range（可跨段落）。 */
export function chapterRange(chapter: ChapterSentences, start: number, end: number): Range | null {
  if (chapter.nodes.length === 0) return null;

  // 完全落在内容之外 → null；部分越界 → 夹到有效范围（便于容错调用）
  const len = chapter.totalLength ?? 0;
  if ((start > len && end > len) || (start < 0 && end < 0)) return null;

  const s = Math.max(0, Math.min(Math.min(start, end), len));
  const e = Math.max(0, Math.min(Math.max(start, end), len));

  const sp = nodePositionAt(chapter.nodes, s);
  const ep = nodePositionAt(chapter.nodes, e);
  if (!sp || !ep) return null;

  const range = document.createRange();
  try {
    range.setStart(sp.node, sp.offset);
    range.setEnd(ep.node, ep.offset);
  } catch {
    return null;
  }
  return range;
}

/**
 * 「文本节点 + 节点内偏移」→ 整章朗读文本下标。
 * 点中装饰元素/空白区域时返回 -1。
 */
export function offsetFromDomPosition(
  chapter: ChapterSentences,
  node: Node,
  offset: number,
): number {
  for (const entry of chapter.nodes) {
    if (entry.node === node) return entry.start + Math.max(0, Math.min(offset, entry.length));
  }
  if (node.nodeType === 1 /* ELEMENT_NODE */) {
    for (const entry of chapter.nodes) {
      if ((node as Element).contains(entry.node)) return entry.start;
    }
  }
  return -1;
}

/**
 * 找出包含指定下标的句子下标。
 * 句间连接空格/段落空隙的归属：归到前一句（点击时往前读更符合直觉）。
 */
export function sentenceIndexAt(chapter: ChapterSentences, offset: number): number {
  const list = chapter.sentences;
  if (list.length === 0) return 0;
  if (offset <= list[0]!.start) return 0;

  let lo = 0;
  let hi = list.length - 1;
  let result = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid]!.start <= offset) {
      result = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return result;
}

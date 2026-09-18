/**
 * 字符偏移 ↔ DOM Range 的映射（纯逻辑，只依赖标准 DOM 接口，便于单测）。
 *
 * 需要解决的核心问题：
 *  - 一个"句子"可能跨多个文本节点（被 <em> / <a> / <strong> 切开），
 *    所以要能把「句子在元素纯文本中的起止下标」还原成一个真正的 DOM Range。
 *  - 浏览器的 `speechSynthesis` 的 onboundary 事件给出的 charIndex，
 *    是基于它自己规范化过的文本（连续空白会被折叠成一个空格），
 *    和原始 DOM 文本长度并不一致，必须做偏移修正，否则高亮会越走越偏。
 */

/** 一个文本节点及其在所属元素纯文本中的起始下标。 */
export interface TextNodeEntry {
  node: Text;
  /** 该节点首字符在聚合文本中的下标。 */
  start: number;
  /** 节点文本长度。 */
  length: number;
}

/** 文本节点在聚合纯文本中的下标表。 */
export interface TextMap {
  nodes: TextNodeEntry[];
  /** 聚合后的原始文本（未做空白折叠）。 */
  text: string;
}

/**
 * 按文档顺序收集元素下所有非空文本节点，并记录各自的下标区间。
 * 聚合文本与 `element.textContent` 一致（除注释节点，注释不影响 textContent）。
 */
export function buildTextMap(root: Node): TextMap {
  const nodes: TextNodeEntry[] = [];
  let text = '';
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let current = walker.nextNode();
  while (current) {
    const t = current as Text;
    const value = t.data;
    nodes.push({ node: t, start: text.length, length: value.length });
    text += value;
    current = walker.nextNode();
  }
  return { nodes, text };
}

export interface OffsetPosition {
  node: Text;
  offset: number;
}

/**
 * 把聚合文本下标转成 (文本节点, 节点内偏移)。
 *
 * 规则：取「第一个 start >= index 的节点」，然后退到它的前一个节点的末尾。
 * 这样下标正好落在节点边界时，会归到前一个节点的末尾而不是下一个节点的开头，
 * 保证高亮范围把前一个节点的最后一个字符包含进来。
 */
export function positionAt(map: TextMap, index: number): OffsetPosition | null {
  const { nodes } = map;
  if (nodes.length === 0) return null;
  const clamped = Math.max(0, Math.min(index, map.text.length));

  // 二分找第一个 start >= clamped 的节点
  let lo = 0;
  let hi = nodes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (nodes[mid]!.start >= clamped) hi = mid;
    else lo = mid + 1;
  }

  // lo 是第一个 start >= clamped 的下标；退一格落到包含 clamped 的节点
  const chosen = lo - 1;
  if (chosen < 0) {
    // clamped 落在第一个节点之前（含空节点被跳过的情况）
    return { node: nodes[0]!.node, offset: 0 };
  }
  const entry = nodes[chosen]!;
  return { node: entry.node, offset: Math.min(clamped - entry.start, entry.length) };
}

/** 用聚合文本下标创建 DOM Range。越界会被夹到有效范围内。 */
export function rangeFromOffsets(map: TextMap, start: number, end: number): Range | null {
  if (map.nodes.length === 0) return null;
  const s = Math.min(start, end);
  const e = Math.max(start, end);
  const sp = positionAt(map, s);
  const ep = positionAt(map, e);
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

/** 取某个下标处（向前）的一个"词"区间，用于词级高亮时的兜底。 */
export function wordRangeAt(map: TextMap, index: number): { start: number; end: number } | null {
  const text = map.text;
  if (index < 0 || index >= text.length) return null;

  const isWordChar = (ch: string) => /[\p{L}\p{N}\u4e00-\u9fff\u3040-\u30ff]/u.test(ch);

  // 起始下标可能正落在词首（此时向左没有可扩的字符），
  // 所以要先向右吃掉当前这个词，再向左扩。
  if (!isWordChar(text[index]!)) {
    // 落在空白/标点上：向后跳过非词字符，定位到下一个词
    let p = index;
    while (p < text.length && !isWordChar(text[p]!)) p += 1;
    if (p >= text.length) return null;
    index = p;
  }

  let start = index;
  let end = index;
  while (start > 0 && isWordChar(text[start - 1]!)) start -= 1;
  while (end < text.length && isWordChar(text[end]!)) end += 1;

  return end > start ? { start, end } : null;
}

/**
 * 空白折叠后的下标 → 原始文本下标。
 *
 * HTML 渲染会折叠连续空白，而 TTS 引擎看到的是折叠后的文本，
 * 所以 onboundary 给出的 index 是按折叠文本算的，需要换算回原始下标才能定位 DOM。
 *
 * `collapsedToRaw[k]` = 折叠文本第 k 个字符在原始文本中的下标。
 */
export function buildWhitespaceIndex(rawText: string): {
  collapsed: string;
  collapsedToRaw: number[];
} {
  let collapsed = '';
  const collapsedToRaw: number[] = [];
  let i = 0;
  let inWhitespace = false;

  while (i < rawText.length) {
    const ch = rawText[i]!;
    // 任何连续空白（含 \n \t 与全角空格）折叠成一个普通空格
    if (/\s/.test(ch) || ch === '\u3000') {
      // 只在「一段空白的第一个字符」处输出一个空格，并映射到该字符本身，
      // 否则 collapsedToRaw 会指向空白中间，高亮就会偏。
      if (!inWhitespace && collapsed.length > 0) {
        collapsed += ' ';
        collapsedToRaw.push(i);
      }
      inWhitespace = true;
      i += 1;
      continue;
    }
    collapsed += ch;
    collapsedToRaw.push(i);
    inWhitespace = false;
    i += 1;
  }

  // 去掉尾部空格
  while (collapsed.endsWith(' ')) {
    collapsed = collapsed.slice(0, -1);
    collapsedToRaw.pop();
  }
  return { collapsed, collapsedToRaw };
}

/**
 * 把 TTS 报的（折叠后的）字符下标换算成原始文本下标。
 * 越界时返回 -1，调用方可据此忽略这次 boundary 事件。
 */
export function collapsedIndexToRaw(collapsedToRaw: number[], collapsedIndex: number): number {
  if (collapsedIndex < 0 || collapsedIndex >= collapsedToRaw.length) return -1;
  return collapsedToRaw[collapsedIndex]!;
}

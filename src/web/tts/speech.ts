/**
 * 朗读文本归一化（纯函数，可单测）。
 *
 * 解决的问题：TTS 引擎看到的文本和 DOM 里的文本不是同一份。
 *  - DOM 里可能有 `连续  空白`、换行、全角空格
 *  - 引擎内部会做自己的空白折叠
 *  - 于是 onboundary 报的 charIndex 与 DOM 下标对不上，高亮会越来越偏
 *
 * 做法：显式定义"送给引擎的文本"，并保持 `normalizedToRaw` 映射，
 * 使引擎侧下标可以精确换回原始下标。`normalizeForSpeech` 与
 * `range.buildWhitespaceIndex` 使用同一套折叠规则，两者不会漂移。
 */

export interface NormalizedSpeechText {
  /** 实际送给引擎的文本。 */
  text: string;
  /** normalized 第 k 个字符 → 原始文本下标。 */
  normalizedToRaw: number[];
  /** 原始文本下标 → normalized 下标；未被保留的字符映射到 -1。 */
  rawToNormalized: number[];
}

function isSpace(ch: string): boolean {
  return /\s/.test(ch) || ch === '\u3000' || ch === '\u00a0';
}

/**
 * 折叠连续空白为单个空格，并去掉首尾空白。
 *
 * 注意：刻意**保留**句间空格而不是全部删掉——
 * 中文里多余空格无害，但英文若把词间空格删掉会直接读错。
 */
export function normalizeForSpeech(raw: string): NormalizedSpeechText {
  let text = '';
  const normalizedToRaw: number[] = [];
  const rawToNormalized = new Array<number>(raw.length).fill(-1);
  let inWhitespace = false;

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!;
    if (isSpace(ch)) {
      if (!inWhitespace && text.length > 0) {
        rawToNormalized[i] = text.length;
        text += ' ';
        normalizedToRaw.push(i);
      }
      inWhitespace = true;
      continue;
    }
    rawToNormalized[i] = text.length;
    text += ch;
    normalizedToRaw.push(i);
    inWhitespace = false;
  }

  // 去掉尾部空格（由上面的逻辑可能留一个）
  while (text.endsWith(' ')) {
    const removedIndex = normalizedToRaw.pop()!;
    rawToNormalized[removedIndex] = -1;
    text = text.slice(0, -1);
  }

  return { text, normalizedToRaw, rawToNormalized };
}

/**
 * 把引擎侧（normalized）下标换算成原始文本下标。
 * 越界返回 -1，调用方据此忽略该 boundary 事件。
 */
export function normalizedToRawIndex(
  map: NormalizedSpeechText,
  normalizedIndex: number,
): number {
  if (normalizedIndex < 0 || normalizedIndex >= map.normalizedToRaw.length) return -1;
  return map.normalizedToRaw[normalizedIndex]!;
}

/**
 * 估算朗读时长（毫秒），用于播放看门狗的超时时间。
 * 中文按每字约 190ms、其他字符按每字符约 55ms 粗估，再按语速缩放。
 */
export function estimateDurationMs(text: string, rate = 1): number {
  const han = (text.match(/[\u4e00-\u9fff\u3040-\u30ff]/g) ?? []).length;
  const rest = Math.max(0, text.length - han);
  const ms = han * 190 + rest * 55;
  return rate > 0 ? ms / rate : ms;
}

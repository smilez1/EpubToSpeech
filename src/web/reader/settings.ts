/**
 * 阅读与朗读的偏好设置：类型、默认值、取值范围。
 *
 * 为什么单独成模块：这些是 App 层也要用的**运行时值**，
 * 如果它们留在 `reader/session.ts` 里，任何 import 它们的模块
 * 都会被牵连加载 session.ts —— 而后者 import 了 epub.js（约 400KB）。
 * 那会让阅读器的按需加载失效：epub.js 被拉进主包，
 * 书架首屏白白多下载几百 KB（实测主包从 347KB 涨到 734KB）。
 */

export type ReadFlow = 'scrolled-doc' | 'paginated';

/**
 * 朗读引擎种类。
 *
 * 目前只有浏览器内置语音（Web Speech）。这个联合类型与下面的引擎抽象层保留着，
 * 将来接在线 TTS 或本地模型时新增一个成员即可，播放队列与高亮逻辑不用改。
 */
export type TtsEngineKind = 'webspeech' | 'piper';

export interface ReaderSettings {
  theme: 'dark' | 'light' | 'sepia';
  /** 正文字号，px。 */
  fontSize: number;
  lineHeight: number;
  /**
   * 内容区最大宽度，按**视口宽度的百分比**。
   *
   * 用百分比而不是固定 px：固定值在大屏或高缩放下会显得很窄
   * （原来固定 720px，在 1800px 的窗口里正文只占 40%）。
   * 实际生效宽度 = min(该百分比 × 视口宽, 1800px)，上限避免超宽屏上行太长。
   */
  maxWidthPercent: number;
  fontFamily: string;
  flow: ReadFlow;
}

/** 行宽的绝对值上限：超过这个宽度，一行字数太多反而难读。 */
export const MAX_CONTENT_WIDTH_PX = 1800;

/** 行宽可调范围（视口百分比）。 */
export const WIDTH_PERCENT_RANGE = { min: 40, max: 100 } as const;

export const DEFAULT_SETTINGS: ReaderSettings = {
  theme: 'dark',
  fontSize: 18,
  lineHeight: 1.8,
  maxWidthPercent: 82,
  fontFamily: 'serif',
  flow: 'scrolled-doc',
};

/** 行宽百分比夹到合法区间，容错外部传入的脏数据。 */
export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SETTINGS.maxWidthPercent;
  return Math.min(WIDTH_PERCENT_RANGE.max, Math.max(WIDTH_PERCENT_RANGE.min, Math.round(value)));
}

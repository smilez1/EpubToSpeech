/**
 * TTS 引擎抽象层。
 *
 * 上层（Player / ReaderSession）只依赖这里的接口，不直接碰 speechSynthesis。
 * 这样后续接在线 TTS 或本地模型，只需要再写一个 TtsEngine 实现，
 * 播放队列、高亮、进度回写这些逻辑一行都不用改。
 */

export interface TtsVoice {
  /** 引擎内唯一 id，用于切回同一个音色。 */
  id: string;
  name: string;
  /** BCP-47，如 zh-CN。可能为空（部分引擎不提供）。 */
  lang: string;
  engineId: string;
  /** 是否离线可用。在线引擎为 false。 */
  local: boolean;
}

export interface SpeakParams {
  text: string;
  voiceId?: string;
  rate: number;
  pitch: number;
  volume: number;
}

export interface SpeakHandlers {
  /** 引擎真正开始发声。用于关掉"启动看门狗"。 */
  onStart?: () => void;
  /**
   * 读到某个字符位置。
   * `charIndex` 是**引擎侧规范化文本**（连续空白折叠）中的下标，
   * 上层需要自己换算回 DOM 下标，见 chunk/range 模块。
   */
  onBoundary?: (charIndex: number) => void;
  /** 正常读完。 */
  onEnd?: () => void;
  onError?: (error: Error) => void;
}

export interface SpeakHandle {
  /** 取消本次朗读；取消后不应再触发任何回调。 */
  cancel: () => void;
}

export interface TtsEngineCapabilities {
  /** 是否提供 onboundary，决定能否做词级高亮。 */
  wordBoundary: boolean;
  /** 能否一次读到结束（长文本是否需要上层切块）。 */
  handlesLongText: boolean;
  /** 能否把合成结果导出成音频文件（WebSpeech 不能，为后续导出功能留位）。 */
  synthesizeToFile: boolean;
  offline: boolean;
}

export interface TtsEngine {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: TtsEngineCapabilities;
  /**
   * 列出可用音色。实现方应处理"音色异步加载"的情况
   * （浏览器首次 getVoices() 可能返回空数组）。
   */
  listVoices(): Promise<TtsVoice[]>;
  /** 当前浏览器/环境是否可用。 */
  isAvailable(): boolean;
  speak(params: SpeakParams, handlers: SpeakHandlers): SpeakHandle;
  /** 打断当前朗读（停止整条语音输出）。 */
  cancel(): void;
  /** 释放资源（objectURL、定时器、子进程等）。可选，但需要清理的引擎应实现。 */
  dispose?(): void;
}

export type { TtsEngine as TtsEngineType };

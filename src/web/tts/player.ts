import type { TextChunk } from './chunk';
import { estimateDurationMs, normalizeForSpeech, normalizedToRawIndex } from './speech';
import type { TtsEngine } from './types';

/**
 * 驱动接口：把「一段文本」交给引擎并回报边界。
 *
 * 抽出这一层是为了让 Player 可测试——测试里可以塞一个假驱动，
 * 不依赖浏览器语音。同时它负责把引擎侧字符下标换算成**原始文本下标**，
 * 这样上层拿到的 boundary 可以直接用来定位 DOM。
 */
export interface TtsDriver {
  speak(
    text: string,
    handlers: {
      onStart?: () => void;
      /** charIndex 已经换算成原始文本下标。 */
      onBoundary?: (charIndex: number) => void;
      onEnd?: () => void;
      onError?: (error: Error) => void;
    },
  ): { cancel: () => void };
  cancelAll(): void;
  /**
   * 可选：预生成后续文本。
   *
   * 只有"先合成整段音频再播放"的引擎（而不是边合成边播）需要它。
   * Web Speech 是边合成边播，实现为空即可。
   */
  prefetch?(texts: string[]): void;
}

/**
 * 基于 TtsEngine 的默认驱动实现。
 *
 * 注意：刻意不用 TypeScript 参数属性（`constructor(private readonly x)`），
 * 因为 Node 的纯类型擦除模式不支持它，用了这些模块就无法在 Node 下直接单测。
 */
export class EngineDriver implements TtsDriver {
  private readonly engine: TtsEngine;
  private readonly settings: () => {
    voiceId?: string;
    rate: number;
    pitch: number;
    volume: number;
  };

  constructor(
    engine: TtsEngine,
    settings: () => { voiceId?: string; rate: number; pitch: number; volume: number },
  ) {
    this.engine = engine;
    this.settings = settings;
  }

  speak(
    text: string,
    handlers: {
      onStart?: () => void;
      onBoundary?: (charIndex: number) => void;
      onEnd?: () => void;
      onError?: (error: Error) => void;
    },
  ): { cancel: () => void } {
    // 先做与 buildWhitespaceIndex 同规则的归一化，并保留下标映射，
    // 这样引擎报的下标能精确换回原始下标。
    const normalized = normalizeForSpeech(text);
    const { rate, pitch, volume, voiceId } = this.settings();

    const handle = this.engine.speak(
      { text: normalized.text, voiceId, rate, pitch, volume },
      {
        onStart: handlers.onStart,
        onBoundary: (index) => {
          const raw = normalizedToRawIndex(normalized, index);
          if (raw >= 0) handlers.onBoundary?.(raw);
        },
        onEnd: handlers.onEnd,
        onError: handlers.onError,
      },
    );
    return handle;
  }

  cancelAll(): void {
    this.engine.cancel();
  }

  /** 预生成（仅"先合成再播放"的引擎有意义）。 */
  prefetch(texts: string[]): void {
    const engine = this.engine as TtsEngine & { prefetch?: (t: string[], p: unknown) => void };
    if (typeof engine.prefetch !== 'function') return;
    const { rate, pitch, volume, voiceId } = this.settings();
    engine.prefetch(texts, { text: '', rate, pitch, volume, voiceId });
  }
}

export interface PlayerState {
  status: 'idle' | 'playing' | 'paused' | 'ended' | 'error';
  /** 当前句在 chunks 中的下标。 */
  index: number;
  /** 引擎侧字数进度下标（原始文本坐标系）；null 表示该引擎不支持。 */
  boundary: number | null;
  error?: string;
}

export interface PlayerCallbacks {
  onState?: (state: PlayerState) => void;
  /**
   * 切到新句子时触发。带 `text` 与 `offset` 便于上层换算高亮范围。
   */
  onChunk?: (chunk: TextChunk, index: number) => void;
  /**
   * 需要预生成后续句子时触发（仅"先合成再播放"的引擎用得上）。
   * 返回要预生成的文本，通常是当前句之后的若干句。
   */
  onPrefetch?: (fromIndex: number) => string[];
  /** 当前句读完（用于调试/统计；自动续播内部已完成）。 */
  onChunkEnd?: (index: number, forced: boolean) => void;
  /**
   * 播放到末尾时询问是否还有更多内容（用于跨章节续读）。
   * 返回 true 表示已追加新 chunk，应继续播放。
   */
  onNeedMore?: () => Promise<boolean> | boolean;
  /** 整段播完且没有更多内容。 */
  onFinished?: () => void;
}

export interface PlayerOptions {
  /** 引擎迟迟不报 onStart 的容忍时间。 */
  startTimeoutMs?: number;
  /** 估算时长之外额外给的余量，用于结束看门狗。 */
  endTimeoutSlackMs?: number;
}

const DEFAULT_START_TIMEOUT_MS = 12_000;
const DEFAULT_END_SLACK_MS = 10_000;

/**
 * 朗读播放队列。
 *
 * 负责：串行朗读 chunks、记住当前句、前后跳句、语速音量音色调整、
 * 以及两个看门狗（引擎不报 onStart / 不报 onEnd 时强行推进），
 * 避免出现"卡住不动且没有任何反馈"的状态。
 */
export class Player {
  private chunks: TextChunk[] = [];
  private index = 0;
  private status: PlayerState['status'] = 'idle';
  private boundary: number | null = null;
  private error: string | undefined;

  private cancelCurrent: (() => void) | null = null;
  private timer: number | null = null;
  /** 递增代号：每次打断后旧回调全部失效，避免陈旧事件污染新状态。 */
  private generation = 0;
  private playing = false;

  private voiceId: string | undefined;
  private rate = 1;
  private pitch = 1;
  private volume = 1;

  private readonly startTimeoutMs: number;
  private readonly endSlackMs: number;

  constructor(
    private readonly driver: TtsDriver,
    private readonly callbacks: PlayerCallbacks = {},
    options: PlayerOptions = {},
  ) {
    this.startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    this.endSlackMs = options.endTimeoutSlackMs ?? DEFAULT_END_SLACK_MS;
  }

  /* ------------------------------ 状态读取 ------------------------------ */

  getState(): PlayerState {
    return { status: this.status, index: this.index, boundary: this.boundary, error: this.error };
  }

  getChunks(): TextChunk[] {
    return this.chunks;
  }

  getIndex(): number {
    return this.index;
  }

  isPlaying(): boolean {
    return this.status === 'playing';
  }

  /* ------------------------------ 队列管理 ------------------------------ */

  /** 设置整条队列。会打断当前朗读（如果正在读）。 */
  setChunks(chunks: TextChunk[], startIndex = 0): void {
    this.interrupt();
    this.chunks = chunks;
    this.index = clampIndex(startIndex, chunks.length);
    this.boundary = null;
    this.setStatus('idle');
  }

  /** 追加内容（跨章节续读用），不影响当前播放位置。 */
  appendChunks(chunks: TextChunk[]): void {
    this.chunks = [...this.chunks, ...chunks];
    // 若之前因为读完而停在末尾，现在有内容了，允许继续
    if (this.status === 'ended' && this.chunks.length > 0) this.status = 'idle';
    this.emitState();
  }

  clear(): void {
    this.interrupt();
    this.chunks = [];
    this.index = 0;
    this.boundary = null;
    this.setStatus('idle');
  }

  /* -------------------------------- 控制 -------------------------------- */

  async play(startIndex?: number): Promise<void> {
    if (this.chunks.length === 0) return;
    if (typeof startIndex === 'number') {
      this.index = clampIndex(startIndex, this.chunks.length);
      this.boundary = null;
    }
    this.playing = true;
    this.error = undefined;
    await this.playCurrent();
  }

  pause(): void {
    this.playing = false;
    this.interrupt(false);
    this.setStatus('paused');
  }

  stop(): void {
    this.playing = false;
    this.interrupt();
    this.boundary = null;
    this.setStatus('idle');
  }

  async next(): Promise<void> {
    if (this.index >= this.chunks.length - 1) {
      // 已经是最后一句：若有更多内容就续上，否则结束
      const more = await this.callbacks.onNeedMore?.();
      if (!more) {
        this.playing = false;
        this.setStatus('ended');
        this.callbacks.onFinished?.();
        return;
      }
    }
    this.index += 1;
    this.boundary = null;
    if (this.playing) await this.playCurrent();
    else this.emitChunk();
  }

  /** 跳到上一句；已在第一句时退化为重新开始当前句。 */
  async previous(): Promise<void> {
    this.index = Math.max(0, this.index - 1);
    this.boundary = null;
    if (this.playing) await this.playCurrent();
    else this.emitChunk();
  }

  async seek(index: number): Promise<void> {
    this.index = clampIndex(index, this.chunks.length);
    this.boundary = null;
    if (this.playing) await this.playCurrent();
    else this.emitChunk();
  }

  /* ------------------------------- 参数调整 ------------------------------- */

  setRate(rate: number): void {
    this.rate = clamp(rate, 0.1, 4);
    this.restartIfPlaying();
  }

  setVolume(volume: number): void {
    this.volume = clamp(volume, 0, 1);
    this.restartIfPlaying();
  }

  setPitch(pitch: number): void {
    this.pitch = clamp(pitch, 0, 2);
    this.restartIfPlaying();
  }

  setVoice(voiceId: string | undefined): void {
    this.voiceId = voiceId;
    this.restartIfPlaying();
  }

  getSettings(): { voiceId?: string; rate: number; pitch: number; volume: number } {
    return { voiceId: this.voiceId, rate: this.rate, pitch: this.pitch, volume: this.volume };
  }

  dispose(): void {
    this.playing = false;
    this.interrupt();
    this.chunks = [];
    this.status = 'idle';
  }

  /* -------------------------------- 内部 -------------------------------- */

  /** 参数变化时从头重读当前句，否则要等整句读完才生效。 */
  private restartIfPlaying(): void {
    if (!this.playing) return;
    void this.playCurrent();
  }

  private async playCurrent(): Promise<void> {
    const chunk = this.chunks[this.index];
    if (!chunk) {
      // 队列被清空或定位越界
      this.playing = false;
      this.setStatus('idle');
      return;
    }

    this.interrupt(false);
    const gen = ++this.generation;
    this.boundary = null;

    // 已经处于暂停/停止状态时，只更新"当前句"的显示，不发声。
    // 否则暂停后被 advance()/看门狗触发一次播放，就会重新读起来。
    if (!this.playing) {
      this.emitChunk();
      this.emitState();
      return;
    }

    this.setStatus('playing');
    this.emitChunk();

    // 结束看门狗：无论引擎是否报 onStart 都挂上，避免彻底卡死。
    // 时长按语速估算后给足余量，防止正常长句被误判。
    this.armTimer(estimateDurationMs(chunk.text, this.rate) + this.endSlackMs);

    // 注意：cancelCurrent 存的是句柄的 cancel 方法，不是句柄对象本身
    const handle = this.driver.speak(chunk.text, {
      onStart: () => {
        if (gen !== this.generation) return;
        // 已经真正发声了，把"启动看门狗"换成按估算时长的看门狗
        this.clearTimer();
        this.armTimer(estimateDurationMs(chunk.text, this.rate) + this.endSlackMs);
      },
      onBoundary: (charIndex) => {
        if (gen !== this.generation) return;
        this.boundary = charIndex;
        this.emitState();
      },
      onEnd: () => {
        if (gen !== this.generation) return;
        this.clearTimer();
        this.cancelCurrent = null;
        this.callbacks.onChunkEnd?.(this.index, false);
        void this.advance(gen);
      },
      onError: (err) => {
        if (gen !== this.generation) return;
        this.clearTimer();
        this.cancelCurrent = null;
        this.playing = false;
        this.error = err.message;
        this.setStatus('error');
      },
    });

    this.cancelCurrent = handle.cancel;

    // 启动看门狗：引擎一直不发声（常见于系统语音服务异常）时，直接推进
    this.armStartTimer(gen);
  }

  /** 当前句读完，推进到下一句；到末尾则询问是否有更多内容。 */
  private async advance(gen: number): Promise<void> {
    if (gen !== this.generation) return;

    if (this.index < this.chunks.length - 1) {
      this.index += 1;
      await this.playCurrent();
      return;
    }

    const more = await this.callbacks.onNeedMore?.();
    if (gen !== this.generation) return; // 等待期间被用户打断

    if (more) {
      this.index += 1;
      await this.playCurrent();
      return;
    }

    this.playing = false;
    this.setStatus('ended');
    this.callbacks.onFinished?.();
  }

  /**
   * 打断当前朗读。
   * `keepPlaying` 为 true 时保持"想要播放"的意图（用于换参数后重读）。
   */
  private interrupt(keepPlaying = false): void {
    this.generation += 1;
    this.clearTimer();
    if (this.cancelCurrent) {
      this.cancelCurrent();
      this.cancelCurrent = null;
    }
    // 打断的是"引擎队列"，不是句间推进，所以这里不改变 playing 意图
    void keepPlaying;
  }

  private armTimer(ms: number): void {
    this.clearTimer();
    this.timer = window.setTimeout(() => {
      this.timer = null;
      // 看门狗触发：认为该句已结束，强行推进，避免永久卡住
      const gen = this.generation;
      this.callbacks.onChunkEnd?.(this.index, true);
      if (this.cancelCurrent) {
        this.cancelCurrent();
        this.cancelCurrent = null;
      }
      void this.advance(gen);
    }, ms);
  }

  /** 启动看门狗会覆盖结束看门狗，两者不并存。 */
  private armStartTimer(gen: number): void {
    this.clearTimer();
    this.timer = window.setTimeout(() => {
      this.timer = null;
      if (gen !== this.generation) return;
      // 引擎始终没开始发声：跳过这一句，而不是无限等待
      this.callbacks.onChunkEnd?.(this.index, true);
      if (this.cancelCurrent) {
        this.cancelCurrent();
        this.cancelCurrent = null;
      }
      void this.advance(gen);
    }, this.startTimeoutMs);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private setStatus(status: PlayerState['status']): void {
    this.status = status;
    this.emitState();
  }

  private emitState(): void {
    this.callbacks.onState?.(this.getState());
  }

  private emitChunk(): void {
    const chunk = this.chunks[this.index];
    if (!chunk) return;
    this.callbacks.onChunk?.(chunk, this.index);
    // 让上层有机会预生成后续句子（"先合成再播放"的引擎不预生成会卡顿）
    const ahead = this.callbacks.onPrefetch?.(this.index);
    if (ahead?.length) this.driver.prefetch?.(ahead);
  }
}

function clamp(v: number, min: number, max: number): number {
  if (Number.isNaN(v)) return min;
  return Math.min(max, Math.max(min, v));
}

function clampIndex(index: number, length: number): number {
  if (length === 0) return 0;
  return Math.min(length - 1, Math.max(0, Math.floor(index)));
}

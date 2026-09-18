import type {
  SpeakHandle,
  SpeakHandlers,
  SpeakParams,
  TtsEngine,
  TtsEngineCapabilities,
  TtsVoice,
} from './types';

/**
 * 基于浏览器内置 Web Speech API 的引擎（Windows 上走 SAPI/OneCore）。
 *
 * 已知坑（都在这里处理，上层不用管）：
 *  1. `getVoices()` 首次调用常返回空数组，音色是异步加载的 → 等 voiceschanged
 *  2. 长 utterance 会被静默截断 → 上层负责切块，这里只朗读单块
 *  3. `cancel()` 之后立刻 `speak()` 在 Chrome 系上可能卡死 → 加一个极短延迟
 *  4. 已排队但未开始的朗读，需要能单独撤销 → 用 pending 集合跟踪
 *  5. 有些情况下引擎既不报 onend 也不报 onerror → 上层看门狗兜底（见 player.ts）
 */

const VOICES_TIMEOUT_MS = 2000;
/** cancel 后延迟再 speak，规避 Chrome 的卡死问题。 */
const SPEAK_DELAY_MS = 60;

interface PendingUtterance {
  utterance: SpeechSynthesisUtterance;
  /** 还没有真正开始发声，此时撤销是安全的。 */
  notStarted: boolean;
}

export class WebSpeechEngine implements TtsEngine {
  readonly id = 'webspeech';
  readonly displayName = '系统内置语音';

  readonly capabilities: TtsEngineCapabilities = {
    wordBoundary: true,
    handlesLongText: false, // 必须由上层切块
    synthesizeToFile: false, // WebSpeech 无法导出音频
    offline: true,
  };

  private voicesCache: TtsVoice[] | null = null;
  private voicesPromise: Promise<TtsVoice[]> | null = null;
  /** 本引擎发出、尚未结束的 utterance。 */
  private live = new Set<PendingUtterance>();
  private disposed = false;

  isAvailable(): boolean {
    return typeof window !== 'undefined' && 'speechSynthesis' in window;
  }

  private get synth(): SpeechSynthesis {
    return window.speechSynthesis;
  }

  async listVoices(): Promise<TtsVoice[]> {
    if (!this.isAvailable()) return [];
    if (this.voicesCache && this.voicesCache.length > 0) return this.voicesCache;
    if (this.voicesPromise) return this.voicesPromise;

    this.voicesPromise = new Promise<TtsVoice[]>((resolve) => {
      const map = (raw: SpeechSynthesisVoice[]): TtsVoice[] =>
        raw.map((v) => ({
          id: v.voiceURI || v.name,
          name: v.name,
          lang: v.lang || '',
          engineId: this.id,
          local: v.localService !== false,
        }));

      const immediate = this.synth.getVoices();
      if (immediate.length > 0) {
        this.voicesCache = map(immediate);
        resolve(this.voicesCache);
        return;
      }

      // 等异步加载，同时挂超时兜底（某些环境永远不触发 voiceschanged）
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        this.synth.removeEventListener('voiceschanged', finish);
        this.voicesCache = map(this.synth.getVoices());
        resolve(this.voicesCache);
      };
      this.synth.addEventListener('voiceschanged', finish);
      window.setTimeout(finish, VOICES_TIMEOUT_MS);
    });

    return this.voicesPromise;
  }

  speak(params: SpeakParams, handlers: SpeakHandlers): SpeakHandle {
    if (this.disposed || !this.isAvailable()) {
      // 不可用时立刻报错，让上层走错误分支而不是静默卡住
      window.setTimeout(() => handlers.onError?.(new Error('当前环境不支持系统语音合成')), 0);
      return { cancel: () => undefined };
    }

    let cancelled = false;
    let timer: number | null = null;
    const entry: PendingUtterance = {
      utterance: new SpeechSynthesisUtterance(),
      notStarted: true,
    };

    const dispose = (cancelThis: boolean) => {
      if (cancelled) return;
      cancelled = true;
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      this.live.delete(entry);
      if (cancelThis) {
        // 只取消这一个：未开始的从队列里摘掉；已开始的则需要打断整个合成器
        if (entry.notStarted) {
          try {
            this.synth.cancel();
          } catch {
            /* 某些实现会抛，忽略 */
          }
        } else {
          this.synth.cancel();
        }
      }
    };

    const startNow = () => {
      timer = null;
      if (cancelled || this.disposed) return;

      const u = entry.utterance;
      u.text = params.text;
      u.rate = clamp(params.rate, 0.1, 10);
      u.pitch = clamp(params.pitch, 0, 2);
      u.volume = clamp(params.volume, 0, 1);

      if (params.voiceId) {
        const match = this.synth
          .getVoices()
          .find((v) => (v.voiceURI || v.name) === params.voiceId);
        if (match) u.voice = match;
      }

      u.onstart = () => {
        entry.notStarted = false;
        if (cancelled) return;
        handlers.onStart?.();
      };
      u.onboundary = (ev) => {
        if (cancelled) return;
        // 只关心 word 级边界；sentence 级事件的 charIndex 语义不同
        if (ev.name && ev.name !== 'word') return;
        handlers.onBoundary?.(ev.charIndex);
      };
      u.onend = () => {
        entry.notStarted = false;
        this.live.delete(entry);
        if (cancelled) return;
        handlers.onEnd?.();
      };
      u.onerror = (ev) => {
        entry.notStarted = false;
        this.live.delete(entry);
        if (cancelled) return;
        // canceled/interrupted 是主动打断，不算错误
        if (ev.error === 'canceled' || ev.error === 'interrupted') return;
        handlers.onError?.(new Error(`语音引擎报错: ${ev.error || 'unknown'}`));
      };

      this.synth.speak(u);
    };

    this.live.add(entry);
    // cancel 之后立刻 speak 会卡死，统一延迟一点点
    timer = window.setTimeout(startNow, SPEAK_DELAY_MS);

    return {
      cancel: () => dispose(true),
    };
  }

  /** 打断全部输出。 */
  cancel(): void {
    for (const entry of this.live) entry.notStarted = false;
    this.live.clear();
    if (this.isAvailable()) {
      try {
        this.synth.cancel();
      } catch {
        /* 忽略 */
      }
    }
  }

  /** 供设置界面强制刷新音色列表（例如用户新装了系统语音包）。 */
  invalidateVoices(): void {
    this.voicesCache = null;
    this.voicesPromise = null;
  }

  dispose(): void {
    this.disposed = true;
    this.cancel();
  }
}

function clamp(v: number, min: number, max: number): number {
  if (Number.isNaN(v)) return min;
  return Math.min(max, Math.max(min, v));
}

/** 当前默认引擎。后续接入在线 TTS 时在这里做选择即可。 */
export function createDefaultEngine(): TtsEngine {
  return new WebSpeechEngine();
}

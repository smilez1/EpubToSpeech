import type { SpeakHandle, SpeakHandlers, SpeakParams, TtsEngine, TtsEngineCapabilities, TtsVoice } from './types';

interface PiperVoice { id: string; name: string; lang: string; local: boolean }

interface PrefetchParams {
  text: string;
  rate: number;
  pitch: number;
  volume: number;
  voiceId?: string;
}

/** 音色稳定度与韵律起伏的官方默认值（与 piper 模型配置一致）。 */
const DEFAULT_NOISE_SCALE = 0.667;
const DEFAULT_NOISE_W_SCALE = 0.8;

/**
 * Piper CPU 引擎（"先合成再播放"型）。
 *
 * 关键设计——预生成缓存：
 *   Player 会通过 `prefetch()` 提前把后续几句推给我们，
 *   我们立刻发起合成并把 Blob 存进缓存；等到真正要播那一句时
 *   `speak()` 直接命中缓存，不再现场等待合成。
 *   这样句子间几乎无缝，也不会踩中 Player 的启动看门狗。
 *
 * 缓存键 = 文本 + 音色 + 语速，任何参数变化都会自然失效；
 * 容量有上限，超出后按插入顺序淘汰最旧项。
 */
const CACHE_LIMIT = 12;
/** 合成请求的兜底超时：模型加载 + g2pW 首次初始化可能需要十几秒。 */
const SYNTH_TIMEOUT_MS = 60_000;

export class PiperEngine implements TtsEngine {
  readonly id = 'piper';
  readonly displayName = 'Piper（CPU）';
  readonly capabilities: TtsEngineCapabilities = {
    wordBoundary: false,
    handlesLongText: false,
    synthesizeToFile: true,
    offline: true,
  };

  private voice = 'default';
  /** 音色稳定度（noise_scale，越小越稳）与韵律起伏（noise_w_scale，越大起伏越大）。 */
  private noiseScale = DEFAULT_NOISE_SCALE;
  private noiseWScale = DEFAULT_NOISE_W_SCALE;
  /** 正在合成的预取句子队列（低优先级：只在 speak 之后空闲时发起）。 */
  private pendingPrefetch: Array<{ text: string; voiceId: string | undefined; rate: number }> = [];
  private prefetchBusy = false;
  private controller: AbortController | null = null;
  private cache = new Map<string, Promise<Blob>>();
  private voicesCache: TtsVoice[] | null = null;

  constructor(voice?: string) { if (voice) this.voice = voice; }
  isAvailable(): boolean { return typeof window !== 'undefined'; }

  /** 设置音色稳定度与韵律起伏（实时生效；缓存 key 含这两项，改动自动失效旧音频）。 */
  setNoise(noiseScale: number, noiseWScale: number): void {
    this.noiseScale = clampNum(noiseScale, 0.1, 2, DEFAULT_NOISE_SCALE);
    this.noiseWScale = clampNum(noiseWScale, 0.1, 2, DEFAULT_NOISE_W_SCALE);
  }

  /** 取"当前生效音色"：未指定时用列表里第一个（而不是发 'default' 给 sidecar）。 */
  private async effectiveVoice(): Promise<string> {
    if (this.voice !== 'default') return this.voice;
    try {
      const voices = await this.listVoices();
      if (voices.length > 0) return voices[0]!.id;
    } catch {
      /* 首屏取音色失败时仍会走 'default'，sidecar 会按默认音色回退 */
    }
    return 'default';
  }

  async listVoices(): Promise<TtsVoice[]> {
    if (this.voicesCache) return this.voicesCache;
    const response = await fetch('/api/tts/piper/voices', { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error('Piper 服务未连接');
    const body = (await response.json()) as { voices?: PiperVoice[] };
    this.voicesCache = (body.voices ?? []).map((v) => ({ ...v, engineId: this.id }));
    return this.voicesCache;
  }

  private cacheKey(text: string, voiceId: string | undefined, rate: number): string {
    return `${voiceId ?? this.voice}\u0000${rate}\u0000${this.noiseScale}\u0000${this.noiseWScale}\u0000${text}`;
  }

  /** 发起一次合成并把 Blob 放进缓存；同一键并发请求共享同一个 Promise。 */
  private synthesize(text: string, voiceId: string | undefined, rate: number): Promise<Blob> {
    if (!text.trim()) return Promise.reject(new Error('空文本'));
    const key = this.cacheKey(text, voiceId, rate);
    const hit = this.cache.get(key);
    if (hit) return hit;

    const promise = (async () => {
      // 未指定音色时用第一个可用音色，避免把 'default' 发给 sidecar
      const voice = voiceId ?? this.voice;
      const resolved = voice === 'default' ? await this.effectiveVoice() : voice;
      const response = await fetch('/api/tts/piper/synthesize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice: resolved, rate, noiseScale: this.noiseScale, noiseWScale: this.noiseWScale }),
        signal: AbortSignal.timeout(SYNTH_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`Piper 合成失败（HTTP ${response.status}）`);
      return response.blob();
    })();

    this.cache.set(key, promise);
    if (this.cache.size > CACHE_LIMIT) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) this.cache.delete(firstKey);
    }
    // 合成失败的项从缓存里摘掉，避免下次复用坏 Promise
    promise.catch(() => { if (this.cache.get(key) === promise) this.cache.delete(key); });
    return promise;
  }

  /**
   * Player 的预生成钩子：提前合成后续几句。
   *
   * 关键：预取请求必须**排在 speak 之后**发起，并且一次只合成一句。
   * Player 会先触发 prefetch 再 speak，若两者同时发 fetch，sidecar 串行
   * 处理时会把当前句（speak）排到预取句后面——表现为"点播放十几秒没声音"。
   * 这里把预取放进队列，延迟一个微任务让 speak 的 fetch 先发出，空闲时再补。
   */
  prefetch(texts: string[], settings: PrefetchParams): void {
    let added = 0;
    for (const t of texts) {
      if (!t || !t.trim()) continue;
      const key = this.cacheKey(t, settings.voiceId, settings.rate);
      if (this.cache.has(key)) continue; // 已合成/正在合成
      this.pendingPrefetch.push({ text: t, voiceId: settings.voiceId, rate: settings.rate });
      added += 1;
    }
    if (added === 0) return;
    // 微任务里再发起：等当前调用栈里的 speak 先把 fetch 送出去
    queueMicrotask(() => this.drainPrefetch());
  }

  private drainPrefetch(): void {
    if (this.prefetchBusy) return;
    const next = this.pendingPrefetch.shift();
    if (!next) return;
    this.prefetchBusy = true;
    void this.synthesize(next.text, next.voiceId, next.rate)
      .catch(() => undefined)
      .finally(() => {
        this.prefetchBusy = false;
        this.drainPrefetch();
      });
  }

  speak(params: SpeakParams, handlers: SpeakHandlers): SpeakHandle {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;

    let objectUrl: string | undefined;
    let audio: HTMLAudioElement | undefined;
    let settled = false;

    const cleanup = () => {
      if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = undefined; }
      audio = undefined;
    };

    void (async () => {
      try {
        // 尝试命中缓存的合成结果；prefetch 已把后续句子的音频备好
        const blob = await this.synthesize(params.text, params.voiceId, params.rate);
        if (controller.signal.aborted || settled) return;

        objectUrl = URL.createObjectURL(blob);
        audio = new Audio(objectUrl);
        audio.volume = Math.max(0, Math.min(1, params.volume));

        audio.onplay = () => { if (!controller.signal.aborted && !settled) handlers.onStart?.(); };
        audio.onended = () => { if (controller.signal.aborted || settled) return; settled = true; cleanup(); handlers.onEnd?.(); };
        audio.onerror = () => { if (controller.signal.aborted || settled) return; settled = true; cleanup(); handlers.onError?.(new Error('Piper 音频播放失败')); };

        await audio.play();
      } catch (error) {
        if (controller.signal.aborted || settled) return;
        settled = true;
        cleanup();
        handlers.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    })();

    return {
      cancel: () => {
        controller.abort();
        audio?.pause();
      },
    };
  }

  cancel(): void {
    this.controller?.abort();
    this.controller = null;
  }
}

function clampNum(v: number, min: number, max: number, fallback: number): number {
  if (Number.isNaN(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}
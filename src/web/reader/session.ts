import ePub from 'epubjs';
import type { BookMeta, ReadingProgress, TocEntry } from '@shared/book.ts';
import { api } from '@/api';
import { Player, EngineDriver, type PlayerState } from '@/tts/player';
import { WebSpeechEngine } from '@/tts/WebSpeechEngine';
import { PiperEngine } from '@/tts/PiperEngine';
import type { TtsEngine, TtsVoice } from '@/tts/types';
import type { TextChunk } from '@/tts/chunk';
import {
  chapterRange,
  extractChapterSentences,
  offsetFromDomPosition,
  sentenceIndexAt,
  type ChapterSentences,
} from './sentences';
import { SentenceHighlighter, type ContentsLike } from './highlight';
import {
  DEFAULT_SETTINGS,
  MAX_CONTENT_WIDTH_PX,
  WIDTH_PERCENT_RANGE,
  clampPercent,
  type ReaderSettings,
  type TtsEngineKind,
} from './settings';

// 这些设置类型与常量定义在 ./settings，供 App 等轻量模块复用而不牵连 epub.js
export { DEFAULT_SETTINGS, MAX_CONTENT_WIDTH_PX, WIDTH_PERCENT_RANGE } from './settings';
export type { ReadFlow, ReaderSettings, TtsEngineKind } from './settings';
void MAX_CONTENT_WIDTH_PX;

/**
 * 这里不直接用 epub.js 自带的类型声明（它的导出形态在不同打包器下不一致，
 * 类型也未必与运行时完全对应），只声明我们真正用到的方法，
 * 这样接口是明确的，也不会因为第三方类型变化而编译不过。
 */
interface EpubSection {
  href: string;
  document?: Document;
  load(request?: unknown): Promise<unknown>;
  unload?(): void;
}

interface EpubSpine {
  spineItems: EpubSection[];
  get(href: string): EpubSection | null;
}

interface EpubLocations {
  generate(chars: number): Promise<unknown>;
  percentageFromCfi(cfi: string): number | undefined;
}

interface EpubBook {
  spine: EpubSpine;
  locations: EpubLocations;
  load(path: string): Promise<unknown>;
  renderTo(element: HTMLElement, options: Record<string, unknown>): EpubRendition;
  destroy(): void;
}

interface EpubRendition {
  /** epub.js 的 display 接受 CFI / href 字符串，也接受 section 对象。 */
  display(target?: string | EpubSection): Promise<void>;
  next(): Promise<void>;
  prev(): Promise<void>;
  getContents(): ContentsLike[];
  on(event: string, handler: (...args: never[]) => void): void;
  destroy?(): void;
}

/** epub.js 的入口在 CJS/ESM 互操作下可能是函数本身，也可能是 { default: fn }。 */
const createBook = ePub as unknown as (input: ArrayBuffer | string) => EpubBook;

/** 主题对应的正文配色。 */
const THEME_STYLES: Record<ReaderSettings['theme'], { bg: string; fg: string; muted: string }> = {
  dark: { bg: '#16181d', fg: '#e8eaed', muted: '#9aa0a6' },
  light: { bg: '#ffffff', fg: '#1f2328', muted: '#5b6167' },
  sepia: { bg: '#f4ecd8', fg: '#4a3f2f', muted: '#7a6a52' },
};

export interface SessionState {
  status: 'loading' | 'ready' | 'error';
  error?: string;
  /** 当前章节在 spine 中的下标。 */
  chapterIndex: number;
  chapterCount: number;
  chapterLabel: string;
  /** 当前节的 href，目录据此高亮（按 href 匹配而非序号）。 */
  chapterHref?: string;
  sentenceIndex: number;
  sentenceCount: number;
  /** 0~1 */
  percent: number;
  player: PlayerState;
  toc: TocEntry[];
  /** 当前高亮范围，供 UI 显示"正在读这句"。 */
  currentText: string;
}

export interface SessionCallbacks {
  onState: (state: SessionState) => void;
  /** 保存进度失败等非致命问题。 */
  onNotice?: (message: string) => void;
  /**
   * 每次章节渲染完成后回调，传入该章 iframe 的 document。
   * 因为翻章会换掉整个 document，点击起读的监听必须在每次渲染后重新挂。
   */
  onContents?: (doc: Document) => void;
}

/**
 * 阅读会话：把 epub.js 渲染、句子抽取与高亮、播放队列、进度回写串在一起。
 *
 * 设计上它是一个纯类（不依赖 React），由 ReaderPage 持有并通过回调把状态推给 UI。
 * 这样播放与渲染的控制流是命令式的、可预测的，不会被 React 的重渲染打断。
 */
export class ReaderSession {
  private book: EpubBook | null = null;
  private rendition: EpubRendition | null = null;
  private chapter: ChapterSentences | null = null;

  private readonly engine: TtsEngine;
  private readonly player: Player;
  private readonly highlighter = new SentenceHighlighter();

  private settings: ReaderSettings;
  private state: SessionState;
  private destroyed = false;
  /** 进度回写的防抖与节流。 */
  private saveTimer: number | null = null;
  private lastSavedCfi: string | undefined;
  /** 当前所在节的 href（归一化后），用于按 href 匹配目录标签。 */
  private currentHref: string | undefined;
  /** 当前已抽取句子的那一节的 href（归一化后），用于避免重复抽取。 */
  private chapterHref = '';
  /** 正在进行跨章续读：此期间 onRendered 不得重置播放队列（会打断续读）。 */
  private isContinuation = false;
  /**
   * 目录标签表：spine 节 href（归一化）→ 章节标题。
   *
   * 为什么需要它：目录项数与 spine 节数**并不总是相等**。
   * 本例的 epub 有 1516 节但目录只有 1514 项（前两节是封面类内容，不在目录里），
   * 于是「目录第 i 项」与「第 i 节正文」整体错开 2 位，
   * 用序号取标题会让顶部标题比正文内容早两章。
   * 用 href 匹配则与序号偏移无关。
   */
  private labelsByHref = new Map<string, string>();
  /** 分页模式需要 locations 才能算百分比，它比较慢，懒加载。 */
  private locationsReady = false;

  constructor(
    private readonly meta: BookMeta,
    private readonly callbacks: SessionCallbacks,
    settings: ReaderSettings = DEFAULT_SETTINGS,
    engineKind: TtsEngineKind = 'webspeech',
  ) {
    this.settings = { ...settings };
    this.labelsByHref = buildLabelMap(meta.toc ?? []);
    this.engine = engineKind === 'piper'
      ? new PiperEngine()
      : new WebSpeechEngine();
    this.state = {
      status: 'loading',
      chapterIndex: 0,
      chapterCount: meta.chapterCount || 0,
      chapterLabel: '',
      sentenceIndex: 0,
      sentenceCount: 0,
      percent: meta.progress?.percent ?? 0,
      player: { status: 'idle', index: 0, boundary: null },
      toc: meta.toc ?? [],
      currentText: '',
    };

    // 驱动负责把引擎侧下标换算成「整章朗读文本」坐标
    const driver = new EngineDriver(this.engine, () => this.playerSettings);
    // "先合成再播放"的引擎（Piper）首次合成可能要等模型加载/切换，
    // 启动看门狗默认 12s 会把它误判为卡死而跳过句子（表现为"高亮在跑但没声音"），
    // 所以给 Piper 更长的容忍；WebSpeech 是即时的，保留默认值。
    const playerOptions =
      engineKind === 'piper'
        ? { startTimeoutMs: 120_000 }
        : {};
    this.player = new Player(driver, {
      onState: (ps) => this.patchState({ player: ps }),
      onChunk: (chunk, index) => this.onChunk(chunk, index),
      // "先合成再播放"的引擎需要提前生成后续句子；内置引擎不需要，回调为空实现
      onPrefetch: (index) => this.upcomingTexts(index),
      onNeedMore: () => this.loadNextChapterChunks(),
      onFinished: () => this.onFinished(),
    }, playerOptions);
  }

  /** 取当前句之后的若干句文本，供引擎预生成。 */
  private upcomingTexts(fromIndex: number, count = 2): string[] {
    const chunks = this.player.getChunks();
    return chunks
      .slice(fromIndex + 1, fromIndex + 1 + count)
      .map((c) => c.text)
      .filter((t) => t.trim().length > 0);
  }

  /** 朗读参数集中在这里，EngineDriver 每次发声时读取。 */
  private playerSettings = { voiceId: undefined as string | undefined, rate: 1, pitch: 1, volume: 1 };

  /* ------------------------------- 生命周期 ------------------------------- */

  async open(container: HTMLElement): Promise<void> {
    try {
      const bytes = await this.fetchBook();
      const book = createBook(bytes);
      this.book = book;

      this.rendition = book.renderTo(container, {
        width: '100%',
        height: '100%',
        // 滚动模式对连续朗读友好：不会因为翻页把正在读的句子切到上一页
        flow: this.settings.flow,
        spread: 'none',
        allowScriptedContent: false,
      });

      // 章节切换：重新抽取句子并续读
      this.rendition.on('rendered', (_section: unknown, view: { contents?: ContentsLike }) => {
        // 这里刻意 catch 并打日志：onRendered 是异步的，若异常冒泡出去
        // 会把整个界面搞崩（实测表现为整棵树被卸载、页面变空白），
        // 而且错误信息会丢失，很难定位。
        void this.onRendered(view).catch((err: unknown) => {
          console.error('[reader] onRendered 失败', err);
        });
      });
      // 位置变化：记录进度
      this.rendition.on('relocated', (location: EpubLocation) => this.onRelocated(location));
      // 字号/布局变化后重新定位高亮
      this.rendition.on('resized', () => this.highlighter.refresh());
      this.applySettings();
      const rendered = await this.displayInitial();

      this.state.chapterCount = book.spine?.spineItems?.length ?? this.state.chapterCount;
      // displayInitial 失败时它已经把状态置为 error，不要覆盖掉
      this.patchState({ status: rendered ? 'ready' : this.state.status });
    } catch (err) {
      this.patchState({ status: 'error', error: (err as Error).message });
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.player.dispose();
    this.engine.dispose?.();
    this.highlighter.clear();
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.book?.destroy();
    this.book = null;
    this.rendition = null;
    this.chapter = null;
  }

  private async fetchBook(): Promise<ArrayBuffer> {
    const url = api.bookFileUrl(this.meta.id);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`无法读取书籍文件（HTTP ${res.status}）`);
    const buf = await res.arrayBuffer();
    if (buf.byteLength === 0) throw new Error('书籍文件为空，请重新导入');
    return buf;
  }

  /**
   * 打开书时的初始定位。
   *
   * 关键：一次失败的 `display(cfi)` 会把 rendition 的内部状态弄脏，
   * 之后即使再调用无参 `display()`（本应渲染第一段）也**什么都不会发生**，
   * 界面就永远停在"正在打开书籍"。
   * 所以每次失败后都要先 `display(firstHref)` 把状态拉回来，
   * 并且每一步都以"是否真的渲染出内容"为准来决策，而不是只看是否抛错。
   */
  private async displayInitial(): Promise<boolean> {
    const progress = this.meta.progress;
    const spineItems = this.book?.spine?.spineItems ?? [];
    const firstSection = spineItems[0] ?? null;

    // 严格串行、每步都确认真的渲染出内容。
    // 注意：进度里存的 href 与目录 href 都可能带 OPF 目录前缀，
    // 而 epub.js 的 spine 键不一定相同，所以 href 一律先解析成 section 对象，
    // 否则会抛 "No Section Found"（曾经导致"打开书就报无法渲染"和"点目录没反应"）。
    const firstResolved = this.resolveSection(spineItems[0]?.href ?? '');
    const progressResolved = progress?.href ? this.resolveSection(progress.href) : null;

    if (progress?.cfi) {
      const ok = await this.tryDisplay(progress.cfi, 1500);
      if (ok) return true;
      this.callbacks.onNotice?.('上次的阅读位置已失效，已回到章节开头');
    }

    if (progressResolved) {
      if (await this.tryDisplaySection(progressResolved, 2500)) return true;
    }

    if (firstResolved) {
      if (await this.tryDisplaySection(firstResolved, 2500)) return true;
    }

    // 最后兜底：无参 display，交给 epub.js 自己决定从哪开始
    if (await this.tryDisplayUndefined(2500)) return true;

    void firstSection;

    // 全部失败：与其静默卡在"打开中"，不如明确报错
    this.patchState({
      status: 'error',
      error: '这本书无法渲染。可能是文件损坏、受 DRM 保护，或格式不被支持。',
    });
    return false;
  }

  /** 执行一次 display 并等待内容出现；任何异常都不外抛。 */
  private async tryDisplay(target: string | undefined, timeoutMs: number): Promise<boolean> {
    if (!target) return false;
    try {
      await this.rendition!.display(target);
    } catch {
      // 失败原因会通过 onNotice 告知用户；这里不刷控制台
      return false;
    }
    return this.waitForContent(timeoutMs);
  }

  /**
   * 兜底：按 section 对象定位。
   *
   * 必须先 `unload()`：epub.js 会缓存已渲染过的 section，
   * 直接 display 一个缓存过的 section 时它可能直接 resolve 而不重新渲染，
   * 表现为"点目录没反应，正文还是原来那一页"（实测踩到过）。
   * 卸载后再显示，才会真正重新加载内容并触发 rendered 事件。
   */
  private async tryDisplaySection(
    section: EpubSection | null | undefined,
    timeoutMs: number,
  ): Promise<boolean> {
    if (!section) return false;
    // 传 href 字符串而不是 section 对象：
    // epub.js 的 display 对非字符串目标支持并不完整，实测传 section 对象时
    // 既不报错也不导航（内容保持不变），只有字符串才会真正切换。
    const target = section.href;
    try {
      await this.rendition!.display(target);
    } catch {
      return false;
    }
    // 要求"当前节确实变成了目标节"，否则视为失败（旧内容仍在 = 没切过去）
    return this.waitForContent(timeoutMs, target);
  }

  /** 兜底：无参 display，交给 epub.js 自己决定从哪开始。 */
  private async tryDisplayUndefined(timeoutMs: number): Promise<boolean> {
    try {
      await this.rendition!.display();
    } catch {
      return false;
    }
    return this.waitForContent(timeoutMs);
  }

  /**
   * 轮询等待渲染出实际内容。
   *
   * 判断依据是 iframe 里真的有文本，**且**（若给了 expectHref）当前所在位置
   * 已经变成目标节。只检查"有文本"是不够的：切换章节失败时旧内容仍在，
   * 会被误判为成功（实测因此误以为 display 生效了）。
   */
  private async waitForContent(timeoutMs: number, expectHref?: string): Promise<boolean> {
    const step = 120;
    const deadline = Date.now() + timeoutMs;
    const want = expectHref ? normalizeHref(expectHref) : '';
    for (;;) {
      if (this.destroyed) return false;

      const contents = this.rendition?.getContents?.()[0];
      const body = contents?.document?.body;
      const hasText = Boolean(body && (body.textContent ?? '').trim().length > 0);

      if (hasText) {
        if (!want) return true;
        // 归一化比较，忽略 OPF 目录前缀差异
        const now = this.currentHref ? normalizeHref(this.currentHref) : '';
        if (now === want) return true;
      }

      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, step));
    }
  }

  /* -------------------------------- 渲染后 -------------------------------- */

  private async onRendered(view: { contents?: ContentsLike }): Promise<void> {
    if (this.destroyed) return;
    const contents = view?.contents ?? this.rendition?.getContents()?.[0];
    if (!contents) return;

    const doc: Document | undefined =
      contents.document ?? (contents.content as Document | undefined) ?? undefined;
    const body = doc?.body ?? (contents.content as Element | undefined);
    if (!body) return;

    const renderedHref = this.currentHref ? normalizeHref(this.currentHref) : '';

    // 跨章续读期间不能让 onRendered 重置播放队列。
    // loadNextChapterChunks 已经抽好下一章并追加进队列，
    // 而 setChunks() 会打断播放并清空状态——实测表现为
    // "自动切到下一章后朗读就停了，得手动再点播放"。
    //
    // 但仍然必须**抽取新章节的正文**：高亮要用它的坐标，
    // 不抽的话续读会拿旧章节的坐标去定位，高亮会跑到错误位置。
    if (this.isContinuation) {
      this.isContinuation = false;
      this.highlighter.attach(contents);
      this.chapter = extractChapterSentences(body as Element);
      this.chapterHref = renderedHref;
      this.applySettings();
      this.patchState({
        sentenceCount: this.chapter.sentences.length,
        chapterLabel: this.currentSectionLabel(),
      });
      if (doc) this.callbacks.onContents?.(doc);
      return;
    }

    // 跨章续读时 loadNextChapterChunks 已经抽好并追加了下一章的句子，
    // 这里再抽一遍会重复追加（虽然播放位置不会乱，但队列会白长一倍）。
    // 同一个节渲染两次（首次 display 一次、续读时再一次）属于正常情况。
    if (renderedHref && renderedHref === this.chapterHref) {
      this.highlighter.attach(contents);
      this.applySettings();
      return;
    }

    // 注意：这里用的是**实际渲染出来的 iframe 文档**，而不是 section.document。
    // section.document 会被 section.load() 缓存，而 loadNextChapterChunks 为了预先
    // 抽取下一章也会调 load，于是缓存的可能是别的内容（实测曾把封面页当成正文）。
    this.highlighter.attach(contents);
    this.chapter = extractChapterSentences(body as Element);
    this.chapterHref = renderedHref;

    // 每次渲染后都要重新应用排版样式。
    // 原因是 open() 里那次 applySettings 跑在 iframe 创建之前，
    // 那时 getContents() 还是空的；而偏好没变化时不会再触发应用，
    // 结果正文一直是书的原始样式（实测左右内边距 114px，远超设定值）。
    this.applySettings();

    // 通知 UI：新 document 已就绪，可以重新绑定点击起读
    if (doc) this.callbacks.onContents?.(doc);

    this.player.setChunks(this.toChunks(this.chapter), 0);

    const label = this.currentSectionLabel();
    this.patchState({
      sentenceCount: this.chapter.sentences.length,
      sentenceIndex: 0,
      chapterLabel: label,
      currentText: '',
    });

    // 恢复到该章节内的句子位置（跨设备/刷新后继续）
    const wanted = this.meta.progress?.sentenceIndex;
    if (wanted && wanted > 0 && wanted < this.chapter.sentences.length) {
      this.player.setChunks(this.toChunks(this.chapter), wanted);
      this.patchState({ sentenceIndex: wanted });
    }

    void this.ensureLocations();
  }

  private toChunks(chapter: ChapterSentences): TextChunk[] {
    return chapter.sentences.map((s) => ({ text: s.text, start: s.start, end: s.end }));
  }

  private onRelocated(location: EpubLocation): void {
    if (this.destroyed) return;
    const cfi = location?.start?.cfi;
    const href = location?.start?.href;

    if (cfi) this.lastSavedCfi = cfi;
    if (href) this.currentHref = href;

    const index = this.chapterIndexOfHref(href);
    let percent = this.state.percent;
    if (this.locationsReady && cfi) {
      try {
        percent = this.book!.locations.percentageFromCfi(cfi) ?? percent;
      } catch {
        /* 忽略 */
      }
    }

    this.patchState({
      chapterIndex: index,
      percent,
      chapterLabel: this.currentSectionLabel(),
      chapterHref: this.currentHref,
    });
    this.scheduleSave();
  }

  private chapterIndexOfHref(href?: string): number {
    if (!href || !this.book) return this.state.chapterIndex;
    const items = this.book.spine?.spineItems ?? [];
    const clean = href.split('#')[0] ?? '';
    const idx = items.findIndex((it: EpubSection) => (it.href ?? '').split('#')[0] === clean);
    return idx >= 0 ? idx : this.state.chapterIndex;
  }

  private currentSectionLabel(): string {
    // 优先按 href 匹配：目录项数与 spine 节数可能不相等（见 labelsByHref 注释），
    // 按序号取名会整体偏移若干章。
    if (this.currentHref) {
      const byHref = this.labelsByHref.get(normalizeHref(this.currentHref));
      if (byHref) return byHref;
    }
    const flat = flattenToc(this.state.toc);
    if (flat.length === 0) return this.state.chapterIndex >= 0 ? `第 ${this.state.chapterIndex + 1} 节` : '';
    // href 匹配不到时（例如节不在目录里）退化为序号，至少不是空标题
    const idx = Math.min(this.state.chapterIndex, flat.length - 1);
    return flat[idx]?.label ?? `第 ${this.state.chapterIndex + 1} 节`;
  }

  private async ensureLocations(): Promise<void> {
    if (this.locationsReady || !this.book) return;
    try {
      await this.book.locations.generate(1600);
      this.locationsReady = true;
    } catch {
      // locations 生成失败只影响百分比显示，不影响阅读
    }
  }

  /* --------------------------------- 播放 --------------------------------- */

  private onChunk(chunk: TextChunk, index: number): void {
    if (!this.chapter) return;
    const range = chapterRange(this.chapter, chunk.start, chunk.end);
    this.highlighter.highlight(range);
    // 高亮后把视口带到该句，实现"自动跟随"
    this.highlighter.scrollIntoView(range);
    this.patchState({ sentenceIndex: index, currentText: chunk.text });
    this.scheduleSave();
  }

  private onFinished(): void {
    this.highlighter.highlight(null);
    this.patchState({ currentText: '' });
  }

  /**
   * 当前章读完时被 Player 调用：抽取下一章并追加到队列。
   * 返回 true 表示已追加，Player 会继续播放。
   */
  private async loadNextChapterChunks(): Promise<boolean> {
    if (!this.book || !this.chapter) return false;
    const items = this.book.spine?.spineItems ?? [];
    if (items.length === 0) return false;

    // 用当前 href 精确定位所在节，再取下一节；
    // 不依赖 state.chapterIndex（它可能还没被 relocated 更新）。
    const currentIndex = this.currentHref
      ? items.findIndex((it: EpubSection) => normalizeHref(it.href ?? '') === normalizeHref(this.currentHref!))
      : this.state.chapterIndex;
    const nextIndex = (currentIndex < 0 ? this.state.chapterIndex : currentIndex) + 1;
    if (nextIndex >= items.length) return false;

    const target = items[nextIndex]!;
    const section = this.resolveSection(target.href ?? '');
    if (!section) return false;

    try {
      if (!section.document) await section.load(this.book.load.bind(this.book));
      const body = section.document?.body;
      if (!body) return false;
      const chapter = extractChapterSentences(body);
      if (chapter.sentences.length === 0) return false;

      // 关键：先追加句子，再切画面。
      // 顺序不能反——切画面会触发 onRendered，若那时队列还没追加，
      // 播放器会误判为"没有更多内容"而停止。
      this.player.appendChunks(this.toChunks(chapter));

      // 音频续读的同时必须把画面也切过去，否则会出现
      // "声音已经读到下一章、界面还停在上一章"（实测遇到过）。
      // isContinuation 期间 onRendered 不会重置队列，保证续读不被打断。
      this.isContinuation = true;
      const ok = await this.tryDisplaySection(section, 2500);
      if (!ok) {
        // 画面没切成功：解除保护，让后续渲染走正常流程
        this.isContinuation = false;
      }
      return true;
    } catch {
      this.isContinuation = false;
      return false;
    }
  }

  async play(): Promise<void> {
    if (!this.chapter) return;
    // 队列还没建立（例如刚打开就点播放）时，用当前章内容补上
    if (this.player.getChunks().length === 0) {
      this.player.setChunks(this.toChunks(this.chapter), 0);
    }
    await this.player.play();
  }

  pause(): void {
    this.player.pause();
  }

  async toggle(): Promise<void> {
    const s = this.player.getState();
    if (s.status === 'playing') this.pause();
    else await this.play();
  }

  async nextSentence(): Promise<void> {
    await this.player.next();
  }

  async prevSentence(): Promise<void> {
    await this.player.previous();
  }

  /**
   * 把正文点击位置换算成「所在句」的信息。
   *
   * 点击不再直接开始朗读，而是先弹出菜单让用户选，
   * 所以这里只做换算、不产生副作用。
   */
  locatePoint(
    node: Node,
    offset: number,
  ): { sentenceIndex: number; text: string } | null {
    if (!this.chapter) return null;
    const charIndex = offsetFromDomPosition(this.chapter, node, offset);
    if (charIndex < 0) return null;
    const sentenceIndex = sentenceIndexAt(this.chapter, charIndex);
    const sentence = this.chapter.sentences[sentenceIndex];
    if (!sentence) return null;
    return { sentenceIndex, text: sentence.text };
  }

  /** 从指定的句子开始朗读；已在播放时会打断重来。 */
  async readFromSentence(sentenceIndex: number): Promise<void> {
    if (!this.chapter) return;
    if (this.player.getChunks().length === 0) {
      this.player.setChunks(this.toChunks(this.chapter), 0);
    }
    await this.player.play(sentenceIndex);
  }

  /** 取某个句子的 DOM Range（跨段落也可）；用于标记选中的句子与定位句首。 */
  sentenceRange(sentenceIndex: number): Range | null {
    if (!this.chapter) return null;
    const sentence = this.chapter.sentences[sentenceIndex];
    if (!sentence) return null;
    return chapterRange(this.chapter, sentence.start, sentence.end);
  }

  /**
   * 在正文里高亮某个句子（点击选中时的标记）。
   * 传入 null 清除标记。与播放中的高亮共用同一个覆盖层。
   */
  markSentence(sentenceIndex: number | null): void {
    if (sentenceIndex === null) {
      this.highlighter.highlight(null);
      return;
    }
    const range = this.sentenceRange(sentenceIndex);
    if (range) this.highlighter.highlight(range);
  }

  /** 从正文点击位置开始朗读（保留给快捷路径使用）。 */
  async readFromPoint(node: Node, offset: number): Promise<void> {
    const located = this.locatePoint(node, offset);
    if (!located) return;
    await this.readFromSentence(located.sentenceIndex);
  }

  setRate(rate: number): void {
    this.playerSettings = { ...this.playerSettings, rate };
    this.player.setRate(rate);
  }

  setVolume(volume: number): void {
    this.playerSettings = { ...this.playerSettings, volume };
    this.player.setVolume(volume);
  }

  setVoice(voiceId: string | undefined): void {
    this.playerSettings = { ...this.playerSettings, voiceId };
    this.player.setVoice(voiceId);
  }

  /** 设置 Piper 音色稳定度与韵律起伏（引擎支持才生效）。 */
  setPiperNoise(noiseScale: number, noiseWScale: number): void {
    const engine = this.engine as TtsEngine & { setNoise?: (n: number, w: number) => void };
    engine.setNoise?.(noiseScale, noiseWScale);
  }


  async listVoices(): Promise<TtsVoice[]> {
    return this.engine.listVoices();
  }

  /* -------------------------------- 章节导航 ------------------------------- */

  /**
   * 按 href 解析出 spine 里的 section 对象。
   *
   * 必须做这步的原因：目录里的 href 往往带 OPF 目录前缀（`OEBPS/text00106.html`），
   * 而 epub.js 的 `spine.get()` 用的是它自己注册的键（通常是 OPF 相对路径
   * `text00106.html`）。直接把目录 href 交给 `display()` 会抛 "No Section Found"，
   * 表现为"点目录没反应"。
   *
   * 由外到内逐级放宽匹配：原样 → 归一化（去锚点/解码）→ 只比文件名。
   */
  private resolveSection(href: string): EpubSection | null {
    const spine = this.book?.spine;
    if (!spine || !href) return null;
    const wanted = normalizeHref(href);

    // 1. 原样命中
    const direct = spine.get(href);
    if (direct) return direct;

    const items = spine.spineItems ?? [];

    // 2. 归一化命中
    let hit = items.find((it: EpubSection) => normalizeHref(it.href ?? '') === wanted);
    if (hit) return hit;

    // 3. 只比文件名（应对不同的目录前缀写法）
    hit = items.find((it: EpubSection) => {
      const a = (it.href ?? '').split('/').pop() ?? '';
      const b = href.split('/').pop() ?? '';
      return a && b && decodeURIComponent(a).toLowerCase() === decodeURIComponent(b).toLowerCase();
    });
    return hit ?? null;
  }

  async goToHref(href: string): Promise<void> {
    if (!this.rendition) return;
    // 切章时停掉当前朗读，避免高亮落到已失效的 document 上
    this.player.pause();
    this.highlighter.highlight(null);

    // 目录 href 常带 OPF 目录前缀，而 epub.js 的 spine 键不一定相同，
    // 必须先解析成它认识的那个键（见 resolveSection 注释）
    const section = this.resolveSection(href);
    if (!section) {
      this.callbacks.onNotice?.('目录里的这个位置在当前文件里找不到，可能书籍文件已损坏');
      return;
    }
    await this.tryDisplaySection(section, 2500);
  }

  async nextChapter(): Promise<void> {
    this.player.pause();
    this.highlighter.highlight(null);
    await this.stepSection(1);
  }

  async prevChapter(): Promise<void> {
    this.player.pause();
    this.highlighter.highlight(null);
    await this.stepSection(-1);
  }

  /**
   * 按 spine 顺序前进/后退一节。
   *
   * 刻意不用 `rendition.next()/prev()`：目录与 spine 的序号可能错开，
   * 而且用 section 对象定位更可控（与 goToHref 走同一条路径）。
   */
  private async stepSection(delta: number): Promise<void> {
    const items = this.book?.spine?.spineItems ?? [];
    if (items.length === 0) return;

    // 正文还没渲染出来时切换会静默失败（用户点了没任何反应）。
    // 实测：打开书后立刻点"下一章"，此时 iframe 还没就绪，
    // display 会失败。这里给一句明确提示，而不是假装什么都没发生。
    if (!this.hasRenderedContent()) {
      this.callbacks.onNotice?.('书籍还在加载，请稍候再切换章节');
      return;
    }

    const index = this.currentSectionIndex();
    const target = items[index + delta];
    if (!target) return;

    const ok = await this.tryDisplaySection(target, 2500);
    if (!ok) this.callbacks.onNotice?.('切换章节失败，已停留在当前章节');
  }

  /** 当前是否已有可操作的正文内容。 */
  private hasRenderedContent(): boolean {
    const body = this.rendition?.getContents?.()[0]?.document?.body;
    return Boolean(body && (body.textContent ?? '').trim().length > 0);
  }

  /** 当前所在节在 spine 中的下标；优先按 href 精确匹配。 */
  private currentSectionIndex(): number {
    const items = this.book?.spine?.spineItems ?? [];
    if (this.currentHref) {
      const wanted = normalizeHref(this.currentHref);
      const idx = items.findIndex((it: EpubSection) => normalizeHref(it.href ?? '') === wanted);
      if (idx >= 0) return idx;
    }
    return Math.max(0, this.state.chapterIndex);
  }

  /* --------------------------------- 设置 --------------------------------- */

  applySettings(next: Partial<ReaderSettings> = {}): void {
    this.settings = { ...this.settings, ...next };
    const rendition = this.rendition;
    const contents = rendition?.getContents?.() ?? [];
    const theme = THEME_STYLES[this.settings.theme];

    const css = {
      'background-color': theme.bg,
      color: theme.fg,
      'font-size': `${this.settings.fontSize}px`,
      'line-height': String(this.settings.lineHeight),
      'font-family': this.settings.fontFamily,
      // border-box 很关键：否则 max-width 与左右内边距会叠加，
      // 实际文字宽度比预期窄，宽窗口下也无法正确居中。
      'box-sizing': 'border-box',
      // 左右留白用 clamp：窄屏只占很小比例、宽屏有上限。
      // 下限 0.4rem 是为了让窄屏（手机）的正文占比尽量接近设定的行宽百分比。
      'padding-left': 'clamp(0.4rem, 3.5vw, 2.6rem)',
      'padding-right': 'clamp(0.4rem, 3.5vw, 2.6rem)',
      'padding-top': '0.6rem',
      'padding-bottom': '4rem',
      // 超长单词/URL 不换行会把内容顶出可视区
      'overflow-wrap': 'break-word',
      'word-break': 'break-word',
      'overflow-x': 'hidden',
    } as const;
    // 行宽（max-width）与居中交给注入的样式表处理，那里需要 !important 才能压过书自带样式

    for (const item of contents) {
      const doc = item.document;
      const root = doc?.documentElement;
      if (!root) continue;
      for (const [k, v] of Object.entries(css)) root.style.setProperty(k, v);

      const body = doc?.body;
      if (body) {
        body.style.setProperty('background-color', theme.bg);
        body.style.setProperty('color', theme.fg);
        body.style.setProperty('margin', '0');
        body.style.setProperty('box-sizing', 'border-box');
        body.style.setProperty('overflow-wrap', 'break-word');
        body.style.setProperty('word-break', 'break-word');
        // 图片/表格不能超出正文宽度
        body.style.setProperty('max-width', '100%');
      }

      // 图片、表格、代码块等固定宽度内容也会撑破版面；
      // body 的 padding 需要 !important——不少书的自带样式会在 body 上加
      // 很大的左右内边距（实测 114px），把正文挤成窄条。
      // 行宽用 vw 百分比表达，随窗口缩放实时生效；min() 里的 px 是绝对值上限。
      const widthPercent = clampPercent(this.settings.maxWidthPercent);
      const lineHeight = this.settings.lineHeight;
      const layoutCss = `
        html {
          max-width: min(${widthPercent}vw, ${MAX_CONTENT_WIDTH_PX}px) !important;
          margin: 0 auto !important;
          line-height: ${lineHeight} !important;
        }
        body {
          padding-left: 0 !important;
          padding-right: 0 !important;
          /* 行距：必须打在 body/p 上并带 !important——书的自带样式经常在
             p/body 上声明 line-height，若只设置在 html 会被它们盖掉。 */
          line-height: ${lineHeight} !important;
        }
        p, div, li, blockquote, h1, h2, h3, h4, h5, h6 {
          line-height: ${lineHeight} !important;
        }
        img, svg, video, canvas, table { max-width: 100% !important; height: auto; }
        pre, code { white-space: pre-wrap !important; overflow-wrap: break-word !important; }
        * { box-sizing: border-box; }
      `;
      const styleId = 'tts-reader-layout';
      const existing = doc.getElementById(styleId);
      if (existing) {
        // 行宽设置变化后需要更新
        existing.textContent = layoutCss;
      } else {
        const style = doc.createElement('style');
        style.id = styleId;
        style.textContent = layoutCss;
        doc.head?.appendChild(style);
      }
    }
    this.highlighter.refresh();
  }

  getSettings(): ReaderSettings {
    return { ...this.settings };
  }

  getMeta(): BookMeta {
    return this.meta;
  }

  getState(): SessionState {
    return this.state;
  }

  /* -------------------------------- 进度回写 ------------------------------- */

  private scheduleSave(): void {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.saveProgress();
    }, 800);
  }

  private async saveProgress(): Promise<void> {
    const patch: Parameters<typeof api.saveProgress>[1] = {
      percent: this.state.percent,
      chapterIndex: this.state.chapterIndex,
      sentenceIndex: this.state.sentenceIndex,
      cfi: this.lastSavedCfi,
    };
    try {
      await api.saveProgress(this.meta.id, patch);
    } catch (err) {
      this.callbacks.onNotice?.(`进度保存失败：${(err as Error).message}`);
    }
  }

  private patchState(patch: Partial<SessionState>): void {
    this.state = { ...this.state, ...patch };
    this.callbacks.onState(this.state);
  }
}

/* ------------------------------ 类型与工具 ------------------------------ */

/** epub.js 的 relocated 事件载荷（只声明我们用到的字段）。 */
interface EpubLocation {
  start?: { cfi?: string; href?: string; index?: number; percentage?: number };
  end?: { cfi?: string; href?: string };
  atStart?: boolean;
  atEnd?: boolean;
}

/** 目录树拍平成数组，便于按章节序号取标签。 */
export function flattenToc(entries: TocEntry[]): TocEntry[] {
  const out: TocEntry[] = [];
  const walk = (list: TocEntry[]): void => {
    for (const e of list) {
      out.push(e);
      if (e.children?.length) walk(e.children);
    }
  };
  walk(entries);
  return out;
}

/** 行宽百分比夹到合法区间，容错外部传入的脏数据。 */
function clampPercentLocal(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SETTINGS.maxWidthPercent;
  return Math.min(WIDTH_PERCENT_RANGE.max, Math.max(WIDTH_PERCENT_RANGE.min, Math.round(value)));
}
void clampPercentLocal;

/**
 * href 归一化：只比较文件名部分，丢掉目录前缀与锚点。
 *
 * 不同 epub 里目录与 spine 可能分别写成 `text/a.html` 与 `a.html`，
 * 甚至带 `#anchor`，直接字符串比较会大面积匹配失败。
 */
export function normalizeHref(href: string): string {
  const noAnchor = href.split('#')[0] ?? '';
  const parts = noAnchor.split('/');
  return decodeURIComponent(parts[parts.length - 1] ?? '').toLowerCase();
}

/** 由目录树构造「节 href → 章节标题」映射。同一 href 只保留第一条。 */
export function buildLabelMap(toc: TocEntry[]): Map<string, string> {
  const map = new Map<string, string>();
  const walk = (list: TocEntry[]): void => {
    for (const entry of list) {
      const key = entry.href ? normalizeHref(entry.href) : '';
      if (key && !map.has(key)) map.set(key, entry.label);
      if (entry.children?.length) walk(entry.children);
    }
  };
  walk(toc);
  return map;
}

/** 由 BookMeta.progress 生成一个便于展示的描述。 */
export function describeProgress(progress?: ReadingProgress): string {
  if (!progress) return '尚未开始';
  return `已读 ${Math.round(progress.percent * 100)}%`;
}

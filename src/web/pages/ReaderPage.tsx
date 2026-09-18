import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BookMeta, TocEntry } from '@shared/book.ts';
import { api } from '@/api';
import { PlayerBar } from '@/components/PlayerBar';
import {
  ReaderSession,
  WIDTH_PERCENT_RANGE,
  normalizeHref,
  type ReaderSettings,
  type SessionState,
  type TtsEngineKind,
} from '@/reader/session';
import { useLibrary } from '@/store/library';
import { useReaderPrefs } from '@/store/readerPrefs';
import type { TtsVoice } from '@/tts/types';

/**
 * 需要"跳句"自动化验证时（跨章续读、离线语音推进），把当前会话挂到 window。
 *
 * 为什么需要：播放条左右按钮现在切换**章节**，界面上没有跳句入口，
 * 而这类测试要快速推进到章末，只能走会话 API。
 *
 * 用构建期开关而不是 `import.meta.env.DEV`：dev 模式下 Vite 的 HMR 会让
 * 验证结果不稳定，所以测试要跑在**生产构建**上；但默认的生产构建里
 * 这段应当被摇掉，不给最终用户留全局引用。
 *
 *   VITE_EXPOSE_TEST_HOOKS=1 pnpm build   # 产出带测试钩子的构建
 */
declare global {
  interface Window {
    __dshReaderSession?: unknown;
  }
}

const EXPOSE_TEST_HOOKS = import.meta.env.VITE_EXPOSE_TEST_HOOKS === '1';

function exposeSession(session: ReaderSession | null): void {
  if (!EXPOSE_TEST_HOOKS) return;
  window.__dshReaderSession = session;
}

export function ReaderPage({ bookId, onExit }: { bookId: string; onExit: () => void }) {
  const prefs = useReaderPrefs();
  const setPrefs = useReaderPrefs((s) => s.set);
  const setToast = useLibrary((s) => s.setToast);
  // 单独取出引擎种类：它参与会话创建的依赖，必须是稳定值而非整个 prefs 对象
  const ttsEngine = useReaderPrefs((s) => s.ttsEngine);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const sessionRef = useRef<ReaderSession | null>(null);
  /** 当前 iframe 的 document 上的点击监听清理函数（翻章后需重挂）。 */
  const contentsCleanup = useRef<(() => void) | null>(null);
  const [meta, setMeta] = useState<BookMeta | null>(null);
  const [state, setState] = useState<SessionState | null>(null);
  const [voices, setVoices] = useState<TtsVoice[]>([]);
  const [voiceLoading, setVoiceLoading] = useState(true);
  const [tocOpen, setTocOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** 正文点击后弹出的操作菜单；null 表示不显示。 */
  const [clickMenu, setClickMenu] = useState<TextPointSelection | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // 会话创建要用到最新偏好，但又不该在偏好变化时重建会话，
  // 所以放进 ref 由回调 ref 读取。
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  /* --------------------------- 加载书籍元数据 --------------------------- */

  useEffect(() => {
    let cancelled = false;
    setMeta(null);
    setLoadError(null);
    api
      .listBooks()
      .then((books) => {
        if (cancelled) return;
        const found = books.find((b) => b.id === bookId);
        if (!found) setLoadError('这本书不在书库里，可能已被删除');
        else setMeta(found);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [bookId]);

  /* ------------------------------ 建立会话 ------------------------------ */

  /**
   * 用**回调 ref** 而不是 useEffect 来驱动会话创建。
   *
   * 原因：`meta`（异步拉取）与容器挂载（React 渲染）完成的先后顺序不确定。
   * 早先版本在 effect 里 `if (!containerRef.current) return`，
   * 一旦 meta 先到而容器引用还为空，会话就永远不会建立，界面卡在加载中。
   *
   * 注意：这个函数必须**身份稳定**（依赖数组里不放 meta）。它一旦变化，
   * React 就会以 null 解绑旧 ref 并走进销毁分支——表现为"界面刚渲染好又被卸载"。
   * 所以 meta 通过 ref 读取，换书的重置另用 effect 处理。
   */
  const metaRef = useRef<BookMeta | null>(null);
  metaRef.current = meta;
  /**
   * 引擎通过 ref 读取，而不是放进 setContainer 的依赖。
   *
   * 为什么：重建引擎的 effect 依赖 setContainer，若 setContainer 又依赖 ttsEngine，
   * 就会形成"重建 → setContainer 变化 → 再重建"的无限循环，
   * 表现为阅读器永远停在"正在加载阅读器…"（实测踩到过）。
   */
  const engineRef = useRef(ttsEngine);
  engineRef.current = ttsEngine;

  /**
   * 销毁指定会话，但只有它仍是"当前会话"时才真正销毁。
   *
   * 这个所有权判断很关键：回调 ref 变化时 React 会先以 null 解绑旧 ref、
   * 再以 node 绑定新 ref，两者的实际顺序可能让**旧会话的清理晚于新会话的创建**。
   * 没有这个判断时，清理会把刚建好的会话一起销毁。
   */
  const destroySession = useCallback((session: ReaderSession) => {
    if (sessionRef.current !== session) return;
    contentsCleanup.current?.();
    contentsCleanup.current = null;
    sessionRef.current = null;
    exposeSession(null);
    session.destroy();
  }, []);

  const setContainer = useCallback(
    (node: HTMLDivElement | null) => {
      containerRef.current = node;
      if (!node) return;
      const currentMeta = metaRef.current;
      // 已有会话（含重复调用）时不再重建
      if (!currentMeta || sessionRef.current) return;

      const p = prefsRef.current;
      const settings: ReaderSettings = {
        theme: p.theme,
        fontSize: p.fontSize,
        lineHeight: p.lineHeight,
        maxWidthPercent: p.maxWidthPercent,
        fontFamily: p.fontFamily,
        flow: p.flow,
      };

      const session = new ReaderSession(
        currentMeta,
        {
          onState: (s) => setState(s),
          onNotice: (msg) => setToast({ kind: 'error', text: msg }),
          onContents: (doc) => {
            // 翻章会换掉整个 document，所以每次都要重新挂监听
            contentsCleanup.current?.();
            contentsCleanup.current = attachClickToRead(doc, (point) => {
              // 只定位、不播放：先把命中位置与所在句子算出来交给菜单
              const located = session.locatePoint(point.node, point.offset);
              if (!located) return;

              // 用句子 Range 求「句首字符」在父视口的坐标作为菜单锚点：
              // 浮窗落在句子头的下方，而不是鼠标点击处。
              const range = session.sentenceRange(located.sentenceIndex);
              const dx = point.frameDx ?? 0;
              const dy = point.frameDy ?? 0;
              let x = point.x;
              let y = point.y;
              if (range) {
                const firstChar = range.cloneRange();
                try {
                  firstChar.setEnd(range.startContainer, range.startOffset + 1);
                } catch {
                  /* 句子以段落边界结束等边界情况，退回点击坐标 */
                }
                const rect = firstChar.getBoundingClientRect();
                if (rect && rect.height > 0) {
                  // rect 是 iframe 视口坐标，+frame 偏移换算成父视口坐标
                  x = rect.left + dx;
                  y = rect.bottom + dy + 4;
                }
              }
              // 在正文里标记出选中的句子（高亮框），不再只靠浮窗提示
              session.markSentence(located.sentenceIndex);
              setClickMenu({ ...point, x, y, sentenceIndex: located.sentenceIndex, text: located.text });
            });
          },
        },
        settings,
        // 引擎在会话创建时定型；切引擎由下面的 effect 触发重建
        engineRef.current,
      );
      sessionRef.current = session;
      builtEngineRef.current = engineRef.current;
      exposeSession(session);

      // 初始朗读参数（此时尚未播放，setRate 等会走静默分支）
      session.setRate(p.rate);
      session.setVolume(p.volume);
      session.setVoice(p.voiceId);
      void session.open(node);

      // 音色是异步加载的，首次可能为空
      const tryVoices = (attempt: number) => {
        void session.listVoices().then((list) => {
          if (sessionRef.current !== session) return; // 已切书
          setVoices(list);
          if (list.length > 0) {
            setVoiceLoading(false);
            return;
          }
          if (attempt < 3) window.setTimeout(() => tryVoices(attempt + 1), 1000);
          else setVoiceLoading(false);
        }).catch(() => {
          // 取音色失败不该让界面卡在"加载中"
          if (sessionRef.current === session) setVoiceLoading(false);
        });
      };
      tryVoices(0);
    },
    // 刻意不依赖 ttsEngine / meta：前者通过 engineRef 读取、后者通过 metaRef，
    // 保证这个回调 ref 身份稳定（否则会与重建 effect 形成死循环）
    [setToast, destroySession],
  );

  /** meta 到位后建立会话（若容器已就绪）；容器未就绪时由回调 ref 负责。 */
  useEffect(() => {
    const node = containerRef.current;
    if (node && meta && !sessionRef.current) setContainer(node);
  }, [meta, setContainer]);

  /** 换书：销毁旧会话。容器内容由 epub.js 自己管理，新会话会重建渲染。 */
  useEffect(() => {
    return () => {
      const existing = sessionRef.current;
      if (existing) destroySession(existing);
    };
  }, [bookId, destroySession]);

  /**
   * 切换朗读引擎时重建会话（只在引擎**真的变化**时执行一次）。
   *
   * 两个必须注意的点：
   *  1. 引擎在 ReaderSession 构造时定型，没法热替换，只能重建；
   *  2. 不能用"依赖 setContainer / destroySession"来触发，因为它们会因其它渲染
   *     而换新身份；而重建本身会通过 onState 触发重渲染，于是形成
   *     "重建 → 重渲染 → 再重建"的死循环（实测 createSession 在一次加载里跑了 4 次，
   *     页面持续闪烁，播放按钮时有时无）。
   *     所以这里用 ref 记住上一轮的引擎值，只在真正变化时动一次。
   */
  /**
   * 引擎变化时重建会话。
   *
   * 用 ref 记住"上一次实际用于建会话的引擎"，只在真的变化时动一次。
   * 不能用依赖数组去间接触发：重建会通过 onState 引起重渲染，
   * 若依赖里含会变的函数身份，就会形成"重建 → 重渲染 → 再重建"的死循环
   * （实测表现为界面持续卸载重挂、播放按钮时有时无）。
   */
  const builtEngineRef = useRef<TtsEngineKind | null>(null);
  useEffect(() => {
    if (builtEngineRef.current === ttsEngine) return;
    const node = containerRef.current;
    if (node && sessionRef.current && builtEngineRef.current !== ttsEngine) {
      const existing = sessionRef.current;
      destroySession(existing);
      setState(null);
      setVoices([]);
      setVoiceLoading(true);
      setContainer(node);
    }
  }, [ttsEngine, setContainer]);

  /* ------------------------ 偏好变化增量应用到会话 ------------------------ */

  useEffect(() => {
    const session = sessionRef.current;
    if (!session) return;
    session.applySettings({
      theme: prefs.theme,
      fontSize: prefs.fontSize,
      lineHeight: prefs.lineHeight,
      maxWidthPercent: prefs.maxWidthPercent,
      fontFamily: prefs.fontFamily,
      flow: prefs.flow,
    });
    session.setRate(prefs.rate);
    session.setVolume(prefs.volume);
    session.setVoice(prefs.voiceId);
    session.setPiperNoise(prefs.piperNoiseScale, prefs.piperNoiseWScale);
  }, [
    prefs.theme,
    prefs.fontSize,
    prefs.lineHeight,
    prefs.maxWidthPercent,
    prefs.fontFamily,
    prefs.flow,
    prefs.rate,
    prefs.volume,
    prefs.voiceId,
    prefs.piperNoiseScale,
    prefs.piperNoiseWScale,
    prefs.ttsEngine,
  ]);

  /* ------------------------------- 快捷键 ------------------------------- */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 在输入控件里不拦截按键
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;

      const session = sessionRef.current;
      if (!session) return;

      switch (e.key) {
        case ' ':
          e.preventDefault();
          void session.toggle();
          break;
        case 'ArrowRight':
          e.preventDefault();
          void session.nextSentence();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          void session.prevSentence();
          break;
        case 'Escape':
          setSettingsOpen(false);
          setTocOpen(false);
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /* -------------------------------- 渲染 -------------------------------- */

  const toc = useMemo(() => (meta?.toc ?? []) as TocEntry[], [meta]);

  if (loadError) {
    return (
      <div className="flex min-h-full flex-col items-center justify-center gap-4 p-8">
        <p className="text-bad">{loadError}</p>
        <button
          type="button"
          onClick={onExit}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-surface hover:bg-accent-strong"
        >
          返回书架
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-edge bg-surface-2 px-4 py-2">
        <button
          type="button"
          onClick={onExit}
          className="rounded-lg px-2.5 py-1.5 text-sm text-ink-muted ring-1 ring-edge hover:bg-surface-3 hover:text-ink"
        >
          ← 书架
        </button>

        <button
          type="button"
          onClick={() => setTocOpen((v) => !v)}
          disabled={toc.length === 0}
          className="rounded-lg px-2.5 py-1.5 text-sm text-ink-muted ring-1 ring-edge hover:bg-surface-3 hover:text-ink disabled:opacity-40"
        >
          目录
        </button>

        <div className="min-w-0 flex-1 text-center">
          <p className="truncate text-sm font-medium">{meta?.title ?? '加载中…'}</p>
          {state?.chapterLabel && (
            <p className="truncate text-xs text-ink-faint">{state.chapterLabel}</p>
          )}
        </div>

        <span className="text-xs text-ink-faint">
          {state ? `${Math.round(state.percent * 100)}%` : ''}
        </span>
        <button
          type="button"
          onClick={() => setSettingsOpen((v) => !v)}
          className="rounded-lg px-2.5 py-1.5 text-sm text-ink-muted ring-1 ring-edge hover:bg-surface-3 hover:text-ink"
        >
          设置
        </button>
      </header>

      <div className="relative flex min-h-0 min-w-0 flex-1">
        {/*
          epub.js 会给容器设 width:100%，同时按自己算出的宽度给内部 stage 定宽，
          形成"内容把容器撑宽"的反馈，导致页面比窗口宽 10px 并常驻横向滚动条。
          给容器加 min-w-0 + overflow-hidden 建立 BFC 切断这个反馈。
        */}
        <div ref={setContainer} className="epub-host min-h-0 min-w-0 flex-1 overflow-hidden" />

        {(state?.status === 'loading' || !state) && (
          <div className="absolute inset-0 flex items-center justify-center bg-surface">
            <p className="text-sm text-ink-muted">正在打开书籍…</p>
          </div>
        )}
        {state?.status === 'error' && (
          <div className="absolute inset-0 flex items-center justify-center bg-surface p-6">
            <div className="max-w-md text-center">
              <p className="text-bad">{state.error}</p>
              <button
                type="button"
                onClick={onExit}
                className="mt-4 rounded-lg bg-accent px-4 py-2 text-sm text-surface"
              >
                返回书架
              </button>
            </div>
          </div>
        )}

        {tocOpen && (
          <TocDrawer
            toc={toc}
            activeHref={state?.chapterHref}
            activeLabel={state?.chapterLabel}
            onPick={(entry) => {
              setTocOpen(false);
              void sessionRef.current?.goToHref(entry.href);
            }}
            onClose={() => setTocOpen(false)}
          />
        )}

        {settingsOpen && (
          <SettingsPanel onClose={() => setSettingsOpen(false)} />
        )}

        {clickMenu && (
          <TextActionMenu
            selection={clickMenu}
            onReadFromHere={() => {
              const idx = clickMenu.sentenceIndex;
              sessionRef.current?.markSentence(null);
              setClickMenu(null);
              if (idx !== undefined) void sessionRef.current?.readFromSentence(idx);
            }}
            onReadChapter={() => {
              sessionRef.current?.markSentence(null);
              setClickMenu(null);
              void sessionRef.current?.readFromSentence(0);
            }}
            onClose={() => {
              sessionRef.current?.markSentence(null);
              setClickMenu(null);
            }}
          />
        )}
      </div>

      <PlayerBar
        player={state?.player ?? { status: 'idle', index: 0, boundary: null }}
        sentenceIndex={state?.sentenceIndex ?? 0}
        sentenceCount={state?.sentenceCount ?? 0}
        chapterLabel={state?.chapterLabel ?? ''}
        rate={prefs.rate}
        volume={prefs.volume}
        voiceId={prefs.voiceId}
        voices={voices}
        voiceLoading={voiceLoading}
        bookLang={meta?.language}
        onToggle={() => void sessionRef.current?.toggle()}
        onPrev={() => void sessionRef.current?.prevChapter()}
        onNext={() => void sessionRef.current?.nextChapter()}
        onRate={(rate) => setPrefs({ rate })}
        onVolume={(volume) => setPrefs({ volume })}
        onVoice={(id) => setPrefs({ voiceId: id })}
        onOpenSettings={() => setSettingsOpen((v) => !v)}
      />
    </div>
  );
}

/* ------------------------------- 目录抽屉 ------------------------------- */

function TocDrawer({
  toc,
  activeHref,
  activeLabel,
  onPick,
  onClose,
}: {
  toc: TocEntry[];
  activeHref?: string;
  activeLabel?: string;
  onPick: (entry: TocEntry) => void;
  onClose: () => void;
}) {
  const activeKey = activeHref ? normalizeHref(activeHref) : '';

  /**
   * 打开目录时把当前章节滚到可见位置。
   *
   * 目录可能很长（本书 1500+ 条），从第一条开始显示的话，
   * 用户每次都得自己往下翻很久才能找到"我在哪"。
   * 用回调 ref 在目标节点挂载时触发一次即可——抽屉每次打开都是重新挂载的。
   */
  const scrollActiveIntoView = useCallback((node: HTMLButtonElement | null) => {
    if (!node) return;
    // 等一帧再滚，确保列表已完成首次布局
    requestAnimationFrame(() => {
      node.scrollIntoView({ block: 'center', behavior: 'auto' });
    });
  }, []);

  return (
    <>
      <div className="absolute inset-0 z-20 bg-black/40" onClick={onClose} />
      <aside className="absolute inset-y-0 left-0 z-30 flex w-80 max-w-[85%] flex-col border-r border-edge bg-surface-2">
        <div className="flex items-center justify-between border-b border-edge px-4 py-3">
          <h2 className="text-sm font-medium">目录</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 py-1 text-xs text-ink-muted hover:bg-surface-3"
          >
            关闭
          </button>
        </div>
        <nav className="min-h-0 flex-1 overflow-y-auto py-2">
          {toc.map((entry, i) => (
            <TocNode
              key={`${entry.href}-${i}`}
              entry={entry}
              depth={0}
              activeKey={activeKey}
              activeLabel={activeLabel}
              onPick={onPick}
              activeRef={scrollActiveIntoView}
            />
          ))}
        </nav>
      </aside>
    </>
  );
}

function TocNode({
  entry,
  depth,
  activeKey,
  activeLabel,
  onPick,
  activeRef,
}: {
  entry: TocEntry;
  depth: number;
  activeKey: string;
  activeLabel?: string;
  onPick: (entry: TocEntry) => void;
  /** 传给"当前章节"那一项，用于把它滚进视野。 */
  activeRef?: (node: HTMLButtonElement | null) => void;
}) {
  // 优先按 href 匹配；href 不可用时退回标签比较
  const key = entry.href ? normalizeHref(entry.href) : '';
  const active = activeKey ? key === activeKey : activeLabel === entry.label;
  return (
    <>
      <button
        type="button"
        ref={active ? activeRef : undefined}
        onClick={() => onPick(entry)}
        style={{ paddingLeft: `${1 + depth * 0.9}rem` }}
        className={`block w-full truncate py-1.5 pr-3 text-left text-sm transition ${
          active ? 'bg-accent/15 text-accent' : 'text-ink-muted hover:bg-surface-3 hover:text-ink'
        }`}
        title={entry.label}
      >
        {entry.label}
      </button>
      {entry.children?.map((child, i) => (
        <TocNode
          key={`${child.href}-${i}`}
          entry={child}
          depth={depth + 1}
          activeKey={activeKey}
          activeLabel={activeLabel}
          onPick={onPick}
          activeRef={activeRef}
        />
      ))}
    </>
  );
}

/* ------------------------------- 设置面板 ------------------------------- */

function SettingsPanel({ onClose }: { onClose: () => void }) {
  const prefs = useReaderPrefs();
  const setPrefs = useReaderPrefs((s) => s.set);
  const reset = useReaderPrefs((s) => s.reset);

  const themes: Array<{ id: ReaderSettings['theme']; label: string; swatch: string }> = [
    { id: 'dark', label: '夜间', swatch: '#16181d' },
    { id: 'light', label: '日间', swatch: '#ffffff' },
    { id: 'sepia', label: '护眼', swatch: '#f4ecd8' },
  ];

  const fonts: Array<{ id: string; label: string }> = [
    { id: 'serif', label: '宋体 / 衬线' },
    { id: 'sans-serif', label: '黑体 / 无衬线' },
    { id: '"KaiTi", "STKaiti", serif', label: '楷体' },
  ];

  return (
    <aside className="absolute inset-y-0 right-0 z-30 w-80 max-w-[85%] overflow-y-auto border-l border-edge bg-surface-2 p-4">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-medium">阅读设置</h2>
        <button
          type="button"
          onClick={onClose}
          className="rounded px-2 py-1 text-xs text-ink-muted hover:bg-surface-3"
        >
          关闭
        </button>
      </div>

      <EngineSection />
      {prefs.ttsEngine === 'piper' && <PiperOptionsSection />}

      <Section title="主题">
        <div className="flex gap-2">
          {themes.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setPrefs({ theme: t.id })}
              className={`flex flex-1 flex-col items-center gap-1.5 rounded-lg border p-2 text-xs transition ${
                prefs.theme === t.id
                  ? 'border-accent text-accent'
                  : 'border-edge text-ink-muted hover:bg-surface-3'
              }`}
            >
              <span
                className="h-6 w-full rounded border border-edge"
                style={{ background: t.swatch }}
              />
              {t.label}
            </button>
          ))}
        </div>
      </Section>

      <Section title={`字号 ${prefs.fontSize}px`}>
        <input
          type="range"
          min={12}
          max={32}
          step={1}
          value={prefs.fontSize}
          onChange={(e) => setPrefs({ fontSize: Number(e.target.value) })}
          className="w-full accent-accent"
        />
      </Section>

      <Section title={`行距 ${prefs.lineHeight.toFixed(1)}`}>
        <input
          type="range"
          min={1.2}
          max={2.6}
          step={0.1}
          value={prefs.lineHeight}
          onChange={(e) => setPrefs({ lineHeight: Number(e.target.value) })}
          className="w-full accent-accent"
        />
      </Section>

      <Section title="行宽">
        <input
          type="range"
          min={WIDTH_PERCENT_RANGE.min}
          max={WIDTH_PERCENT_RANGE.max}
          step={1}
          value={prefs.maxWidthPercent}
          onChange={(e) => setPrefs({ maxWidthPercent: Number(e.target.value) })}
          className="w-full accent-accent"
          aria-label="行宽"
        />
        <div className="mt-1 flex justify-between text-[11px] text-ink-faint">
          <span>窄</span>
          <span>宽</span>
        </div>
      </Section>

      <Section title="字体">
        <select
          value={prefs.fontFamily}
          onChange={(e) => setPrefs({ fontFamily: e.target.value })}
          aria-label="正文字体"
          className="w-full rounded border border-edge bg-surface-3 px-2 py-1.5 text-sm"
        >
          {fonts.map((f) => (
            <option key={f.id} value={f.id}>
              {f.label}
            </option>
          ))}
        </select>
      </Section>

      <Section title="翻页方式">
        <div className="flex gap-2 text-xs">
          {(
            [
              { id: 'scrolled-doc', label: '滚动' },
              { id: 'paginated', label: '分页' },
            ] as const
          ).map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setPrefs({ flow: f.id })}
              className={`flex-1 rounded-lg border px-2 py-2 transition ${
                prefs.flow === f.id
                  ? 'border-accent text-accent'
                  : 'border-edge text-ink-muted hover:bg-surface-3'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </Section>

      <button
        type="button"
        onClick={reset}
        className="mt-2 w-full rounded-lg border border-edge px-3 py-2 text-xs text-ink-muted hover:bg-surface-3"
      >
        恢复默认设置
      </button>
    </aside>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-5">
      <h3 className="mb-2 text-xs text-ink-faint">{title}</h3>
      {children}
    </div>
  );
}

/* ------------------------------ 朗读引擎 ------------------------------ */

/**
 * 朗读引擎选择。
 */
function EngineSection() {
  const engine = useReaderPrefs((s) => s.ttsEngine);
  const setPrefs = useReaderPrefs((s) => s.set);

  return (
    <Section title="朗读引擎">
      <select
        value={engine}
        onChange={(event) => setPrefs({ ttsEngine: event.target.value as TtsEngineKind, voiceId: undefined })}
        className="w-full rounded border border-edge bg-surface-3 px-2 py-1.5 text-sm"
        aria-label="朗读引擎"
      >
        <option value="webspeech">浏览器 / Edge 内置语音</option>
        <option value="piper">Piper（本机 CPU）</option>
      </select>
      {engine === 'piper' ? (
        <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">
          使用本机 Piper CPU sidecar。音色会在下方播放条加载；Piper 按句合成，因此高亮为句子级。
          未启动服务时会提示：<code>pnpm piper:server</code>。
        </p>
      ) : (
        <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">
          音色来自系统与浏览器；Edge 通常能提供微软在线自然音色。音色在下方播放条选择。
        </p>
      )}
    </Section>
  );
}

/* ---------------------------- Piper 合成参数 ---------------------------- */

/**
 * Piper 专属合成参数：音色稳定度（noise_scale）与韵律起伏（noise_w_scale）。
 *
 * 这两个参数在设置面板实时可调，改动即时保存并应用到后续合成；
 * 缓存 key 含这两项，参数变化时旧音频自动失效重合成。
 */
function PiperOptionsSection() {
  const prefs = useReaderPrefs();
  const setPrefs = useReaderPrefs((s) => s.set);

  return (
    <Section title="Piper 音色微调">
      <label className="block text-[11px] text-ink-faint">
        音色稳定度 {prefs.piperNoiseScale.toFixed(2)}
        <input
          type="range"
          min={0.1}
          max={1.5}
          step={0.05}
          value={prefs.piperNoiseScale}
          onChange={(e) => setPrefs({ piperNoiseScale: Number(e.target.value) })}
          className="mt-1 w-full accent-accent"
        />
        <span className="mt-0.5 flex justify-between text-[10px] text-ink-faint">
          <span>沉稳</span>
          <span>鲜活</span>
        </span>
      </label>
      <label className="mt-3 block text-[11px] text-ink-faint">
        韵律起伏 {prefs.piperNoiseWScale.toFixed(2)}
        <input
          type="range"
          min={0.1}
          max={1.5}
          step={0.05}
          value={prefs.piperNoiseWScale}
          onChange={(e) => setPrefs({ piperNoiseWScale: Number(e.target.value) })}
          className="mt-1 w-full accent-accent"
        />
        <span className="mt-0.5 flex justify-between text-[10px] text-ink-faint">
          <span>平稳</span>
          <span>起伏大</span>
        </span>
      </label>
      <p className="mt-2 text-[10px] leading-relaxed text-ink-faint">
        音色稳定度影响发音的随机波动（越小越稳），韵律起伏影响语调的抑扬顿挫。不动时保持默认即可。
      </p>
    </Section>
  );
}

/* ---------------------------- 正文点击菜单 ---------------------------- */

/**
 * 在章节 iframe 上挂"点击正文 → 弹菜单"。
 *
 * 用 `caretRangeFromPoint` 取点击位置对应的文本节点与偏移，交给会话换算成句子
 * （朗读从**点击处最近的句子**开始）。菜单锚点取点击字符的底部：
 *  - 浮窗从文字下方落下（不盖住字）；
 *  - 点击哪一句，就从哪一句的下方弹菜单，所见即所得。
 * 点击**不直接开始朗读**，而是先弹菜单（默认动作在菜单里），
 * 避免误触就突然出声。点在不含文本的空白/装饰元素上时换算失败，直接忽略。
 *
 * 返回清理函数；翻章后必须重新调用（document 已换）。
 */
function attachClickToRead(
  doc: Document,
  onLocate: (point: TextPointSelection) => void,
): () => void {
  const onClick = (event: MouseEvent) => {
    const target = event.target as HTMLElement | null;
    // 链接保持原行为（跳转/脚注），不弹菜单
    if (target?.closest('a')) return;

    const anyDoc = doc as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    };

    let node: Node | null = null;
    let offset = 0;

    const range = anyDoc.caretRangeFromPoint?.(event.clientX, event.clientY);
    if (range) {
      node = range.startContainer;
      offset = range.startOffset;
    } else {
      const pos = anyDoc.caretPositionFromPoint?.(event.clientX, event.clientY);
      if (pos) {
        node = pos.offsetNode;
        offset = pos.offset;
      }
    }
    if (!node) return;

    // iframe 内的坐标是 iframe 视口坐标；菜单在父页面用 fixed 定位，
    // 需要换算成父视口坐标（iframe 顶部工具栏/左右留白会带来偏移）。
    const win = doc.defaultView;
    const frame = win ? (win.frameElement as HTMLElement | null) : null;
    const dx = frame ? frame.getBoundingClientRect().left : 0;
    const dy = frame ? frame.getBoundingClientRect().top : 0;

    // 首选锚点：点击字符的矩形底边（菜单出现在字下方，不盖字）。
    let x = event.clientX + dx;
    let y = event.clientY + dy;
    try {
      const r = range?.getBoundingClientRect?.();
      if (r && r.height > 0) {
        x = Math.max(0, r.left) + dx;
        y = Math.max(0, r.bottom) + dy + 4;
      }
    } catch {
      /* 某些环境 getBoundingClientRect 可能抛，回到点击坐标 */
    }

    event.preventDefault();
    onLocate({ node, offset, x, y, frameDx: dx, frameDy: dy });
  };

  doc.addEventListener('click', onClick);
  return () => doc.removeEventListener('click', onClick);
}

/** 一次点击所定位到的位置与句子。 */
interface TextPointSelection {
  node: Node;
  offset: number;
  /** 视口坐标，用于放置菜单。 */
  x: number;
  y: number;
  /** iframe 相对父视口的偏移（iframe 内坐标换算到父视口用）。 */
  frameDx?: number;
  frameDy?: number;
  sentenceIndex?: number;
  text?: string;
}

/**
 * 正文点击后的操作菜单。
 *
 * 锚点是**点击处字符下方**（不盖住字）；菜单显示选中的句子预览
 * （确认点对了哪一句），配两个紧凑动作按钮，保持小巧。
 */
function TextActionMenu({
  selection,
  onReadFromHere,
  onReadChapter,
  onClose,
}: {
  selection: TextPointSelection;
  onReadFromHere: () => void;
  onReadChapter: () => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ left: selection.x, top: selection.y + 2 });

  // 靠边时把菜单挪回视口内，避免被裁掉
  useEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let left = selection.x;
    let top = selection.y + 2;
    if (left + rect.width > window.innerWidth - 8) left = window.innerWidth - rect.width - 8;
    if (top + rect.height > window.innerHeight - 8) top = selection.y - rect.height - 6;
    setPos({ left: Math.max(8, left), top: Math.max(8, top) });
  }, [selection.x, selection.y]);

  // 点击别处 / Esc 关闭
  useEffect(() => {
    const onDocDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    // 用 capture：正文点击在 iframe 里，冒泡到不了外层 document
    document.addEventListener('mousedown', onDocDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      style={{ left: pos.left, top: pos.top }}
      className="fixed z-40 flex flex-col overflow-hidden rounded-md border border-edge bg-surface-2 py-0.5 shadow-lg"
      role="menu"
    >
      <button
        type="button"
        onClick={onReadFromHere}
        className="flex items-center gap-1.5 whitespace-nowrap px-2.5 py-1 text-left text-xs text-ink hover:bg-surface-3"
      >
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0 text-accent" fill="currentColor" aria-hidden>
          <path d="M7 5l12 7-12 7z" />
        </svg>
        从这里读
      </button>
      <button
        type="button"
        onClick={onReadChapter}
        className="flex items-center gap-1.5 whitespace-nowrap px-2.5 py-1 text-left text-xs text-ink-muted hover:bg-surface-3 hover:text-ink"
      >
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0" fill="currentColor" aria-hidden>
          <path d="M4 5h16v2H4zM4 9h16v2H4zM4 13h16v2H4zM4 17h10v2H4z" />
        </svg>
        从章首读
      </button>
    </div>
  );
}

import type { PlayerState } from '@/tts/player';
import type { TtsVoice } from '@/tts/types';

/** 常用语速档位：比连续滑块更好按，也更容易复现"上次用的速度"。 */
const RATE_STEPS = [0.6, 0.8, 1, 1.2, 1.5, 1.8, 2.2];

/** 音色下拉最多列出多少个普通项（本机实测有 324 个音色，平铺出来没法用）。 */
const VOICE_LIST_LIMIT = 80;
/** 与书本语言匹配的音色最多列多少个。 */
const VOICE_MATCHED_LIMIT = 40;

interface VoiceGroup {
  label: string;
  voices: TtsVoice[];
}

/**
 * 把音色整理成分组列表。
 *
 * 本机实测有 324 个音色（Edge 提供大量在线自然音色），平铺成一个下拉框
 * 根本无法使用。这里的策略：
 *  1. 与书本语言匹配的排最前，并单独成组；
 *  2. 其余按「中文 / 本地 / 在线」分组；
 *  3. 每组都有数量上限，避免下拉框被撑爆；
 *  4. 当前选中的音色始终出现（哪怕超出上限），否则用户会以为设置丢了。
 */
function buildVoiceCatalog(
  voices: TtsVoice[],
  selected: string | undefined,
  bookLang: string | undefined,
): { groups: VoiceGroup[]; hiddenCount: number } {
  const bookBase = (bookLang ?? '').toLowerCase().split('-')[0] ?? '';
  const selectedVoice = selected ? voices.find((v) => v.id === selected) : undefined;

  const matched: TtsVoice[] = [];
  const local: TtsVoice[] = [];
  const online: TtsVoice[] = [];
  const otherZh: TtsVoice[] = [];

  for (const v of voices) {
    if (v.id === selected) continue; // 选中的单独处理，避免重复
    const langBase = (v.lang ?? '').toLowerCase().split('-')[0] ?? '';
    if (bookBase && langBase === bookBase) {
      matched.push(v);
      continue;
    }
    if (langBase === 'zh') {
      otherZh.push(v);
      continue;
    }
    if (v.local) local.push(v);
    else online.push(v);
  }

  const sortByName = (a: TtsVoice, b: TtsVoice) => a.name.localeCompare(b.name, 'zh-CN');
  for (const list of [matched, otherZh, local, online]) list.sort(sortByName);

  const groups: VoiceGroup[] = [];
  if (selectedVoice) groups.push({ label: '当前使用', voices: [selectedVoice] });
  if (matched.length) {
    groups.push({ label: '匹配本书语言', voices: matched.slice(0, VOICE_MATCHED_LIMIT) });
  }
  if (otherZh.length) groups.push({ label: '其他中文', voices: otherZh.slice(0, VOICE_MATCHED_LIMIT) });
  if (local.length) groups.push({ label: '本机语音', voices: local.slice(0, VOICE_LIST_LIMIT) });
  if (online.length) groups.push({ label: '在线自然语音', voices: online.slice(0, VOICE_LIST_LIMIT) });

  const shown = groups.reduce((n, g) => n + g.voices.length, 0);
  return { groups, hiddenCount: Math.max(0, voices.length - shown) };
}

export function PlayerBar({
  player,
  sentenceIndex,
  sentenceCount,
  chapterLabel,
  rate,
  volume,
  voiceId,
  voices,
  voiceLoading,
  bookLang,
  onToggle,
  onPrev,
  onNext,
  onRate,
  onVolume,
  onVoice,
  onOpenSettings,
}: {
  player: PlayerState;
  sentenceIndex: number;
  sentenceCount: number;
  chapterLabel: string;
  rate: number;
  volume: number;
  voiceId?: string;
  voices: TtsVoice[];
  voiceLoading: boolean;
  /** 书本语言，用于把匹配的音色排在前面。 */
  bookLang?: string;
  onToggle: () => void;
  onPrev: () => void;
  onNext: () => void;
  onRate: (rate: number) => void;
  onVolume: (volume: number) => void;
  onVoice: (voiceId: string | undefined) => void;
  onOpenSettings: () => void;
}) {
  const playing = player.status === 'playing';
  const statusText = describeStatus(player, sentenceIndex, sentenceCount);
  const catalog = buildVoiceCatalog(voices, voiceId, bookLang);

  return (
    <div className="border-t border-edge bg-surface-2/95 backdrop-blur">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5">
        <div className="flex items-center gap-1.5">
          <IconButton label="上一章" onClick={onPrev}>
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor" aria-hidden>
              <path d="M6 6h2v12H6zM20 6v12l-9-6z" />
            </svg>
          </IconButton>

          <button
            type="button"
            onClick={onToggle}
            aria-label={playing ? '暂停朗读' : '开始朗读'}
            className="flex h-10 w-10 items-center justify-center rounded-full bg-accent text-surface transition hover:bg-accent-strong"
          >
            {playing ? (
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor" aria-hidden>
                <path d="M7 5h4v14H7zM13 5h4v14h-4z" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor" aria-hidden>
                <path d="M7 5l12 7-12 7z" />
              </svg>
            )}
          </button>

          <IconButton label="下一章" onClick={onNext}>
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor" aria-hidden>
              <path d="M16 6h2v12h-2zM4 6v12l9-6z" />
            </svg>
          </IconButton>
        </div>

        <div className="min-w-0 flex-1">
          <p className="truncate text-xs text-ink-muted" title={chapterLabel}>
            {chapterLabel}
          </p>
          <p className={`truncate text-sm ${player.status === 'error' ? 'text-bad' : 'text-ink'}`}>
            {statusText}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3 text-xs text-ink-muted">
          <label className="flex items-center gap-1.5">
            <span className="whitespace-nowrap">语速</span>
            <select
              value={nearestRate(rate)}
              onChange={(e) => onRate(Number(e.target.value))}
              className="rounded border border-edge bg-surface-3 px-1.5 py-1 text-xs text-ink focus:border-accent focus:outline-none"
            >
              {RATE_STEPS.map((r) => (
                <option key={r} value={r}>
                  {r}×
                </option>
              ))}
            </select>
          </label>

          <label className="flex items-center gap-1.5" title="音量">
            <span className="whitespace-nowrap">音量</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={volume}
              onChange={(e) => onVolume(Number(e.target.value))}
              className="h-1 w-16 accent-accent"
            />
          </label>

          <label className="flex items-center gap-1.5" title="朗读音色">
            <span className="whitespace-nowrap">音色</span>
            <select
              value={voiceId ?? ''}
              disabled={voiceLoading}
              onChange={(e) => onVoice(e.target.value || undefined)}
              className="max-w-[15rem] rounded border border-edge bg-surface-3 px-1.5 py-1 text-xs text-ink focus:border-accent focus:outline-none disabled:opacity-50"
            >
              <option value="">{voiceLoading ? '加载中…' : '系统默认'}</option>
              {catalog.groups.map((g) => (
                <optgroup key={g.label} label={`${g.label}（${g.voices.length}）`}>
                  {g.voices.map((v) => (
                    <option key={v.id} value={v.id}>
                      {shortVoiceName(v.name)}
                      {v.local ? '' : ' · 在线'}
                    </option>
                  ))}
                </optgroup>
              ))}
              {catalog.hiddenCount > 0 && (
                <optgroup label={`另有 ${catalog.hiddenCount} 个音色未列出`}>
                  <option value="" disabled>
                    其他语言/地区的音色已省略
                  </option>
                </optgroup>
              )}
            </select>
          </label>

          <button
            type="button"
            onClick={onOpenSettings}
            className="rounded border border-edge px-2 py-1 hover:bg-surface-3"
          >
            阅读设置
          </button>
        </div>
      </div>
    </div>
  );
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex h-9 w-9 items-center justify-center rounded-full text-ink-muted transition hover:bg-surface-3 hover:text-ink"
    >
      {children}
    </button>
  );
}

function describeStatus(player: PlayerState, index: number, count: number): string {
  switch (player.status) {
    case 'playing':
      return `正在朗读第 ${index + 1} / ${count} 句`;
    case 'paused':
      return `已暂停在第 ${index + 1} / ${count} 句`;
    case 'ended':
      return '本章已读完';
    case 'error':
      return player.error ?? '语音引擎出错';
    default:
      return count > 0 ? `共 ${count} 句，点击播放开始朗读` : '正在解析本章内容…';
  }
}

/** 语速取最接近的档位，避免下拉框因浮点误差选不中。 */
function nearestRate(rate: number): number {
  let best = RATE_STEPS[0]!;
  for (const r of RATE_STEPS) {
    if (Math.abs(r - rate) < Math.abs(best - rate)) best = r;
  }
  return best;
}

/**
 * 缩短音色名，便于在下拉框里快速扫读。
 *
 * 系统给的名字很长，例如
 *   "Microsoft 晓晓 Online (Natural) - Chinese (Mandarin, Simplified)"
 * 缩写后是「晓晓 · 在线」。语言在前面的分组标签里已经体现了，不必重复。
 */
function shortVoiceName(name: string): string {
  return (
    name
      .replace(/^Microsoft\s+/i, '')
      // 去掉 "(Natural)" "Mehrsprachig" "Multilingual" "multilingue" 等修饰
      .replace(/\s*\((?:Natural|Multilingual|Mehrsprachig|multilingue|multilingual)\)/gi, '')
      .replace(/\s+(?:Multilingual|Mehrsprachig|multilingue|multilingual)\b/gi, '')
      .replace(/\s*-\s*[^-]*$/, '')
      .trim() || name
  );
}

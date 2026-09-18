import { create } from 'zustand';
import { DEFAULT_SETTINGS, WIDTH_PERCENT_RANGE, type ReaderSettings, type TtsEngineKind } from '@/reader/settings';

const STORAGE_KEY = 'epub-tts:reader-settings';
export interface ReaderPrefs extends ReaderSettings {
  rate: number;
  volume: number;
  voiceId?: string;
  /** Piper 音色稳定度（noise_scale，越小越稳，默认 0.667）。 */
  piperNoiseScale: number;
  /** Piper 韵律起伏（noise_w_scale，越大起伏越大，默认 0.8）。 */
  piperNoiseWScale: number;
  ttsEngine: TtsEngineKind;
}
interface ReaderPrefsState extends ReaderPrefs { set: (patch: Partial<ReaderPrefs>) => void; reset: () => void; }
const DEFAULTS: ReaderPrefs = { ...DEFAULT_SETTINGS, rate: 1, volume: 1, piperNoiseScale: 0.667, piperNoiseWScale: 0.8, ttsEngine: 'webspeech' };
function load(): ReaderPrefs {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULTS };
    const p = parsed as Partial<ReaderPrefs> & { maxWidth?: unknown };
    return {
      theme: p.theme === 'light' || p.theme === 'sepia' ? p.theme : DEFAULTS.theme,
      fontSize: clampNum(p.fontSize, 12, 32, DEFAULTS.fontSize),
      lineHeight: clampNum(p.lineHeight, 1.2, 2.6, DEFAULTS.lineHeight),
      maxWidthPercent: migrateWidth(p.maxWidthPercent, p.maxWidth),
      fontFamily: typeof p.fontFamily === 'string' ? p.fontFamily : DEFAULTS.fontFamily,
      flow: p.flow === 'paginated' ? 'paginated' : 'scrolled-doc',
      rate: clampNum(p.rate, 0.5, 2, DEFAULTS.rate),
      volume: clampNum(p.volume, 0, 1, DEFAULTS.volume),
      voiceId: typeof p.voiceId === 'string' && p.voiceId ? p.voiceId : undefined,
      piperNoiseScale: clampNum(p.piperNoiseScale, 0.1, 2, DEFAULTS.piperNoiseScale),
      piperNoiseWScale: clampNum(p.piperNoiseWScale, 0.1, 2, DEFAULTS.piperNoiseWScale),
      ttsEngine: p.ttsEngine === 'piper' ? 'piper' : 'webspeech',
    };
  } catch { return { ...DEFAULTS }; }
}
function migrateWidth(percent: unknown, legacyPx: unknown): number { if (typeof percent === 'number' && Number.isFinite(percent)) return clampPercentLocal(percent); if (typeof legacyPx === 'number' && Number.isFinite(legacyPx) && legacyPx > 0) return clampPercentLocal((legacyPx / 1400) * 100); return DEFAULTS.maxWidthPercent; }
function clampPercentLocal(v: number): number { return Math.min(WIDTH_PERCENT_RANGE.max, Math.max(WIDTH_PERCENT_RANGE.min, Math.round(v))); }
function clampNum(v: unknown, min: number, max: number, fallback: number): number { return typeof v === 'number' && !Number.isNaN(v) ? Math.min(max, Math.max(min, v)) : fallback; }
function persist(prefs: ReaderPrefs): void { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs)); } catch { /* ignore */ } }
export const useReaderPrefs = create<ReaderPrefsState>((set, get) => ({ ...load(), set(patch) { set(patch); const { set: _set, reset: _reset, ...rest } = get(); persist(rest); }, reset() { set({ ...DEFAULTS }); persist({ ...DEFAULTS }); } }));
export function pickPrefs(state: ReaderPrefsState): ReaderPrefs { const { set: _set, reset: _reset, ...rest } = state; return rest; }
export const READER_DEFAULTS = DEFAULTS;

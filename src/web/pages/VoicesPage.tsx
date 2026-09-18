import { useCallback, useEffect, useState } from 'react';

/**
 * Piper 语音包下载页面。
 *
 * 从 Hugging Face 官方仓库（rhasspy/piper-voices，国内自动回退 hf-mirror.com
 * 镜像）探测可用的中文语音包，标注许可与分发策略：
 *  - 可分发（CC0 等）→ 一键下载，带进度条，完成后自动进入 models/piper
 *  - 不可分发（非商业/未知许可）→ 只引导到原站自行下载，不代为分发
 */

interface CatalogVoice {
  id: string;
  type: 'single' | 'zip';
  display: string;
  license: string;
  downloadPolicy: 'free' | 'confirm';
  home: string;
  sizeOnnx: number;
  installed: boolean;
  source?: 'official' | 'community';
  /** 官方变体真实 id（用于下载拼 URL）；或社区仓库名。 */
  actualVoice?: string;
  /** 下载 URL 列表（onnx + json 或 zip）。 */
  urls?: string[];
}

interface DownloadStatus {
  status: 'running' | 'done' | 'error';
  received: number;
  total: number;
  error?: string;
  installed?: boolean;
}

function formatBytes(n: number): string {
  if (!n) return '未知';
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 内置的官方语音包 id（它们 display 已含可读名，不再标"官方变体"）。 */
const KNOWN_IDS = new Set(['zh_CN-chaowen-medium', 'zh_CN-xiao_ya-medium', 'zh_CN-huayan-medium']);

export function VoicesPage({ onBack }: { onBack: () => void }) {
  const [voices, setVoices] = useState<CatalogVoice[] | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  /** voice.id -> 下载进度。 */
  const [progress, setProgress] = useState<Record<string, DownloadStatus>>({});
  /** 手动 URL 下载。 */
  const [manualUrl, setManualUrl] = useState('');
  const [manualBusy, setManualBusy] = useState(false);
  const [manualStatus, setManualStatus] = useState<DownloadStatus | null>(null);

  const loadCatalog = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await fetch('/api/piper/catalog');
      if (!res.ok) throw new Error(`目录请求失败（HTTP ${res.status}）`);
      const body = (await res.json()) as { voices: CatalogVoice[] };
      // 已安装的排在最后，未安装的可下载项排最前
      const sorted = [...body.voices].sort((a, b) => Number(a.installed) - Number(b.installed));
      setVoices(sorted);
      setError('');
    } catch (err) {
      setError(`获取语音包目录失败：${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadCatalog(); }, [loadCatalog]);

  /** 轮询任务直到完成/出错。 */
  const pollJob = useCallback((jobId: string, voiceId: string) => {
    const timer = window.setInterval(async () => {
      try {
        const res = await fetch(`/api/piper/download/${jobId}`);
        if (!res.ok) throw new Error(`查询进度失败（HTTP ${res.status}）`);
        const job = (await res.json()) as DownloadStatus;
        if (voiceId === '__manual__') {
          setManualStatus(job);
          if (job.status === 'done') setManualStatus({ ...job, status: 'done', installed: true });
        } else {
          setProgress((prev) => ({ ...prev, [voiceId]: job }));
        }
        if (job.status === 'done' || job.status === 'error') {
          window.clearInterval(timer);
          if (job.status === 'done') void loadCatalog(true);
        }
      } catch (err) {
        window.clearInterval(timer);
        const failed: DownloadStatus = { status: 'error', received: 0, total: 0, error: (err as Error).message };
        if (voiceId === '__manual__') setManualStatus(failed);
        else setProgress((prev) => ({ ...prev, [voiceId]: failed }));
      }
    }, 500);
    // 记录以便卸载时清理（简单方案：页面卸载自然随 window 一起消亡）
    return () => window.clearInterval(timer);
  }, [loadCatalog]);

  const startDownload = async (v: CatalogVoice) => {
    // 非自由分发的语音包：下载前弹确认框，提示许可与自担风险
    if (v.downloadPolicy !== 'free') {
      const ok = window.confirm(
        `「${v.display}」的许可是「${v.license}」，可能不允许分发或商用。\n\n你确认仍要下载并安装到本机吗？（请自行评估许可风险）`,
      );
      if (!ok) return;
    }
    const urls = v.urls ?? [];
    setProgress((prev) => ({ ...prev, [v.id]: { status: 'running', received: 0, total: v.sizeOnnx || 0 } }));
    try {
      const res = await fetch('/api/piper/download-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voice: v.id, urls }),
      });
      const body = (await res.json()) as { jobId?: string | null; alreadyInstalled?: boolean; error?: { message: string } };
      if (!res.ok) {
        setProgress((prev) => ({
          ...prev,
          [v.id]: { status: 'error', received: 0, total: v.sizeOnnx || 0, error: body.error?.message ?? '下载被拒绝' },
        }));
        return;
      }
      if (body.alreadyInstalled) {
        setProgress((prev) => ({ ...prev, [v.id]: { status: 'done', received: v.sizeOnnx || 0, total: v.sizeOnnx || 0, installed: true } }));
        void loadCatalog(true);
        return;
      }
      if (body.jobId) pollJob(body.jobId, v.id);
    } catch (err) {
      setProgress((prev) => ({
        ...prev,
        [v.id]: { status: 'error', received: 0, total: v.sizeOnnx || 0, error: (err as Error).message },
      }));
    }
  };

  /** 手动粘贴 URL 安装（.zip / .onnx / .onnx.json）。 */
  const installFromUrl = async () => {
    const url = manualUrl.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) {
      setManualStatus({ status: 'error', received: 0, total: 0, error: '请输入 http(s) 链接' });
      return;
    }
    setManualBusy(true);
    setManualStatus({ status: 'running', received: 0, total: 0 });
    try {
      const res = await fetch('/api/piper/install-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      const body = (await res.json()) as { jobId?: string | null; error?: { message: string } };
      if (!res.ok) {
        setManualStatus({ status: 'error', received: 0, total: 0, error: body.error?.message ?? '启动下载失败' });
        return;
      }
      if (body.jobId) pollJob(body.jobId, '__manual__');
    } catch (err) {
      setManualStatus({ status: 'error', received: 0, total: 0, error: (err as Error).message });
    } finally {
      setManualBusy(false);
    }
  };

  return (
    <main className="min-h-full bg-surface px-5 py-8 text-ink">
      <div className="mx-auto max-w-3xl">
        <header className="mb-6 flex items-center justify-between">
          <div>
            <p className="text-xs text-accent">PIPER VOICES</p>
            <h1 className="mt-1 text-2xl font-semibold">语音包下载</h1>
            <p className="mt-1 text-xs text-ink-faint">
              来源：Hugging Face · rhasspy/piper-voices（直连失败时自动走 hf-mirror.com 镜像）
            </p>
          </div>
          <button
            type="button"
            onClick={onBack}
            className="rounded-lg border border-edge px-3 py-2 text-sm text-ink-muted hover:bg-surface-2"
          >
            返回书架
          </button>
        </header>

        <section className="mb-5 flex items-center justify-between rounded-xl border border-edge bg-surface-2 p-4">
          <p className="text-sm text-ink-muted">
            已安装音色会出现在阅读器的播放条中；下载完成后无需重启，直接刷新页面即可生效。
          </p>
          <button
            type="button"
            onClick={() => void loadCatalog()}
            disabled={loading}
            className="shrink-0 rounded-lg border border-edge px-3 py-1.5 text-xs text-ink-muted transition hover:bg-surface-3 disabled:opacity-50"
          >
            {loading ? '刷新中…' : '重新探测'}
          </button>
        </section>

        {error && <p className="mb-4 rounded-lg bg-bad/10 p-3 text-sm text-bad ring-1 ring-bad/25">{error}</p>}

        <section className="mb-5 rounded-xl border border-edge bg-surface-2 p-4">
          <h2 className="mb-2 text-sm font-medium">从 URL 安装</h2>
          <p className="mb-3 text-xs text-ink-faint">
            支持社区打包的 <code className="mx-0.5">.zip</code>（自动解压出 .onnx /
            .onnx.json）或单个 <code className="mx-0.5">.onnx</code> /
            <code className="mx-0.5">.onnx.json</code> 文件链接。下载前请自行确认来源与许可。
          </p>
          <div className="flex gap-2">
            <input
              type="url"
              value={manualUrl}
              onChange={(e) => setManualUrl(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void installFromUrl(); }}
              placeholder="https://huggingface.co/.../voice.zip"
              className="min-w-0 flex-1 rounded-lg border border-edge bg-surface-3 px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
            />
            <button
              type="button"
              onClick={() => void installFromUrl()}
              disabled={manualBusy || !manualUrl.trim()}
              className="shrink-0 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-surface transition hover:bg-accent-strong disabled:opacity-50"
            >
              {manualBusy ? '启动中…' : '下载安装'}
            </button>
          </div>
          {manualStatus?.status === 'running' && (
            <div className="mt-3">
              <div className="h-1.5 overflow-hidden rounded-full bg-surface-3">
                <div
                  className="h-full rounded-full bg-accent transition-[width] duration-300"
                  style={{ width: `${Math.max(manualStatus.total > 0 ? (manualStatus.received / manualStatus.total) * 100 : 0, 0.03) * 100}%` }}
                />
              </div>
              <p className="mt-1 text-right text-[10px] text-ink-faint">
                {formatBytes(manualStatus.received)} / {formatBytes(manualStatus.total)}
              </p>
            </div>
          )}
          {manualStatus?.status === 'done' && (
            <p className="mt-3 rounded bg-ok/10 p-2 text-xs text-ok">安装完成 ✓ 刷新书架或阅读器即可看到新音色。</p>
          )}
          {manualStatus?.status === 'error' && manualStatus.error && (
            <p className="mt-3 rounded bg-bad/10 p-2 text-xs text-bad">{manualStatus.error}</p>
          )}
        </section>

        {loading && !voices ? (
          <p className="py-10 text-center text-sm text-ink-faint">正在探测语音包来源…</p>
        ) : voices === null ? null : (
          <ul className="flex flex-col gap-3">
            {voices.map((v) => {
              const p = progress[v.id];
              const installing = p?.status === 'running';
              const failed = p?.status === 'error';
              const installingDone = p?.status === 'done';
              const percent = p && p.total > 0 ? Math.min(100, (p.received / p.total) * 100) : 0;
              return (
                <li key={v.id} className="rounded-xl border border-edge bg-surface-2 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">
                        {v.display}
                        <span className="ml-2 font-mono text-[11px] text-ink-faint">{v.id}</span>
                        {v.source === 'community' && (
                          <span className="ml-2 rounded bg-accent/10 px-1.5 py-0.5 text-[10px] text-accent ring-1 ring-accent/30">社区发现</span>
                        )}
                        {v.source === 'official' && v.actualVoice && !KNOWN_IDS.has(v.id) && (
                          <span className="ml-2 rounded bg-surface-3 px-1.5 py-0.5 text-[10px] text-ink-muted ring-1 ring-edge">官方变体</span>
                        )}
                        {v.type === 'zip' && (
                          <span className="ml-2 rounded bg-surface-3 px-1.5 py-0.5 text-[10px] text-ink-muted ring-1 ring-edge">ZIP 包</span>
                        )}
                        {v.installed && (
                          <span className="ml-2 rounded bg-ok/15 px-1.5 py-0.5 text-[10px] text-ok ring-1 ring-ok/30">已安装</span>
                        )}
                        {installing && (
                          <span className="ml-2 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent ring-1 ring-accent/30">下载中</span>
                        )}
                        {installingDone && (
                          <span className="ml-2 rounded bg-ok/15 px-1.5 py-0.5 text-[10px] text-ok ring-1 ring-ok/30">完成</span>
                        )}
                        {failed && (
                          <span className="ml-2 rounded bg-bad/15 px-1.5 py-0.5 text-[10px] text-bad ring-1 ring-bad/30">失败</span>
                        )}
                      </p>
                      <p className="mt-1 text-xs text-ink-muted">
                        许可：<span className={v.downloadPolicy === 'free' ? 'text-ok' : 'text-bad'}>{v.license}</span>
                        <span className="ml-2">大小：{formatBytes(v.sizeOnnx)}</span>
                      </p>
                      {v.downloadPolicy === 'free' ? (
                        <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">
                          此语音包可自由分发（CC0），点击下载后自动安装到 models/piper。
                        </p>
                      ) : v.type === 'zip' ? (
                        <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">
                          社区 ZIP 包。许可未统一标注，点击下载会<b>弹确认框</b>；下载后自动解压并安装
                          <code className="mx-1">.onnx</code>与
                          <code className="mx-1">.onnx.json</code>到 models/piper。
                        </p>
                      ) : (
                        <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">
                          此语音包许可未明确允许分发，点击下载会<b>弹确认框</b>提醒自担风险；
                          你也可以前往原站自行下载后放入
                          <code className="mx-1">models/piper/</code>。
                          <a href={v.home} target="_blank" rel="noreferrer" className="ml-1 text-accent underline">原站 ↗</a>
                        </p>
                      )}
                      {v.installed && (
                        <p className="mt-1 text-[11px] text-ok">已在你本地安装 ✓</p>
                      )}
                    </div>
                    <div className="shrink-0">
                      <button
                        type="button"
                        disabled={installing || v.installed}
                        onClick={() => void startDownload(v)}
                        className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-surface transition hover:bg-accent-strong disabled:opacity-50"
                      >
                        {v.installed ? '已安装' : installing ? '下载中…' : '下载'}
                      </button>
                    </div>
                  </div>

                  {installing && (
                    <div className="mt-3">
                      <div className="h-1.5 overflow-hidden rounded-full bg-surface-3">
                        <div
                          className="h-full rounded-full bg-accent transition-[width] duration-300"
                          style={{ width: `${Math.max(percent, 0.03) * 100}%` }}
                        />
                      </div>
                      <p className="mt-1 text-right text-[10px] text-ink-faint">
                        {formatBytes(p!.received)} / {formatBytes(p!.total)}（{Math.round(percent)}%）
                      </p>
                    </div>
                  )}
                  {failed && p?.error && (
                    <p className="mt-2 rounded bg-bad/10 p-2 text-xs text-bad">{p.error}</p>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <p className="mt-8 text-center text-[11px] leading-relaxed text-ink-faint">
          提示：chaowen 为 CC0 公有领域可直接安装；huayan / xiao_ya 与社区 ZIP 包
          许可未明确允许分发，执行下载时会弹确认框提醒你自担风险。
        </p>
      </div>
    </main>
  );
}
import { Suspense, lazy, useEffect, useState } from 'react';
import { LibraryPage } from '@/pages/LibraryPage';
import { VoicesPage } from '@/pages/VoicesPage';
import { parseReaderQuery } from '@/reader/queryParams';
import { useLibrary } from '@/store/library';
import { useReaderPrefs } from '@/store/readerPrefs';

/**
 * 阅读器按需加载：epub.js 体积不小（约 400KB 未压缩），
 * 而只有真正打开书时才需要它。这样书架首屏不必为它买单。
 */
const ReaderPage = lazy(() =>
  import('@/pages/ReaderPage').then((m) => ({ default: m.ReaderPage })),
);

/**
 * 用 hash 路由而不是引入路由库：只有"书架 / 阅读器"两个视图，
 * hash 天然支持刷新与前进后退，也不用改服务端的 SPA 回退逻辑。
 */
function useHashRoute(): { bookId?: string; query: Record<string, string>; page: 'library' | 'voices' | 'reader' } {
  const [hash, setHash] = useState(() => window.location.hash);

  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  const m = /^#\/read\/([^/?#]+)/.exec(hash);
  return {
    bookId: m ? decodeURIComponent(m[1]!) : undefined,
    query: parseReaderQuery(hash),
    page: hash.startsWith('#/voices') ? 'voices' : m ? 'reader' : 'library',
  };
}

export function App() {
  const load = useLibrary((s) => s.load);
  const toast = useLibrary((s) => s.toast);
  const setToast = useLibrary((s) => s.setToast);
  const loadError = useLibrary((s) => s.loadError);
  const setPrefs = useReaderPrefs((s) => s.set);
  const { bookId, query, page } = useHashRoute();
  // query 每次渲染都是新对象，直接做依赖会导致 effect 每次渲染都执行 →
  // setPrefs 再触发渲染 → 无限循环，ReaderPage 被反复卸载重挂，
  // 界面永远停在 Suspense 的"正在加载阅读器…"（实测踩到过）。
  // 所以用它的字符串形式做依赖，只有内容真的变了才应用。
  const queryKey = JSON.stringify(query);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * 应用 URL 里的启动偏好（`?engine=webspeech&rate=1.2`）。
   * 这样分享链接即可固定设置，自动化验证也不用先写 localStorage 再导航。
   */
  useEffect(() => {
    const patch: Record<string, unknown> = {};
    if (query.engine === 'webspeech' || query.engine === 'piper') patch.ttsEngine = query.engine;
    if (query.voice) patch.voiceId = query.voice;
    if (query.rate && !Number.isNaN(Number(query.rate))) patch.rate = Number(query.rate);
    if (Object.keys(patch).length === 0) return;
    setPrefs(patch);
    // queryKey 是 query 的稳定字符串形式
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey, setPrefs]);

  // 提示 3 秒后自动消失
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(undefined), 3000);
    return () => window.clearTimeout(timer);
  }, [toast, setToast]);

  const exitReader = () => {
    // 清掉 hash 回到书架；hashchange 会驱动重渲染
    window.location.hash = '';
    // 某些浏览器把空 hash 保留为 '#'，这里兜底确保视图切回去
    if (window.location.hash === '#') window.history.replaceState(null, '', window.location.pathname);
  };

  return (
    // overflow-x-hidden 兜底：任何子元素意外撑宽都不该让整页出现横向滚动
    <div className="h-full overflow-x-hidden">
      {page === 'voices' ? (
        <VoicesPage onBack={exitReader} />
      ) : bookId ? (
        <Suspense
          fallback={
            <div className="flex h-full items-center justify-center">
              <p className="text-sm text-ink-muted">正在加载阅读器…</p>
            </div>
          }
        >
          <ReaderPage bookId={bookId} onExit={exitReader} />
        </Suspense>
      ) : (
        <LibraryPage />
      )}

      {toast && (
        <div
          role="status"
          className={`fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg px-4 py-2.5 text-sm shadow-lg ring-1 ${
            toast.kind === 'error'
              ? 'bg-bad/15 text-bad ring-bad/30'
              : 'bg-surface-3 text-ink ring-edge'
          }`}
        >
          {toast.text}
        </div>
      )}

      {loadError && !bookId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-surface/80 p-6">
          <div className="max-w-md rounded-xl bg-surface-2 p-6 ring-1 ring-edge">
            <h2 className="mb-2 text-lg font-semibold text-bad">无法连接本地服务</h2>
            <p className="mb-4 text-sm text-ink-muted">{loadError}</p>
            <p className="text-sm text-ink-faint">
              请在项目目录执行 <code className="rounded bg-surface-3 px-1.5 py-0.5">pnpm dev</code>{' '}
              同时启动接口与前端，然后刷新页面。
            </p>
            <button
              type="button"
              onClick={() => void load()}
              className="mt-4 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-surface hover:bg-accent-strong"
            >
              重试
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

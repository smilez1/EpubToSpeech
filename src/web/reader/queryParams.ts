/**
 * 阅读器相关的纯工具函数。
 *
 * 单独成一个模块，是为了让 App 之类的上层组件能引用它们，
 * 而不会把 `reader/session.ts`（它 import 了 epub.js，体积很大）拖进主包。
 * 之前 parseReaderQuery 放在 session.ts 里，导致 epub.js 被拉回主 chunk，
 * 阅读器的按需加载失效（主包从 347KB 涨到 734KB）。
 */

/**
 * 解析 hash 里的查询参数。
 *
 * 用途：
 *  1. 分享链接时固定引擎/音色，例如 `#/read/<id>?engine=webspeech&rate=1.2`
 *  2. 自动化验证时不必先写 localStorage 再导航（那样会与首次渲染竞争）
 */
export function parseReaderQuery(hash: string): Record<string, string> {
  const qIndex = hash.indexOf('?');
  if (qIndex === -1) return {};
  const out: Record<string, string> = {};
  for (const pair of hash.slice(qIndex + 1).split('&')) {
    if (!pair) continue;
    const [k, v] = pair.split('=');
    if (k && v !== undefined) out[decodeURIComponent(k)] = decodeURIComponent(v);
  }
  return out;
}

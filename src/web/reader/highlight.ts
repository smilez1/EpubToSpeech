/**
 * 句子高亮与自动跟随滚动。
 *
 * 采用**覆盖层**而不是往正文里插 `<span>`：
 *  - 不改动书籍 DOM，避免破坏原书 CSS 与后续 CFI 定位
 *  - 换句时只需移动一个绝对定位的方框，代价极小
 *  - 不受 `* { }` 之类通配样式影响
 *
 * 覆盖层插入 iframe 的 body 内（不是外层文档），这样缩放/滚动天然同步。
 */

/** 只依赖 epub.js Contents 的这几个能力，避免与它的类型强耦合。 */
export interface ContentsLike {
  document: Document;
  window: Window;
  content?: Document | Element;
}

export class SentenceHighlighter {
  private overlay: HTMLElement | null = null;
  private contents: ContentsLike | null = null;
  private lastRange: Range | null = null;
  private readonly onRelayout = (): void => this.reposition();

  /**
   * 绑定到一份新内容（翻章后必须重新绑定，旧 document 已失效）。
   * 会清除旧覆盖层。
   */
  attach(contents: ContentsLike): void {
    if (this.contents && this.contents !== contents) this.detach();

    this.contents = contents;
    const doc = contents.document;
    const body = doc?.body;
    if (!body) return;

    // 覆盖层用 body 作为定位参照
    if (doc.defaultView?.getComputedStyle(body).position === 'static') {
      body.style.position = 'relative';
    }

    const overlay = doc.createElement('div');
    overlay.setAttribute('data-tts-highlight', 'true');
    // 不要用 <mark>：mark 有默认样式，且更容易被原书 CSS 命中
    overlay.style.cssText = [
      'position:absolute',
      'pointer-events:none',
      'z-index:1',
      'border-radius:3px',
      'background-color:rgba(122,162,247,0.28)',
      'box-shadow:0 0 0 1px rgba(122,162,247,0.35)',
      'transition:top 120ms linear,left 120ms linear,width 120ms linear,height 120ms linear',
      'display:none',
    ].join(';');
    body.appendChild(overlay);
    this.overlay = overlay;
    this.lastRange = null;

    // 尺寸变化（字号/窗口）后需要重新定位
    try {
      contents.window?.addEventListener('resize', this.onRelayout);
    } catch {
      /* 某些环境拿不到 window，忽略 */
    }
  }

  detach(): void {
    try {
      this.contents?.window?.removeEventListener('resize', this.onRelayout);
    } catch {
      /* 忽略 */
    }
    if (this.overlay?.parentNode) this.overlay.parentNode.removeChild(this.overlay);
    this.overlay = null;
    this.contents = null;
    this.lastRange = null;
  }

  /** 高亮一个 Range；传 null 表示清除。 */
  highlight(range: Range | null): void {
    this.lastRange = range;
    if (!this.overlay) return;
    if (!range) {
      this.overlay.style.display = 'none';
      return;
    }
    this.positionOverlay(range);
  }

  /** 清空高亮并移除覆盖层。 */
  clear(): void {
    this.highlight(null);
    this.detach();
  }

  /** 供 scroll / 字号变化后重新定位。 */
  refresh(): void {
    if (this.lastRange) this.positionOverlay(this.lastRange);
  }

  /** 当前高亮是否已滚出可视区；越界时把视口调整到可见位置。 */
  scrollIntoView(range: Range | null = this.lastRange): void {
    if (!range || !this.contents) return;
    const win = this.contents.window;
    const doc = this.contents.document;
    if (!win || !doc) return;

    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;

    // epub.js 的滚动容器可能是 body 自身，也可能是某个祖先元素
    const scroller = findScroller(doc);
    const viewBottom = win.innerHeight;
    const visibleTop = viewBottom * 0.1;

    if (rect.top >= visibleTop && rect.bottom <= viewBottom) return;

    const target = scroller.scrollTop + rect.top - viewBottom * 0.3;
    try {
      scroller.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
    } catch {
      scroller.scrollTop = Math.max(0, target);
    }
  }

  private reposition(): void {
    this.refresh();
  }

  private positionOverlay(range: Range): void {
    const overlay = this.overlay;
    const doc = this.contents?.document;
    const body = doc?.body;
    if (!overlay || !body) return;

    const rects = range.getClientRects();
    if (rects.length === 0) {
      overlay.style.display = 'none';
      return;
    }

    // 合并所有行形成一个包围盒（比逐行画多块更省事，观感也更稳）
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const r of Array.from(rects)) {
      if (r.width === 0 && r.height === 0) continue;
      left = Math.min(left, r.left);
      top = Math.min(top, r.top);
      right = Math.max(right, r.right);
      bottom = Math.max(bottom, r.bottom);
    }
    if (!Number.isFinite(left) || !Number.isFinite(top)) {
      overlay.style.display = 'none';
      return;
    }

    // 覆盖层是 body 的子元素（body 已设为 position:relative），
    // 所以坐标 = 视口坐标 + body 的滚动量。不要再叠加 offsetLeft/offsetTop，
    // 那会把参照系重复计算两次。
    const bodyRect = body.getBoundingClientRect();
    const x = left - bodyRect.left + body.scrollLeft;
    const y = top - bodyRect.top + body.scrollTop;

    overlay.style.display = 'block';
    overlay.style.left = `${x}px`;
    overlay.style.top = `${y}px`;
    overlay.style.width = `${Math.max(0, right - left)}px`;
    overlay.style.height = `${Math.max(0, bottom - top)}px`;
  }
}

/** 找到实际发生滚动的元素：优先 body/html，其次带 overflow 的最近祖先。 */
function findScroller(doc: Document): Element {
  const body = doc.body;
  const docEl = doc.documentElement;
  // 若 body 本身可滚动，用它
  if (body && body.scrollHeight > body.clientHeight + 1) return body;
  return docEl ?? body;
}

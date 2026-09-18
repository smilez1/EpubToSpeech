/**
 * 测试用的最小 DOM 实现。
 *
 * 只实现被测代码真正用到的那部分接口：
 *  textContent / children / childNodes / matches / contains /
 *  getAttribute / hasAttribute / tagName / nodeType / parent / createTreeWalker / createRange
 *
 * 目标是让句子抽取与高亮定位逻辑能在 Node 下被确定性地验证，
 * 而不是只能靠浏览器里肉眼观察。
 */

export const ELEMENT_NODE = 1;
export const TEXT_NODE = 3;

class FakeNode {
  get nodeType() {
    return 0;
  }
}

export class FakeText extends FakeNode {
  constructor(data) {
    super();
    this.data = String(data);
    this.parentNode = null;
  }
  get nodeType() {
    return TEXT_NODE;
  }
  get textContent() {
    return this.data;
  }
  set textContent(v) {
    this.data = String(v);
  }
}

export class FakeElement extends FakeNode {
  /**
   * @param {string} tagName
   * @param {object} [attrs]
   * @param {Array} [children] 子节点（FakeElement 或 FakeText）
   */
  constructor(tagName, attrs = {}, children = []) {
    super();
    this.tagName = tagName.toUpperCase();
    this.attributes = { ...attrs };
    this.childNodes = [];
    this.parentNode = null;
    for (const c of children) this.appendChild(c);
  }

  get nodeType() {
    return ELEMENT_NODE;
  }

  get localName() {
    return this.tagName.toLowerCase();
  }

  appendChild(child) {
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  /** 只包含元素子节点，与真实 DOM 的 children 一致。 */
  get children() {
    return this.childNodes.filter((c) => c.nodeType === ELEMENT_NODE);
  }

  get textContent() {
    return this.childNodes.map((c) => c.textContent).join('');
  }

  set textContent(v) {
    this.childNodes = [];
    if (v !== '') this.appendChild(new FakeText(v));
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name)
      ? this.attributes[name]
      : null;
  }

  hasAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name);
  }

  /** 支持逗号分隔的选择器，只按标签名匹配（够用）。 */
  matches(selector) {
    return selector
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .some((s) => s === this.tagName || s === '*');
  }

  contains(other) {
    if (other === this) return true;
    for (const c of this.childNodes) {
      if (c === other) return true;
      if (c.nodeType === ELEMENT_NODE && c.contains(other)) return true;
    }
    return false;
  }
}

export class FakeRange {
  constructor() {
    this.startContainer = null;
    this.startOffset = 0;
    this.endContainer = null;
    this.endOffset = 0;
  }
  setStart(node, offset) {
    this.startContainer = node;
    this.startOffset = offset;
  }
  setEnd(node, offset) {
    this.endContainer = node;
    this.endOffset = offset;
  }
  detach() {}
}

/**
 * 安装全局 document / NodeFilter，返回 restore 函数。
 * 多次调用会覆盖，测试结束可调用返回的 restore。
 */
export function installDom() {
  const previousDocument = globalThis.document;
  const previousNodeFilter = globalThis.NodeFilter;

  globalThis.document = {
    createTreeWalker(root, whatToShow) {
      const all = [];
      const collect = (n) => {
        if (whatToShow === undefined || n.nodeType === whatToShow) all.push(n);
        for (const c of n.childNodes ?? []) collect(c);
      };
      // SHOW_TEXT 只看文本节点；不传则全部
      collect(root);
      let i = 0;
      return {
        nextNode: () => (i < all.length ? all[i++] : null),
        currentNode: null,
      };
    },
    createRange: () => new FakeRange(),
    createElement(tag) {
      return new FakeElement(tag);
    },
  };
  globalThis.NodeFilter = { SHOW_TEXT: TEXT_NODE };

  return () => {
    globalThis.document = previousDocument;
    globalThis.NodeFilter = previousNodeFilter;
  };
}

/** 便捷构造：<p>…</p> */
export function p(...children) {
  return new FakeElement('p', {}, children);
}

export function el(tag, attrs, children = []) {
  return new FakeElement(tag, attrs, children);
}

export function t(text) {
  return new FakeText(text);
}

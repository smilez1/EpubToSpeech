import JSZip from 'jszip';
import type { TocEntry } from '@shared/book.ts';

/**
 * 浏览器侧 EPUB 解析。
 *
 * 只做「书架需要的轻量元数据」：书名、作者、语言、出版社、封面、目录、章节数。
 * 正文渲染交给 M2 的 epub.js，那个库自己会再解析一遍（它有缓存与 CFI 能力）。
 * 这里不引入 epub.js，是为了让导入流程快且不依赖渲染层。
 */

const DC_NS = 'http://purl.org/dc/elements/1.1/';
const CONTAINER_NS = 'urn:oasis:names:tc:opendocument:xmlns:container';
const OPF_NS = 'http://www.idpf.org/2007/opf';
const NCX_NS = 'http://www.daisy.org/z3986/2005/ncx/';

export interface ParsedEpub {
  title?: string;
  author?: string;
  language?: string;
  publisher?: string;
  /** 封面图原始字节；超过 size 上限时为 undefined（原因见 warnings）。 */
  cover?: Blob;
  toc: TocEntry[];
  chapterCount: number;
  /** 解析过程中可容忍的问题，用于在 UI 上提示而不是直接失败。 */
  warnings: string[];
}

/** 封面原图上限：超过就不存，避免数据目录被大图撑爆。 */
const MAX_COVER_BYTES = 5 * 1024 * 1024;

function parseXml(text: string, kind: 'xml' | 'xhtml' = 'xml'): Document {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) {
    // xhtml 用 application/xml 解析更严格；退一步用 text/html 容错
    return new DOMParser().parseFromString(text, kind === 'xhtml' ? 'text/html' : 'text/xml');
  }
  return doc;
}

/** 拼接 epub 内部相对路径，处理 `../` 与 `./`。 */
function resolvePath(baseDir: string, href: string): string {
  const raw = href.split('#')[0] ?? '';
  const parts = [...(baseDir ? baseDir.split('/') : []), ...raw.split('/')];
  const out: string[] = [];
  for (const p of parts) {
    if (!p || p === '.') continue;
    if (p === '..') out.pop();
    else out.push(p);
  }
  return out.join('/');
}

function dirOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

function baseOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}

function firstText(parent: Element | Document, localName: string): string | undefined {
  const el = parent.getElementsByTagNameNS(DC_NS, localName)[0];
  const text = el?.textContent?.trim();
  return text ? text : undefined;
}

function metaContent(doc: Document, name: string): string | undefined {
  const metas = Array.from(doc.getElementsByTagNameNS(OPF_NS, 'meta'));
  for (const m of metas) {
    const n = m.getAttribute('name') ?? m.getAttribute('property');
    if (n === name) {
      const v = (m.getAttribute('content') ?? m.textContent ?? '').trim();
      if (v) return v;
    }
  }
  return undefined;
}

interface ManifestItem {
  id: string;
  href: string;
  mediaType: string;
  properties: string;
}

interface OpfData {
  opfDir: string;
  title?: string;
  author?: string;
  language?: string;
  publisher?: string;
  coverHref?: string;
  navHref?: string;
  ncxHref?: string;
  spineHrefs: string[];
  manifestById: Map<string, ManifestItem>;
  warnings: string[];
}

function parseOpf(doc: Document, opfPath: string): OpfData {
  const opfDir = dirOf(opfPath);
  const warnings: string[] = [];

  const manifestEl = doc.getElementsByTagNameNS(OPF_NS, 'manifest')[0];
  const manifestById = new Map<string, ManifestItem>();
  const items: ManifestItem[] = manifestEl
    ? Array.from(manifestEl.getElementsByTagNameNS(OPF_NS, 'item')).map((el) => {
        const item: ManifestItem = {
          id: el.getAttribute('id') ?? '',
          href: resolvePath(opfDir, el.getAttribute('href') ?? ''),
          mediaType: el.getAttribute('media-type') ?? '',
          properties: el.getAttribute('properties') ?? '',
        };
        manifestById.set(item.id, item);
        return item;
      })
    : [];
  if (items.length === 0) warnings.push('manifest 为空，这本书可能不是标准 EPUB');

  // 书名/作者：dc 元素缺失时退回 meta 与文件名
  const metadataEl = doc.getElementsByTagNameNS(OPF_NS, 'metadata')[0];
  const metadata: Element | Document = metadataEl ?? doc;
  let title = firstText(metadata, 'title');
  if (!title) title = metaContent(doc, 'title') ?? metaContent(doc, 'dc:title');
  if (!title) {
    title = baseOf(opfPath).replace(/\.opf$/i, '') || undefined;
    if (title) warnings.push('未找到 dc:title，暂用文件名作为书名');
  }
  const author = firstText(metadata, 'creator') ?? metaContent(doc, 'creator');
  const language = firstText(metadata, 'language') ?? metaContent(doc, 'language');
  const publisher = firstText(metadata, 'publisher');

  // 封面：EPUB3 properties="cover-image" → EPUB2 meta[name=cover] → 文件名启发式
  let coverHref: string | undefined;
  const coverImageItem = items.find((i) => i.properties.split(/\s+/).includes('cover-image'));
  if (coverImageItem) {
    coverHref = coverImageItem.href;
  } else {
    const coverId = metaContent(doc, 'cover');
    if (coverId && manifestById.has(coverId)) coverHref = manifestById.get(coverId)!.href;
  }
  if (!coverHref) {
    const guess = items.find(
      (i) => i.mediaType.startsWith('image/') && /cover/i.test(baseOf(i.href)),
    );
    if (guess) coverHref = guess.href;
  }

  // EPUB3 导航文档
  const navHref = items.find(
    (i) => i.properties.split(/\s+/).includes('nav') || i.mediaType === 'application/xhtml+xml' && /(^|\/)nav\.x?html?$/i.test(i.href),
  )?.href;

  // EPUB2 NCX
  const spineEl = doc.getElementsByTagNameNS(OPF_NS, 'spine')[0];
  const tocId = spineEl?.getAttribute('toc');
  let ncxHref = tocId && manifestById.has(tocId)
    ? manifestById.get(tocId)!.href
    : items.find((i) => i.mediaType === 'application/x-dtbncx+xml')?.href;

  // spine 顺序 = 正文章节顺序
  const spineHrefs: string[] = [];
  if (spineEl) {
    for (const ref of Array.from(spineEl.getElementsByTagNameNS(OPF_NS, 'itemref'))) {
      const id = ref.getAttribute('idref');
      const item = id ? manifestById.get(id) : undefined;
      if (item) spineHrefs.push(item.href);
    }
  }
  if (spineHrefs.length === 0) warnings.push('spine 为空，无法确定正文章节');

  return {
    opfDir,
    title,
    author,
    language,
    publisher,
    coverHref,
    navHref,
    ncxHref,
    spineHrefs,
    manifestById,
    warnings,
  };
}

/** 解析 EPUB3 nav 文档。 */
function parseNavToc(doc: Document, navHref: string): TocEntry[] {
  // 优先 epub:type="toc" 的 nav；否则取第一个 nav
  const navs = Array.from(doc.getElementsByTagName('nav'));
  const tocNav =
    navs.find((n) => (n.getAttribute('epub:type') ?? n.getAttributeNS('http://www.idpf.org/2007/ops', 'type')) === 'toc') ??
    navs.find((n) => n.querySelector('ol')) ??
    navs[0];
  if (!tocNav) return [];

  const baseDir = dirOf(navHref);
  const walk = (ol: Element): TocEntry[] => {
    const out: TocEntry[] = [];
    const lis = Array.from(ol.children).filter((c) => c.localName === 'li');
    for (const li of lis) {
      const a = Array.from(li.children).find((c) => c.localName === 'a');
      const nestedOl = Array.from(li.children).find((c) => c.localName === 'ol');
      const label = (a?.textContent ?? '').replace(/\s+/g, ' ').trim() || '(无标题)';
      const href = a?.getAttribute('href') ?? '';
      const entry: TocEntry = { label, href: href ? resolvePath(baseDir, href) : '' };
      if (nestedOl) {
        const children = walk(nestedOl);
        if (children.length) entry.children = children;
      }
      out.push(entry);
    }
    return out;
  };

  const firstOl = tocNav.querySelector('ol');
  return firstOl ? walk(firstOl) : [];
}

/** 解析 EPUB2 NCX。 */
function parseNcxToc(doc: Document, ncxHref: string): TocEntry[] {
  const baseDir = dirOf(ncxHref);
  const walk = (parent: Element): TocEntry[] => {
    const out: TocEntry[] = [];
    const points = Array.from(parent.children).filter(
      (c) => c.localName === 'navPoint' && c.namespaceURI === NCX_NS,
    );
    for (const np of points) {
      const labelEl = Array.from(np.children).find((c) => c.localName === 'navLabel');
      const contentEl = Array.from(np.children).find((c) => c.localName === 'content');
      const label = (labelEl?.textContent ?? '').replace(/\s+/g, ' ').trim() || '(无标题)';
      const src = contentEl?.getAttribute('src') ?? '';
      const entry: TocEntry = { label, href: src ? resolvePath(baseDir, src) : '' };
      const children = walk(np);
      if (children.length) entry.children = children;
      out.push(entry);
    }
    return out;
  };

  const navMap = doc.getElementsByTagNameNS(NCX_NS, 'navMap')[0];
  if (!navMap) return [];
  return walk(navMap);
}

function countToc(entries: TocEntry[]): number {
  return entries.reduce((n, e) => n + 1 + countToc(e.children ?? []), 0);
}

/** 语言未标注时，用正文汉字/假名比例猜一个，方便 TTS 选音色。 */
function guessLanguage(text: string): string | undefined {
  const sample = text.slice(0, 4000);
  if (!sample.trim()) return undefined;
  const han = (sample.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const kana = (sample.match(/[\u3040-\u30ff]/g) ?? []).length;
  const latin = (sample.match(/[A-Za-z]/g) ?? []).length;
  if (kana > 20) return 'ja';
  if (han > latin) return 'zh';
  if (latin > 0) return 'en';
  return undefined;
}

/**
 * 解析一个 epub 文件（浏览器 side）。
 * 解析失败会抛错，调用方应把它当作"这本书打不开"处理。
 */
export async function parseEpub(file: File): Promise<ParsedEpub> {
  const zip = await JSZip.loadAsync(file);
  const warnings: string[] = [];

  // 1. META-INF/container.xml → OPF 路径
  const containerEntry = zip.file('META-INF/container.xml');
  if (!containerEntry) {
    throw new Error('不是有效的 EPUB：缺少 META-INF/container.xml');
  }
  const containerDoc = parseXml(await containerEntry.async('text'));
  const rootfile = containerDoc.getElementsByTagNameNS(CONTAINER_NS, 'rootfile')[0]
    ?? containerDoc.getElementsByTagName('rootfile')[0];
  const opfPath = rootfile?.getAttribute('full-path');
  if (!opfPath) {
    throw new Error('不是有效的 EPUB：container.xml 里没有 rootfile');
  }

  // 2. OPF
  const opfEntry = zip.file(opfPath);
  if (!opfEntry) {
    throw new Error(`EPUB 结构异常：找不到 ${opfPath}`);
  }
  const opfDoc = parseXml(await opfEntry.async('text'));
  const opf = parseOpf(opfDoc, opfPath);
  warnings.push(...opf.warnings);

  // 3. 目录（nav 优先，其次 ncx）
  let toc: TocEntry[] = [];
  if (opf.navHref) {
    const navEntry = zip.file(opf.navHref);
    if (navEntry) {
      try {
        toc = parseNavToc(parseXml(await navEntry.async('text'), 'xhtml'), opf.navHref);
      } catch (err) {
        warnings.push(`nav 目录解析失败：${(err as Error).message}`);
      }
    }
  }
  if (toc.length === 0 && opf.ncxHref) {
    const ncxEntry = zip.file(opf.ncxHref);
    if (ncxEntry) {
      try {
        toc = parseNcxToc(parseXml(await ncxEntry.async('text')), opf.ncxHref);
      } catch (err) {
        warnings.push(`NCX 目录解析失败：${(err as Error).message}`);
      }
    }
  }
  if (toc.length === 0) {
    warnings.push('这本书没有可用目录');
  }

  // 4. 封面
  let cover: Blob | undefined;
  if (opf.coverHref) {
    const coverEntry = zip.file(opf.coverHref);
    if (!coverEntry) {
      warnings.push('封面文件在压缩包里找不到');
    } else {
      const buf = await coverEntry.async('uint8array');
      if (buf.byteLength > MAX_COVER_BYTES) {
        warnings.push(`封面超过 5MB（${Math.round(buf.byteLength / 1024 / 1024)}MB），已跳过`);
      } else {
        // 拷贝一份放进 Blob：JSZip 返回的视图底层可能是 SharedArrayBuffer，
        // 直接当 BlobPart 用会被 TS 以及部分浏览器拒绝。
        const copy = new Uint8Array(buf.byteLength);
        copy.set(buf);
        cover = new Blob([copy], { type: guessImageType(opf.coverHref) });
      }
    }
  } else {
    warnings.push('这本书没有封面图');
  }

  // 5. 语言：优先 dc:language；缺失时用第一章正文猜
  let language = normalizeLanguage(opf.language);
  if (!language && opf.spineHrefs[0]) {
    const firstEntry = zip.file(opf.spineHrefs[0]);
    if (firstEntry) {
      const text = await firstEntry.async('text');
      language = guessLanguage(text.replace(/<[^>]+>/g, ' '));
    }
  }

  return {
    title: opf.title,
    author: opf.author,
    language,
    publisher: opf.publisher,
    cover,
    toc,
    chapterCount: opf.spineHrefs.length,
    warnings,
  };
}

function guessImageType(href: string): string {
  const ext = href.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'svg':
      return 'image/svg+xml';
    default:
      return 'image/jpeg';
  }
}

/** 把 `zh-CN` / `zh-Hans` 归一成 TTS 匹配用的大类。 */
function normalizeLanguage(raw?: string): string | undefined {
  if (!raw) return undefined;
  const v = raw.trim().toLowerCase();
  if (!v) return undefined;
  if (v.startsWith('zh')) return v.includes('tw') || v.includes('hk') || v.includes('hant') ? 'zh-TW' : 'zh-CN';
  if (v.startsWith('ja')) return 'ja-JP';
  if (v.startsWith('en')) return 'en-US';
  return raw.trim();
}

export function tocEntryCount(toc: TocEntry[]): number {
  return countToc(toc);
}

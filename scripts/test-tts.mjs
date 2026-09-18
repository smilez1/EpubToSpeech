/**
 * 分句切块与字符偏移映射的单元测试。
 *
 * 这两个模块是 M3 朗读正确性的地基：
 *  - chunk.ts 决定一句话会不会被读破、会不会太长被浏览器截断
 *  - range.ts 决定高亮会不会越走越偏
 * 它们刻意写成不依赖真实 DOM 环境，所以这里能用 Node 直接跑。
 *
 * 用法：node --experimental-strip-types scripts/test-tts.mjs
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTsModule } from './lib/load-ts.mjs';

const { chunkText, estimateSpeechSeconds, MAX_CHUNK_CHARS } = await loadTsModule(
  'src/web/tts/chunk.ts',
);
const {
  buildTextMap,
  positionAt,
  rangeFromOffsets,
  wordRangeAt,
  buildWhitespaceIndex,
  collapsedIndexToRaw,
} = await loadTsModule('src/web/tts/range.ts');
const { normalizeForSpeech, normalizedToRawIndex, estimateDurationMs } = await loadTsModule(
  'src/web/tts/speech.ts',
);

/* ================================ chunkText ================================ */

test('按中文句末标点切句', () => {
  // 注意：默认会合并长度 < MIN_MERGE_CHARS(12) 的短句，所以这里每句都写得够长，
  // 才能观察到纯粹的"按标点切分"行为。合并行为另有专门用例。
  const chunks = chunkText(
    '这是第一句话，还连着一点内容。这是第二句话，也足够长了！这是第三句话，同样够长？',
  );
  assert.deepEqual(
    chunks.map((c) => c.text),
    ['这是第一句话，还连着一点内容。', '这是第二句话，也足够长了！', '这是第三句话，同样够长？'],
  );
});

test('短句会被合并（默认阈值 12 字符），且不越过长度上限', () => {
  const chunks = chunkText('这是第一句话，已经足够长了。短句！');
  assert.equal(chunks.length, 1, '过短的尾句应并入前一段');
  assert.equal(chunks[0].text, '这是第一句话，已经足够长了。短句！');
});

test('可以关掉合并（minMergeChars: 0）以观察原始切句', () => {
  const chunks = chunkText('这是第一句话，还连着一点内容。短句！', { minMergeChars: 0 });
  assert.deepEqual(
    chunks.map((c) => c.text),
    ['这是第一句话，还连着一点内容。', '短句！'],
  );
});

test('chunk 的 start/end 能精确切回原文', () => {
  const text = '甲。乙丙。丁！';
  const chunks = chunkText(text);
  for (const c of chunks) {
    assert.equal(text.slice(c.start, c.end), c.text, `区间与文本不一致: ${JSON.stringify(c)}`);
  }
  assert.equal(chunks.map((c) => c.text).join(''), text);
});

test('不把小数当成句末', () => {
  const chunks = chunkText('圆周率约等于 3.14 这个数值很有名，值得记住。');
  assert.equal(chunks.length, 1);
  assert.match(chunks[0].text, /3\.14/);
});

test('不把常见英文缩写当成句末', () => {
  const chunks = chunkText('Mr. Smith went to Washington. He arrived late.');
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].text, 'Mr. Smith went to Washington.');
  assert.equal(chunks[1].text, 'He arrived late.');
});

test('句末的收尾引号归入该句，且整个引语算一句', () => {
  const chunks = chunkText('他说：“今天真的不去了。”然后转身离开，走得很慢。');
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].text, '他说：“今天真的不去了。”');
  assert.equal(chunks[1].text, '然后转身离开，走得很慢。');
});

test('引号内只有短句时，短句合并逻辑仍适用', () => {
  // 句号后紧跟引号：短句合并会把它们并在一起（这是"避免语气碎片"的预期行为）
  const chunks = chunkText('他说：“不去了。”于是大家各自散去。');
  assert.equal(chunks.length, 1);
});

test('过短的句子向后合并，避免语气碎片', () => {
  const chunks = chunkText('好。我们继续往下读这一段内容。');
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].text, '好。我们继续往下读这一段内容。');
});

test('超长句在次级标点处二次切分且不超上限', () => {
  const long = `${'甲'.repeat(80)}，${'乙'.repeat(80)}，${'丙'.repeat(80)}。`;
  const chunks = chunkText(long);
  assert.ok(chunks.length >= 2, `应被切分，实际 ${chunks.length} 段`);
  for (const c of chunks) {
    assert.ok(c.text.length <= MAX_CHUNK_CHARS, `超过上限: ${c.text.length}`);
  }
  // 拼回去应与原文一致（区间互不重叠且连续覆盖）
  assert.equal(chunks.map((c) => c.text).join(''), long);
});

test('无标点的长文本也能硬切，不会产生超长块', () => {
  const chunks = chunkText('字'.repeat(500));
  assert.ok(chunks.length >= 3);
  for (const c of chunks) assert.ok(c.text.length <= MAX_CHUNK_CHARS);
  assert.equal(chunks.map((c) => c.text).join(''), '字'.repeat(500));
});

test('空文本与纯空白返回空数组', () => {
  assert.deepEqual(chunkText(''), []);
  assert.deepEqual(chunkText('   \n\t  '), []);
});

test('跨空白的短句会被合并（含换行分隔的段落）', () => {
  // 这是刻意的行为：合并是纯文本层面的，不区分换行。
  // 真实阅读器是按块级元素逐个提取文本的，所以不同段落不会被粘在一起。
  const chunks = chunkText('第一段结束。\n\n第二段开始，这里有足够长的内容。');
  assert.equal(chunks.length, 1);

  // 关掉合并后能清楚看到两句是分开的
  const split = chunkText('第一段结束。\n\n第二段开始，这里有足够长的内容。', { minMergeChars: 0 });
  assert.equal(split.length, 2);
  assert.equal(split[0].text, '第一段结束。');
  assert.equal(split[1].text, '第二段开始，这里有足够长的内容。');
});

test('estimateSpeechSeconds 随语速反比缩放', () => {
  const slow = estimateSpeechSeconds('这是一段中文。', 0.5);
  const fast = estimateSpeechSeconds('这是一段中文。', 2);
  assert.ok(slow > fast);
});

/* ================================ range.ts ================================ */

/* --- 最小 DOM 桩：只实现 range.ts 用到的接口 --- */

class FakeText {
  constructor(data) {
    this.data = data;
    this.nodeType = 3;
  }
}

class FakeElement {
  constructor(childNodes) {
    this.childNodes = childNodes;
  }
}

class FakeRange {
  setStart(node, offset) {
    this.startContainer = node;
    this.startOffset = offset;
  }
  setEnd(node, offset) {
    this.endContainer = node;
    this.endOffset = offset;
  }
}

globalThis.document = {
  createTreeWalker(root) {
    const all = [];
    const collect = (n) => {
      if (n.nodeType === 3) all.push(n);
      for (const c of n.childNodes ?? []) collect(c);
    };
    collect(root);
    let i = 0;
    return { nextNode: () => (i < all.length ? all[i++] : null) };
  },
  createRange: () => new FakeRange(),
};
globalThis.NodeFilter = { SHOW_TEXT: 4 };

/** 构造 <p>abc<em>def</em>ghi</p> 这样的结构 */
function makeParagraph() {
  const a = new FakeText('abc');
  const d = new FakeText('def');
  const g = new FakeText('ghi');
  const em = new FakeElement([d]);
  const p = new FakeElement([a, em, g]);
  return { p, a, d, g };
}

test('buildTextMap 跨多个文本节点累积下标', () => {
  const { p, a, d, g } = makeParagraph();
  const map = buildTextMap(p);
  assert.equal(map.text, 'abcdefghi');
  assert.equal(map.nodes.length, 3);
  assert.deepEqual(
    map.nodes.map((n) => [n.node, n.start, n.length]),
    [
      [a, 0, 3],
      [d, 3, 3],
      [g, 6, 3],
    ],
  );
});

test('positionAt 能把聚合下标定位到正确的节点与节点内偏移', () => {
  const { p, a, d, g } = makeParagraph();
  const map = buildTextMap(p);
  assert.equal(positionAt(map, 0).node, a);
  assert.equal(positionAt(map, 0).offset, 0);
  assert.equal(positionAt(map, 4).node, d);
  assert.equal(positionAt(map, 4).offset, 1);
  assert.equal(positionAt(map, 8).node, g);
  assert.equal(positionAt(map, 8).offset, 2);
});

test('positionAt 在节点边界优先归到前一个节点末尾', () => {
  const { p, a } = makeParagraph();
  const map = buildTextMap(p);
  const at3 = positionAt(map, 3);
  // 下标 3 既是 a 的末尾也是 d 的开头，应稳定返回其中之一且偏移合法
  assert.equal(at3.node, a);
  assert.equal(at3.offset, 3);
});

test('positionAt 越界会被夹住而不是抛错', () => {
  const { p } = makeParagraph();
  const map = buildTextMap(p);
  assert.equal(positionAt(map, -5).offset, 0);
  const last = positionAt(map, 999);
  assert.equal(last.offset, 3); // 落在最后一个节点的末尾
});

test('rangeFromOffsets 能跨节点生成 Range', () => {
  const { p } = makeParagraph();
  const map = buildTextMap(p);
  const range = rangeFromOffsets(map, 2, 7);
  assert.equal(range.startContainer.data, 'abc');
  assert.equal(range.startOffset, 2);
  assert.equal(range.endContainer.data, 'ghi');
  assert.equal(range.endOffset, 1);
});

test('rangeFromOffsets 对空节点返回 null 而不是抛错', () => {
  const empty = new FakeElement([]);
  const map = buildTextMap(empty);
  assert.equal(map.nodes.length, 0);
  assert.equal(rangeFromOffsets(map, 0, 1), null);
});

test('wordRangeAt 能找到词边界，并跳过标点', () => {
  const text = 'Hello, world! 中文词。';
  const map = { nodes: [], text };
  assert.deepEqual(wordRangeAt(map, 1), { start: 0, end: 5 }); // Hello
  assert.deepEqual(wordRangeAt(map, 7), { start: 7, end: 12 }); // world
  // 落在逗号上时应跳到下一个词
  const comma = wordRangeAt(map, 5);
  assert.deepEqual(comma, { start: 7, end: 12 });
});

test('wordRangeAt 对中文连续字按整段处理', () => {
  const text = '中文词。';
  const map = { nodes: [], text };
  assert.deepEqual(wordRangeAt(map, 1), { start: 0, end: 3 });
});

test('buildWhitespaceIndex 把连续空白折叠成一个空格', () => {
  const { collapsed, collapsedToRaw } = buildWhitespaceIndex('a  \n\t b');
  assert.equal(collapsed, 'a b');
  // 折叠后的空格映射到「这段空白的第一个字符」的原始下标，这是刻意的：
  // 映射到空白中间会让高亮起点偏进空白里。
  assert.deepEqual(collapsedToRaw, [0, 1, 6]);
  // 每个映射都必须落在它对应的折叠字符上
  for (let k = 0; k < collapsed.length; k += 1) {
    const raw = 'a  \n\t b'[collapsedToRaw[k]];
    if (collapsed[k] === ' ') assert.ok(/\s/.test(raw), `下标 ${k} 应映射到空白，实际 ${JSON.stringify(raw)}`);
    else assert.equal(raw, collapsed[k], `下标 ${k} 映射错误`);
  }
});

test('buildWhitespaceIndex 折叠全角空格并去掉尾部空格', () => {
  const { collapsed } = buildWhitespaceIndex('中\u3000文  ');
  assert.equal(collapsed, '中 文');
});

test('collapsedIndexToRaw 能把引擎报的下标换算回原始下标', () => {
  // 原始文本里 a 和 b 之间有 4 个空白字符，折叠后只剩 1 个
  const raw = 'a    bc';
  const { collapsed, collapsedToRaw } = buildWhitespaceIndex(raw);
  assert.equal(collapsed, 'a bc');
  // 折叠文本下标 1（空格）→ 原始下标 1
  assert.equal(collapsedIndexToRaw(collapsedToRaw, 1), 1);
  // 折叠文本下标 2（b）→ 原始下标 5
  assert.equal(collapsedIndexToRaw(collapsedToRaw, 2), 5);
  assert.equal(raw[collapsedIndexToRaw(collapsedToRaw, 2)], 'b');
  // 越界返回 -1，调用方据此忽略该事件
  assert.equal(collapsedIndexToRaw(collapsedToRaw, 99), -1);
  assert.equal(collapsedIndexToRaw(collapsedToRaw, -1), -1);
});

/* ============================ speech.ts 归一化 ============================ */

test('normalizeForSpeech 折叠连续空白并去掉首尾空白', () => {
  const m = normalizeForSpeech('  你好  \n\t 世界  ');
  assert.equal(m.text, '你好 世界');
  // 每个保留字符都能通过映射找回原始位置
  for (let k = 0; k < m.text.length; k += 1) {
    const raw = '  你好  \n\t 世界  '[m.normalizedToRaw[k]];
    if (m.text[k] === ' ') assert.ok(/\s/.test(raw));
    else assert.equal(raw, m.text[k]);
  }
});

test('normalizeForSpeech 与 buildWhitespaceIndex 的折叠结果一致', () => {
  // 两个模块必须用同一套空白规则，否则 onboundary 换算会漂移
  const samples = [
    'a  \n\t b',
    '  前后都有空白  ',
    '中文\u3000全角空格',
    '',
    '    ',
    '多   个   词',
  ];
  for (const s of samples) {
    assert.equal(
      normalizeForSpeech(s).text,
      buildWhitespaceIndex(s).collapsed,
      `折叠结果不一致: ${JSON.stringify(s)}`,
    );
  }
});

test('normalizedToRawIndex 精确换算并可识别越界', () => {
  const raw = '你   好';
  const m = normalizeForSpeech(raw);
  assert.equal(m.text, '你 好');
  assert.equal(normalizedToRawIndex(m, 0), 0);
  assert.equal(normalizedToRawIndex(m, 2), 4);
  assert.equal(raw[normalizedToRawIndex(m, 2)], '好');
  assert.equal(normalizedToRawIndex(m, 99), -1);
});

test('estimateDurationMs 随语速反比、随长度正比', () => {
  const a = estimateDurationMs('这是十个字的一段中文内容', 1);
  const fast = estimateDurationMs('这是十个字的一段中文内容', 2);
  const longer = estimateDurationMs('这是十个字的一段中文内容这是十个字的一段中文内容', 1);
  assert.ok(a > fast, '语速快应更短');
  assert.ok(longer > a, '文本长应更久');
});

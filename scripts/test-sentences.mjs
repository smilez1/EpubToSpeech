/**
 * 句子抽取与高亮定位的单元测试。
 *
 * 验证的核心不变量（高亮准不准全靠它们）：
 *  - sentences 的区间拼起来必须严格等于整章文本
 *  - 句子区间切出的文本必须与 sentence.text 一致
 *  - 每个文本节点登记的 start/length 必须与整章文本对应位置一致
 *  - 点击位置 → 下标 → 句子，来回换算必须自洽
 *
 * 用法：node --test --test-force-exit scripts/test-sentences.mjs
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTsModule } from './lib/load-ts.mjs';
import { installDom, p, el, t, FakeElement, FakeText } from './lib/dom-stub.mjs';

const restoreDom = installDom();
const { extractChapterSentences, chapterRange, offsetFromDomPosition, sentenceIndexAt, nodePositionAt } =
  await loadTsModule('src/web/reader/sentences.ts');

/** 一个较长句子，避免被短句合并逻辑影响。 */
const S1 = '这是第一句话，长度足够不会被合并掉。';
const S2 = '这是第二句话，同样写得足够长一些。';
const S3 = '这是第三句话，也写长一点以保持一致。';

/** 构造一章：两个段落，第一段里嵌一个 <em>。 */
function makeChapter() {
  const em = el('em', {}, [t('长度足够不会被合并掉。')]);
  const p1 = p(t('这是第一句话，'), em);
  const p2 = p(t(S2), t(S3));
  const body = el('body', {}, [p1, p2]);
  return { body, p1, p2, em };
}

/* ------------------------------ 抽取基本性质 ------------------------------ */

test('抽取出的句子区间严格覆盖整章文本，无重叠无缺口', () => {
  const { body } = makeChapter();
  const chapter = extractChapterSentences(body);

  assert.ok(chapter.sentences.length >= 2, `至少两句，实际 ${chapter.sentences.length}`);

  // 区间递增且不重叠
  let prevEnd = 0;
  const pieces = [];
  for (const s of chapter.sentences) {
    assert.ok(s.start >= prevEnd, `区间重叠: ${JSON.stringify(s)}`);
    pieces.push(chapter.text.slice(prevEnd, s.start)); // 句间空隙（应为空格）
    pieces.push(chapter.text.slice(s.start, s.end));
    prevEnd = s.end;
  }
  pieces.push(chapter.text.slice(prevEnd));

  assert.equal(pieces.join(''), chapter.text, '按区间还原必须等于整章文本');
  assert.equal(chapter.totalLength, chapter.text.length);
});

test('sentence.text 与按区间切出的文本一致', () => {
  const { body } = makeChapter();
  const chapter = extractChapterSentences(body);
  for (const s of chapter.sentences) {
    assert.equal(chapter.text.slice(s.start, s.end), s.text, `句子文本不一致: ${JSON.stringify(s)}`);
  }
});

test('句间空隙只有连接空格（不会把两段粘成一句）', () => {
  const { body } = makeChapter();
  const chapter = extractChapterSentences(body);
  for (let i = 1; i < chapter.sentences.length; i += 1) {
    const gap = chapter.text.slice(chapter.sentences[i - 1].end, chapter.sentences[i].start);
    assert.equal(gap, ' ', `句间应有且仅有一个连接空格，实际 ${JSON.stringify(gap)}`);
  }
});

test('每个文本节点登记的区间与整章文本一致', () => {
  const { body } = makeChapter();
  const chapter = extractChapterSentences(body);

  assert.ok(chapter.nodes.length >= 4, `应登记多个文本节点，实际 ${chapter.nodes.length}`);
  for (const entry of chapter.nodes) {
    assert.equal(
      chapter.text.slice(entry.start, entry.start + entry.length),
      entry.node.data,
      `节点区间与文本不符: ${JSON.stringify(entry.node.data)} @${entry.start}`,
    );
  }
  // 节点按 start 递增
  for (let i = 1; i < chapter.nodes.length; i += 1) {
    assert.ok(chapter.nodes[i].start > chapter.nodes[i - 1].start, '节点表应按下标递增');
  }
});

test('嵌套的行内标签不会被重复计入', () => {
  const { body } = makeChapter();
  const chapter = extractChapterSentences(body);
  // <em> 内的文字只应出现一次
  const needle = '长度足够不会被合并掉。';
  const first = chapter.text.indexOf(needle);
  assert.notEqual(first, -1);
  assert.equal(chapter.text.indexOf(needle, first + 1), -1, '嵌套行内文本被重复计入');
});

test('嵌套的块级元素按叶子块分别抽取（不重复也不遗漏）', () => {
  const p1 = p(t(S1));
  const p2 = p(t(S2));
  const section = el('section', {}, [p1, p2]);
  const body = el('body', {}, [section]);
  const chapter = extractChapterSentences(body);

  assert.equal(chapter.sentences.length, 2);
  assert.equal(chapter.sentences[0].text, S1);
  assert.equal(chapter.sentences[1].text, S2);
  // section 自身不该被当成叶子块再抽一遍
  assert.equal(chapter.text.indexOf(S1, 1), -1, '内容出现多次，说明父块也被抽取了');
});

test('跳过 script / style / nav 等非正文元素', () => {
  const body = el('body', {}, [
    el('nav', {}, [p(t('目录条目一，这句不该被读出来。'))]),
    p(t(S1)),
    el('script', {}, [t('var x = 1;')]),
    el('style', {}, [t('.a{color:red}')]),
  ]);
  const chapter = extractChapterSentences(body);
  assert.equal(chapter.sentences.length, 1);
  assert.equal(chapter.sentences[0].text, S1);
  assert.ok(!chapter.text.includes('目录条目'));
  assert.ok(!chapter.text.includes('var x'));
});

test('跳过 hidden 与 contenteditable=false 的装饰内容', () => {
  const body = el('body', {}, [
    p(t(S1)),
    el('p', { hidden: '' }, [t('这段被隐藏了，不该读。')]),
    el('span', { contenteditable: 'false' }, [t('注脚标记不该被读。')]),
  ]);
  const chapter = extractChapterSentences(body);
  assert.equal(chapter.sentences.length, 1);
  assert.equal(chapter.sentences[0].text, S1);
});

test('空白段落被忽略，不产生空句子', () => {
  const body = el('body', {}, [p(t(S1)), p(t('   ')), p(t('')), p(t(S2))]);
  const chapter = extractChapterSentences(body);
  assert.equal(chapter.sentences.length, 2);
  for (const s of chapter.sentences) assert.ok(s.text.trim().length > 0, '不应有空句子');
});

test('段落区间与句子下标互相自洽', () => {
  const { body } = makeChapter();
  const chapter = extractChapterSentences(body);
  assert.ok(chapter.paragraphs.length >= 2);

  for (const para of chapter.paragraphs) {
    assert.ok(para.sentenceStart < para.sentenceEnd, '段落应至少含一句');
    const first = chapter.sentences[para.sentenceStart];
    const last = chapter.sentences[para.sentenceEnd - 1];
    assert.equal(para.start, first.start, '段落起点应等于首句起点');
    assert.equal(para.end, last.end, '段落终点应等于末句终点');
  }
});

test('空文档返回空结果而不是抛错', () => {
  const chapter = extractChapterSentences(el('body', {}, []));
  assert.equal(chapter.sentences.length, 0);
  assert.equal(chapter.text, '');
  assert.equal(chapter.totalLength, 0);
  assert.equal(chapterRange(chapter, 0, 1), null);
});

/* ------------------------------ 下标 ↔ DOM ------------------------------ */

test('nodePositionAt 能按下标定位到节点与节点内偏移', () => {
  const { body } = makeChapter();
  const chapter = extractChapterSentences(body);
  const first = chapter.nodes[0];

  const at0 = nodePositionAt(chapter.nodes, first.start);
  assert.equal(at0.node, first.node);
  assert.equal(at0.offset, 0);

  const at2 = nodePositionAt(chapter.nodes, first.start + 2);
  assert.equal(at2.node, first.node);
  assert.equal(at2.offset, 2);
});

test('chapterRange 能跨段落生成 Range', () => {
  const { body } = makeChapter();
  const chapter = extractChapterSentences(body);
  const first = chapter.sentences[0];
  const last = chapter.sentences[chapter.sentences.length - 1];

  const range = chapterRange(chapter, first.start, last.end);
  assert.ok(range, '应能生成跨段 Range');
  assert.equal(range.startContainer, chapter.nodes[0].node);
  // 结束位置应落在最后一个句子的末尾节点上
  const endPos = nodePositionAt(chapter.nodes, last.end);
  assert.equal(range.endContainer, endPos.node);
});

test('chapterRange：部分越界被夹到内容范围，完全在内容外返回 null', () => {
  const { body } = makeChapter();
  const chapter = extractChapterSentences(body);
  const diag = () => `nodes=${chapter.nodes?.length} total=${chapter.totalLength}`;

  // 部分越界 → 夹住并成功返回
  const over = chapterRange(chapter, 0, chapter.totalLength + 999);
  assert.ok(over, `末端越界应夹到末尾而不是失败 [${diag()}]`);
  const lastNode = chapter.nodes[chapter.nodes.length - 1];
  assert.ok(lastNode, `节点表不应为空 [${diag()}]`);
  assert.equal(over.endContainer, lastNode.node, `结束容器应为最后一个节点 [${diag()}]`);
  assert.equal(over.endOffset, lastNode.length, `结束偏移应为节点长度 [${diag()}]`);

  const under = chapterRange(chapter, -999, 5);
  assert.ok(under, `起点越界应夹到 0 [${diag()}]`);
  assert.equal(under.startContainer, chapter.nodes[0].node, `起始容器应为第一个节点 [${diag()}]`);
  assert.equal(under.startOffset, 0);

  // 完全在内容之外 → null
  assert.equal(chapterRange(chapter, chapter.totalLength + 1, chapter.totalLength + 9), null);
  assert.equal(chapterRange(chapter, -50, -1), null);

  // 空文档 → null
  const emptyChapter = extractChapterSentences(el('body', {}, []));
  assert.ok(emptyChapter, 'extractChapterSentences 应返回对象而不是 undefined');
  assert.equal(
    typeof emptyChapter,
    'object',
    `空文档应返回对象，实际 ${typeof emptyChapter} / ${String(emptyChapter)}`,
  );
  assert.equal(chapterRange(emptyChapter, 0, 1), null, '空章节应返回 null');
});

test('offsetFromDomPosition 能把点击位置换算成朗读文本下标', () => {
  const { body } = makeChapter();
  const chapter = extractChapterSentences(body);
  const target = chapter.nodes[1];

  const offset = offsetFromDomPosition(chapter, target.node, 3);
  assert.equal(offset, target.start + 3);
  assert.equal(chapter.text.slice(offset, offset + 1), target.node.data[3]);
});

test('offsetFromDomPosition 对元素节点取其后代起点，对无关节点返回 -1', () => {
  const { body, em } = makeChapter();
  const chapter = extractChapterSentences(body);

  const viaElement = offsetFromDomPosition(chapter, em, 0);
  assert.ok(viaElement >= 0, '点中行内元素应能定位到其后代文本起点');

  const stranger = new FakeText('无关节点');
  assert.equal(offsetFromDomPosition(chapter, stranger, 0), -1);
});

test('sentenceIndexAt：点击句首、句中、句尾都归到该句', () => {
  const { body } = makeChapter();
  const chapter = extractChapterSentences(body);
  assert.ok(chapter.sentences.length >= 3, `本用例需要至少 3 句，实际 ${chapter.sentences.length}`);

  for (let i = 0; i < chapter.sentences.length; i += 1) {
    const s = chapter.sentences[i];
    assert.equal(sentenceIndexAt(chapter, s.start), i, `句首应归到第 ${i} 句`);
    assert.equal(sentenceIndexAt(chapter, s.start + 1), i, `句中应归到第 ${i} 句`);
    assert.equal(sentenceIndexAt(chapter, s.end - 1), i, `句尾前一位应归到第 ${i} 句`);
  }
});

test('sentenceIndexAt：落在句间空格上归到前一句（往前读更自然）', () => {
  const { body } = makeChapter();
  const chapter = extractChapterSentences(body);
  const gapStart = chapter.sentences[0].end;
  assert.equal(chapter.text[gapStart], ' ', '前置条件：句间应为空格');
  assert.equal(sentenceIndexAt(chapter, gapStart), 0, '空隙应归到前一句');
});

test('sentenceIndexAt：越界被夹到首句/末句', () => {
  const { body } = makeChapter();
  const chapter = extractChapterSentences(body);
  assert.equal(sentenceIndexAt(chapter, -100), 0);
  assert.equal(sentenceIndexAt(chapter, chapter.totalLength + 100), chapter.sentences.length - 1);
});

/* --------------------------- 端到端：区间一致性 --------------------------- */

test('每一句都能用 chapterRange 精确还原出对应文本', () => {
  const { body } = makeChapter();
  const chapter = extractChapterSentences(body);

  // 用节点表把 Range 覆盖的文本重新拼出来，与 sentence.text 比对
  const textOfRange = (range) => {
    const out = [];
    for (const entry of chapter.nodes) {
      const nodeStart = entry.start;
      const nodeEnd = entry.start + entry.length;
      // 计算该节点落在 range 内的部分
      const rangeStart = offsetFromDomPosition(chapter, range.startContainer, range.startOffset);
      const rangeEnd = offsetFromDomPosition(chapter, range.endContainer, range.endOffset);
      const from = Math.max(nodeStart, rangeStart);
      const to = Math.min(nodeEnd, rangeEnd);
      if (to > from) out.push(entry.node.data.slice(from - nodeStart, to - nodeStart));
    }
    return out.join('');
  };

  for (const s of chapter.sentences) {
    const range = chapterRange(chapter, s.start, s.end);
    assert.ok(range, `第 ${s.start} 句应能生成 Range`);
    assert.equal(textOfRange(range), s.text, `Range 覆盖文本与句子不符: ${JSON.stringify(s.text)}`);
  }
});

test('清理全局 DOM 桩后不影响其它测试文件', () => {
  // 这个用例只是显式确认 restore 可用；实际由进程退出回收
  assert.equal(typeof restoreDom, 'function');
  void FakeElement;
});

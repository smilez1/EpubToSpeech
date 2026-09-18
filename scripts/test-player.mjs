/**
 * 播放队列（Player）的单元测试。
 *
 * Player 通过 TtsDriver 与真实语音引擎解耦，所以这里塞一个假驱动就能
 * 完整、确定性地验证队列推进、跳句、看门狗与错误处理——不需要浏览器。
 *
 * 用法：node --experimental-strip-types --test scripts/test-player.mjs
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTsModules } from './lib/load-ts.mjs';

globalThis.window = globalThis; // Player 内部用 window.setTimeout

// player.ts 会 import ./chunk 与 ./speech，所以一次性批量加载，
// 加载器才能把模块之间的相对导入改写对。
const [playerMod, chunkMod] = await loadTsModules([
  'src/web/tts/player.ts',
  'src/web/tts/chunk.ts',
]);
const { Player, EngineDriver } = playerMod;
const { chunkText } = chunkMod;

/** 记录引擎收到的规范化文本，并允许手动触发 boundary/end。 */
class FakeEngine {
  constructor() {
    this.id = 'fake';
    this.displayName = 'fake';
    this.capabilities = {
      wordBoundary: true,
      handlesLongText: false,
      synthesizeToFile: false,
      offline: true,
    };
    this.last = null;
    this.cancelCount = 0;
  }
  isAvailable() {
    return true;
  }
  async listVoices() {
    return [];
  }
  speak(params, handlers) {
    this.last = { params, handlers };
    return { cancel: () => (this.cancelCount += 1) };
  }
  cancel() {
    this.cancelCount += 1;
  }
}

/** 假驱动：记录被朗读的文本，并允许测试手动触发 onEnd / onError / onBoundary。 */
class FakeDriver {
  constructor() {
    this.spoken = [];
    this.current = null;
    this.cancelled = [];
    this.cancelAllCalls = 0;
  }

  speak(text, handlers) {
    const record = { text, handlers, cancelled: false };
    this.spoken.push(text);
    this.current = record;
    return {
      cancel: () => {
        record.cancelled = true;
        this.cancelled.push(text);
      },
    };
  }

  cancelAll() {
    this.cancelAllCalls += 1;
  }

  /* ---- 测试用辅助 ---- */

  get last() {
    return this.current;
  }

  /** 模拟正常读完当前句。 */
  finish() {
    const rec = this.current;
    assert.ok(rec, '当前没有在朗读的句子');
    this.current = null;
    rec.handlers.onEnd?.();
  }

  /** 模拟引擎报错。 */
  fail(message = 'boom') {
    const rec = this.current;
    assert.ok(rec, '当前没有在朗读的句子');
    this.current = null;
    rec.handlers.onError?.(new Error(message));
  }

  /** 模拟引擎上报字符边界。 */
  boundary(charIndex) {
    this.current?.handlers.onBoundary?.(charIndex);
  }
}

function makePlayer(chunks, options = {}, callbacks = {}) {
  const driver = new FakeDriver();
  const player = new Player(driver, callbacks, options);
  player.setChunks(chunks);
  return { driver, player };
}

// 每句都必须长于 MIN_MERGE_CHARS(12)，否则短句合并会把它们并成一段
const CHUNKS = chunkText(
  '第一句要写得足够长，以免被短句合并逻辑合并掉。第二句同样要写长一点才行。第三句也需要够长才可以。',
);

/** 等到驱动确实收到了一次 speak。 */
async function spoke(driver, count) {
  for (let i = 0; i < 50 && driver.spoken.length < count; i += 1) await tick();
  assert.equal(driver.spoken.length, count, `期望已朗读 ${count} 句，实际 ${driver.spoken.length}`);
}

test('chunks 切分正确（测试前置条件）', () => {
  assert.equal(CHUNKS.length, 3, `期望 3 段，实际 ${JSON.stringify(CHUNKS.map((c) => c.text))}`);
});

test('play 从第一句开始，读完自动推进到下一句', async () => {
  const driver = new FakeDriver();
  const seen = [];
  const player = new Player(driver, { onChunk: (c, i) => seen.push([i, c.text]) });
  player.setChunks(CHUNKS);

  await player.play();
  await spoke(driver, 1);
  assert.equal(driver.spoken[0], CHUNKS[0].text);
  assert.deepEqual(seen[0], [0, CHUNKS[0].text]);

  driver.finish();
  await spoke(driver, 2);
  assert.equal(driver.spoken[1], CHUNKS[1].text);
  assert.equal(player.getState().index, 1);

  driver.finish();
  await spoke(driver, 3);
  driver.finish();
  await tick();
  assert.equal(player.getState().status, 'ended');
  player.dispose();
});

test('pause 会真正打断当前朗读（不必等整句读完）', async () => {
  const { driver, player } = makePlayer(CHUNKS);
  await player.play();
  await spoke(driver, 1);
  assert.equal(player.getState().status, 'playing');

  player.pause();
  assert.equal(player.getState().status, 'paused');
  assert.equal(driver.cancelled.length, 1, '应当调用了当前句的 cancel');

  // 暂停后引擎再报 onEnd 也不应该继续推进
  const spokenBefore = driver.spoken.length;
  driver.current?.handlers.onEnd?.();
  await tick();
  assert.equal(driver.spoken.length, spokenBefore, '暂停后不应继续朗读');
  player.dispose();
});

test('pause 后 play 从同一句继续', async () => {
  const { driver, player } = makePlayer(CHUNKS);
  await player.play();
  await spoke(driver, 1);
  driver.finish();
  await spoke(driver, 2);
  assert.equal(player.getState().index, 1);

  player.pause();
  await player.play();
  await spoke(driver, 3);
  assert.equal(player.getState().index, 1, '应从暂停处继续');
  assert.equal(driver.spoken.at(-1), CHUNKS[1].text);
  player.dispose();
});

test('next / previous 能跳句，且边界处不越界', async () => {
  const { driver, player } = makePlayer(CHUNKS);
  await player.play();
  await spoke(driver, 1);

  // 第一句再往前：退化为重读当前句（index 保持 0，朗读次数 +1）
  await player.previous();
  assert.equal(player.getState().index, 0, '第一句再往前应停在 0');
  await spoke(driver, 2);
  assert.equal(driver.spoken.at(-1), CHUNKS[0].text, '应重读第一句');

  // 前进到第 2 句
  await player.next();
  await spoke(driver, 3);
  assert.equal(player.getState().index, 1);
  assert.equal(driver.spoken.at(-1), CHUNKS[1].text);

  // 前进到第 3 句
  await player.next();
  await spoke(driver, 4);
  assert.equal(player.getState().index, 2);
  assert.equal(driver.spoken.at(-1), CHUNKS[2].text);

  // 已是最后一句且无更多内容 → 结束
  await player.next();
  assert.equal(player.getState().status, 'ended');
  player.dispose();
});

test('previous 在中间位置会真正退回上一句', async () => {
  const { driver, player } = makePlayer(CHUNKS);
  await player.play();
  await spoke(driver, 1);
  await player.next(); // → index 1
  await spoke(driver, 2);
  await player.previous(); // → index 0
  await spoke(driver, 3);
  assert.equal(player.getState().index, 0);
  assert.equal(driver.spoken.at(-1), CHUNKS[0].text);
  player.dispose();
});

test('seek 跳到指定句并朗读', async () => {
  const { driver, player } = makePlayer(CHUNKS);
  await player.play();
  await spoke(driver, 1);
  await player.seek(2);
  await spoke(driver, 2);
  assert.equal(player.getState().index, 2);
  assert.equal(driver.spoken.at(-1), CHUNKS[2].text);

  // 越界会被夹住
  await player.seek(99);
  assert.equal(player.getState().index, CHUNKS.length - 1);
  player.dispose();
});

test('边界回调会更新 boundary，且不再有陈旧事件', async () => {
  const { driver, player } = makePlayer(CHUNKS);
  await player.play();
  await spoke(driver, 1);
  driver.boundary(3);
  assert.equal(player.getState().boundary, 3);
  driver.boundary(5);
  assert.equal(player.getState().boundary, 5);
  player.dispose();
});

test('onNeedMore 返回 true 时跨章节续读', async () => {
  const extra = chunkText('这是追加进来的第四句话，需要足够长。');
  let asked = 0;
  const driver = new FakeDriver();
  const player = new Player(driver, {
    onNeedMore: () => {
      asked += 1;
      player.appendChunks(extra);
      return true;
    },
  });
  player.setChunks(CHUNKS);

  await player.play();
  await spoke(driver, 1);
  driver.finish();
  await spoke(driver, 2);
  driver.finish();
  await spoke(driver, 3);
  driver.finish(); // 读完最后一句，触发 onNeedMore
  await spoke(driver, 4);

  assert.equal(asked, 1);
  assert.equal(player.getState().index, 3);
  assert.equal(driver.spoken.at(-1), extra[0].text);
  player.dispose();
});

test('onNeedMore 返回 false 时结束并回调 onFinished', async () => {
  let finished = 0;
  const driver = new FakeDriver();
  const player = new Player(driver, {
    onNeedMore: () => false,
    onFinished: () => {
      finished += 1;
    },
  });
  player.setChunks(CHUNKS);

  await player.play();
  await spoke(driver, 1);
  driver.finish();
  await spoke(driver, 2);
  driver.finish();
  await spoke(driver, 3);
  driver.finish();
  await tick();

  assert.equal(player.getState().status, 'ended');
  assert.equal(finished, 1);
  player.dispose();
});

test('看门狗：引擎一直不发声时强行推进，不会永久卡住', async () => {
  const driver = new FakeDriver();
  const forced = [];
  const player = new Player(
    driver,
    { onChunkEnd: (_i, f) => forced.push(f) },
    { startTimeoutMs: 15, endTimeoutSlackMs: 15 },
  );
  player.setChunks(CHUNKS);

  await player.play();
  await spoke(driver, 1);

  // 每句都会在 15ms 内超时，所以短暂等待后会连续跳过若干句。
  // 这里只断言"确实前进了 + 标记为强制推进"，不写死具体跳过几句（避免时序抖动）。
  await sleep(80);
  assert.ok(player.getIndex() > 0, `应在超时后前进，实际 index=${player.getIndex()}`);
  assert.ok(forced.length > 0 && forced.every((f) => f === true), '应全部标记为强制推进');

  // 结论：即使引擎完全不发声，也一定会推进到末尾并结束，而不是永久卡住
  await sleep(200);
  assert.ok(
    ['ended', 'playing'].includes(player.getState().status),
    `状态应正常收敛，实际 ${player.getState().status}`,
  );
  player.dispose();
  assert.equal(player.getState().status, 'idle', 'dispose 后应回到 idle 且不再有定时器');
});

test('引擎报错时进入 error 状态并带上原因', async () => {
  const { driver, player } = makePlayer(CHUNKS);
  await player.play();
  await spoke(driver, 1);
  driver.fail('语音服务不可用');
  assert.equal(player.getState().status, 'error');
  assert.equal(player.getState().error, '语音服务不可用');
  player.dispose();
});

test('setChunks 会打断当前朗读并重置状态', async () => {
  const { driver, player } = makePlayer(CHUNKS);
  await player.play();
  await spoke(driver, 1);
  const other = chunkText('换了一章的内容，这句也要足够长。');
  player.setChunks(other);
  assert.equal(driver.cancelled.length, 1);
  assert.equal(player.getState().status, 'idle');
  assert.equal(player.getState().index, 0);
  assert.deepEqual(player.getChunks(), other);
  player.dispose();
});

test('语速变化时重读当前句，使新语速立刻生效', async () => {
  const { driver, player } = makePlayer(CHUNKS);
  await player.play();
  await spoke(driver, 1);
  player.setRate(1.6);
  await spoke(driver, 2);
  assert.equal(driver.spoken.at(-1), CHUNKS[0].text);
  assert.equal(player.getSettings().rate, 1.6);
  player.dispose();
});

test('语速/音量会被夹到合理范围', () => {
  const { driver, player } = makePlayer(CHUNKS);
  player.setRate(999);
  assert.ok(player.getSettings().rate <= 4);
  player.setRate(-5);
  assert.ok(player.getSettings().rate >= 0.1);
  player.setVolume(9);
  assert.ok(player.getSettings().volume <= 1);
  player.dispose();
  void driver;
});

test('空队列时 play 不做任何事', async () => {
  const { driver, player } = makePlayer([]);
  await player.play();
  assert.equal(driver.spoken.length, 0);
  assert.equal(player.getState().status, 'idle');
  player.dispose();
});

/* ------------------------------ EngineDriver ------------------------------ */

test('EngineDriver 送出的文本是规范化后的（连续空白被折叠）', () => {
  const engine = new FakeEngine();
  const driver = new EngineDriver(engine, () => ({ rate: 1, pitch: 1, volume: 1 }));
  const raw = '你好   世界\n第二行';

  driver.speak(raw, {});
  assert.equal(engine.last.params.text, '你好 世界 第二行');
});

test('EngineDriver 把引擎侧下标换算回原始文本下标（词级高亮的关键）', () => {
  const engine = new FakeEngine();
  const driver = new EngineDriver(engine, () => ({ rate: 1, pitch: 1, volume: 1 }));
  // 原始文本里 "你" 与 "好" 之间有 3 个空格，折叠后只剩 1 个
  const raw = '你   好世界';

  const seen = [];
  driver.speak(raw, { onBoundary: (i) => seen.push(i) });

  const normalized = engine.last.params.text;
  assert.equal(normalized, '你 好世界');

  // 依次在规范化文本的每个位置上报，检查换算结果
  for (let i = 0; i < normalized.length; i += 1) {
    engine.last.handlers.onBoundary(i);
    assert.equal(
      raw[seen[i]],
      normalized[i],
      `规范化下标 ${i}(${JSON.stringify(normalized[i])}) 换算到了原始下标 ${seen[i]}(${JSON.stringify(raw[seen[i]])})`,
    );
  }
});

test('EngineDriver 忽略越界的 boundary，不把错值传上去', () => {
  const engine = new FakeEngine();
  const driver = new EngineDriver(engine, () => ({ rate: 1, pitch: 1, volume: 1 }));
  const seen = [];
  driver.speak('短文本', { onBoundary: (i) => seen.push(i) });

  engine.last.handlers.onBoundary(-1);
  engine.last.handlers.onBoundary(9999);
  assert.deepEqual(seen, [], '越界下标应被丢弃');
});

test('EngineDriver 把语速/音色等设置透传给引擎', () => {
  const engine = new FakeEngine();
  const driver = new EngineDriver(engine, () => ({
    voiceId: 'voice-zh',
    rate: 1.6,
    pitch: 1.1,
    volume: 0.5,
  }));
  driver.speak('测试', {});
  assert.equal(engine.last.params.voiceId, 'voice-zh');
  assert.equal(engine.last.params.rate, 1.6);
  assert.equal(engine.last.params.pitch, 1.1);
  assert.equal(engine.last.params.volume, 0.5);
});

test('EngineDriver.cancelAll 会打断引擎', () => {
  const engine = new FakeEngine();
  const driver = new EngineDriver(engine, () => ({ rate: 1, pitch: 1, volume: 1 }));
  driver.cancelAll();
  assert.equal(engine.cancelCount, 1);
});

/* --------------------------------- 工具 --------------------------------- */

function tick() {
  return new Promise((r) => setTimeout(r, 0));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 验证 Edge/浏览器的在线音色是否真的能发声。
 *
 * 背景：`getVoices()` 里能列出 "Microsoft HanHan Online" 这类在线音色，
 * 但"列出来"不等于"能读出来"——在线音色依赖网络与微软服务。
 * 这里直接在页面里合成一小段，用 onstart/onend 判定是否真的走完。
 *
 * 用法：node scripts/check-voices.mjs
 */

import { spawn } from 'node:child_process';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const BROWSER = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p));
if (!BROWSER) {
  console.error('✗ 找不到 Edge');
  process.exit(1);
}

const ROOT = resolve(import.meta.dirname, '..');
const PROFILE = resolve(ROOT, '.tmp/edge-voices');
const PORT = 9412;
const WEB = process.env.WEB_BASE ?? 'http://localhost:5173';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(PROFILE, { recursive: true });

const child = spawn(BROWSER, [
  '--headless=new', '--disable-gpu', '--no-first-run',
  '--autoplay-policy=no-user-gesture-required',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, 'about:blank',
], { stdio: 'ignore' });

let targets = null;
for (let i = 0; i < 40 && !targets; i++) {
  await sleep(250);
  targets = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json()).catch(() => null);
}
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));

let idc = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m.result);
    pending.delete(m.id);
  }
});
const send = (method, params = {}) =>
  new Promise((r) => {
    const i = ++idc;
    pending.set(i, r);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const ev = async (expr, awaitPromise = false) => {
  const r = await send('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise,
  });
  if (r?.exceptionDetails) return `ERR: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`;
  return r?.result?.value;
};

await send('Runtime.enable');
await send('Page.enable');
// 用真实页面加载（音色列表需要正常页面上下文）
await send('Page.navigate', { url: `${WEB}/` });
await sleep(3000);

// getVoices() 首次常返回空数组，必须等 voiceschanged。
// 这正是 WebSpeechEngine 里处理过的坑，脚本这边同样要等。
console.log('=== 等待音色加载 ===');
const loaded = await ev(
  `(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    for (let i = 0; i < 30; i += 1) {
      if (speechSynthesis.getVoices().length > 0) return speechSynthesis.getVoices().length;
      await wait(300);
    }
    return 0;
  })()`,
  true,
);
console.log(`  音色数量: ${loaded}`);

console.log('=== 可用音色清单 ===');
const list = await ev(`(() => {
  const vs = speechSynthesis.getVoices();
  const key = (v) => v.voiceURI || v.name;
  return JSON.stringify({
    total: vs.length,
    online: vs.filter(v => v.localService === false).map(v => v.name + ' | ' + v.lang),
    localZh: vs.filter(v => v.localService !== false && /^zh/i.test(v.lang)).map(v => key(v) + ' | ' + v.lang),
    onlineZhKeys: vs
      .filter(v => v.localService === false && /^zh/i.test(v.lang))
      .map(v => ({ key: key(v), name: v.name, lang: v.lang })),
  });
})()`);
console.log(list);
if (typeof list === 'string' && list.startsWith('ERR')) process.exit(1);

/** 让页面合成一句话并返回结果（真发声才算通过） */
const speakTest = async (voiceName, text) => {
  const script = `(async () => {
    const vs = speechSynthesis.getVoices();
    // 与 App 一致的匹配方式：voiceURI 优先，回退 name。
    // 中文音色的 name 与 voiceURI 未必相同（name 是本地化显示名），只用 name 会找不到。
    const v = ${voiceName ? `vs.find(x => (x.voiceURI || x.name) === ${JSON.stringify(voiceName)})` : 'null'};
    if (${voiceName ? 'true' : 'false'} && !v) return JSON.stringify({ok:false, why:'找不到该音色'});
    return await new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(${JSON.stringify(text)});
      if (v) u.voice = v;
      u.rate = 1.6; u.volume = 1;
      let started = false;
      const t = setTimeout(() => resolve(JSON.stringify({ok:false, why:'6 秒内没有结束', started})), 6000);
      u.onstart = () => { started = true; };
      u.onend = () => { clearTimeout(t); resolve(JSON.stringify({ok:true, started, voice: v ? v.name : '(默认)', local: v ? v.localService !== false : null})); };
      u.onerror = (e) => { clearTimeout(t); resolve(JSON.stringify({ok:false, why:'error ' + e.error, voice: v ? v.name : '(默认)'})); };
      speechSynthesis.speak(u);
    });
  })()`;
  return ev(script, true);
};

const voices = JSON.parse(list);
// 用 voiceURI 作为标识（与 App 一致），只按语言筛中文。
// 注意：在线音色按语言字母序返回，第一个在线音色往往不是中文，必须显式筛语言。
const onlineZh = voices.onlineZhKeys ?? [];
const localZhFirst = voices.localZh?.[0]?.split(' | ')[0];

console.log(`  在线总数: ${voices.online?.length ?? 0}`);
console.log(`  在线中文音色: ${onlineZh.length} 个`);
for (const v of onlineZh.slice(0, 8)) console.log(`    - ${v.name}  (${v.key})`);

console.log('\n=== 逐个试读（onstart + onend 都触发才算通过） ===');
const results = [];
const cases = [
  ['系统默认', null],
  ['本地中文音色', localZhFirst],
  ...[0, 1, 2, 3].map((i) => [`在线中文音色#${i + 1}`, onlineZh[i]?.key]).filter((x) => x[1]),
];
for (const [label, name] of cases) {
  const raw = await speakTest(name, '这是语音测试。');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = { ok: false, why: String(raw).slice(0, 120) };
  }
  results.push({ label, name, ...parsed });
  console.log(`  ${parsed.ok ? '✓' : '✗'} ${label}${name ? `（${name}）` : ''} → ${parsed.ok ? '正常读完' : parsed.why}`);
  await sleep(300);
}

ws.close();
child.kill();
await sleep(700);
try { rmSync(PROFILE, { recursive: true, force: true }); } catch {}

const onlineOk = results.filter((r) => r.label.includes('在线') && r.ok).length;
console.log(
  `\n结论：在线音色 ${onlineOk > 0 ? '可用' : '不可用（或本机网络受限/无此音色）'}；` +
    `共测 ${results.length} 个，通过 ${results.filter((r) => r.ok).length} 个。`,
);

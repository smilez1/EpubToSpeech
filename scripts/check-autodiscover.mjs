import { spawn } from 'node:child_process';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 验证"自动抓取其他语音模型"：
 *  1. 页面显示官方变体（huayan x_low）与社区发现条目（Trelis 等）
 *  2. 社区条目带「社区发现」徽标，显示许可为社区来源
 *  3. download-all 链路：用 Trelis 的 model.onnx.json 小文件走完 下载→完成
 */
const browser = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find((p) => existsSync(p));
if (!browser) throw new Error('找不到 Microsoft Edge');
// 临时 profile 一律放项目内 .tmp/，不要落到项目外的盘符根目录
const profile = resolve(import.meta.dirname, '..', '.tmp', 'edge-autodiscover');
const port = 9495;
const WEB = process.env.WEB_BASE ?? 'http://127.0.0.1:5173';
const API = process.env.API_BASE ?? 'http://127.0.0.1:8787';
rmSync(profile, { recursive: true, force: true });
mkdirSync(profile, { recursive: true });
const child = spawn(browser, ['--headless=new', '--disable-gpu', '--no-first-run', '--autoplay-policy=no-user-gesture-required', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, `http://127.0.0.1:5173/#/voices`], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
try {
  let targets;
  for (let i = 0; i < 40 && !targets; i += 1) { await sleep(250); targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()).catch(() => null); }
  const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0; const pending = new Map();
  ws.addEventListener('message', (event) => { const m = JSON.parse(event.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); return r?.result?.value ?? (r?.exceptionDetails ? 'ERR:' + r.exceptionDetails.text : undefined); };
  await send('Runtime.enable'); await send('Page.enable');

  // 等页面加载 + 目录（后台探测已完成，页面打开即会请求）
  for (let i = 0; i < 40; i += 1) { const v = await ev(`document.body.innerText.includes('zh_CN-chaowen')`); if (v === true) break; await sleep(300); }
  await sleep(600);
  const info = await ev(`(() => {
    const t = document.body.innerText;
    return JSON.stringify({
      hasXlow: t.includes('x_low'),
      hasCommunity: t.includes('社区发现'),
      hasTrelis: t.includes('Trelis'),
      hasSpeaches: t.includes('speaches'),
      hasCommunityLicense: t.includes('社区来源') || t.includes('许可未标注'),
    });
  })()`);
  const vp = JSON.parse(info || '{}');
  console.log(`页面: ${info}`);
  results.push(['自动发现官方变体 (x_low)', vp.hasXlow === true]);
  results.push(['自动发现社区条目', vp.hasCommunity === true]);
  results.push(['社区条目具体显示 (Trelis/speaches)', vp.hasTrelis === true && vp.hasSpeaches === true]);
  results.push(['社区许可标注', vp.hasCommunityLicense === true]);

  /* download-all 链路：Trelis 的 model.onnx.json（4822 字节小文件） */
  const started = await ev(`(async () => {
    const res = await fetch('/api/piper/download-all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voice: 'Trelis-test', urls: ['https://hf-mirror.com/Trelis/piper-zh-cn-huayan-medium/resolve/main/model.onnx.json'] }),
    });
    const body = await res.json();
    return JSON.stringify(body);
  })()`);
  console.log(`download-all 启动: ${started}`);
  let jobId = null;
  try { jobId = JSON.parse(started || '{}').jobId; } catch { /* ignore */ }
  if (jobId) {
    let finalStatus = '';
    for (let i = 0; i < 60; i += 1) {
      await sleep(300);
      const s = await ev(`fetch('/api/piper/download/${jobId}').then(r => r.json()).then(j => JSON.stringify(j))`);
      try { const job = JSON.parse(s); if (job.status === 'done' || job.status === 'error') { finalStatus = s; break; } } catch { /* ignore */ }
    }
    console.log(`download-all 结果: ${finalStatus}`);
    const fj = JSON.parse(finalStatus || '{}');
    results.push(['download-all 完成', fj.status === 'done']);
    results.push(['文件落盘', Array.isArray(fj.files) && fj.files.length > 0]);
  } else {
    results.push(['download-all 完成', false]);
  }

  ws.close(); child.kill();
  console.log('\n=== 结果 ===');
  let pass = 0;
  for (const [name, ok] of results) { console.log(`${ok ? '✓' : '✗'} ${name}`); if (ok) pass += 1; }
  console.log(`${pass}/${results.length} 通过`);
  if (pass !== results.length) process.exit(1);
} catch (err) { console.error('FAIL:', err); child.kill(); process.exit(1); }
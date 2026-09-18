#!/usr/bin/env node
/**
 * 构建 epubtospeech「无环境」便携部署包。
 *
 * 产出目录自带 Node 与 Python 运行时，目标机器只需 Windows 10/11 64 位，
 * 不需要安装 Node.js / Python / CUDA 或任何依赖。
 *
 * 用法：
 *   node scripts/build-portable.mjs                      # 默认输出 D:\epubtospeech-portable
 *   node scripts/build-portable.mjs --voices all --zip   # 打包全部语音并压缩
 *
 * 前置构建输入（缺失时脚本会打印获取命令）：
 *   .tmp/dl/node.zip                 便携 Node
 *   .tmp/dl/python-embed.zip         Python embeddable
 *   .tmp/cpuvenv/Lib/site-packages   CPU-only 依赖（piper-tts 等）
 *   .tmp/deploy-app/node_modules     后端生产依赖（npm 扁平安装）
 *   dist/web                         前端构建产物
 *   models/piper                     语音模型
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const TMP = path.join(ROOT, '.tmp');
const DL = path.join(TMP, 'dl');

/* ---------------------------------- 参数 ---------------------------------- */

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const OUT = String(arg('out', path.join(ROOT, '..', 'epubtospeech-portable')));
const VOICES_ARG = String(arg('voices', 'chaowen'));
const WANT_ZIP = arg('zip', false) === true;
const VOICES = VOICES_ARG === 'all' ? ['chaowen', 'huayan', 'xiao_ya'] : [VOICES_ARG];

const log = (msg, color = '') => {
  const codes = { green: '\x1b[32m', cyan: '\x1b[36m', yellow: '\x1b[33m', red: '\x1b[31m', dim: '\x1b[90m' };
  console.log(color ? `${codes[color] ?? ''}${msg}\x1b[0m` : msg);
};
const step = (msg) => console.log(`\n\x1b[36m== ${msg}\x1b[0m`);
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function dirSize(dir) {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else total += fs.statSync(p).size;
    }
  };
  walk(dir);
  return total;
}

/* -------------------------------- 前置检查 -------------------------------- */

const nodeZip = path.join(DL, 'node.zip');
const pyZip = path.join(DL, 'python-embed.zip');
const sitePackages = path.join(TMP, 'cpuvenv', 'Lib', 'site-packages');
const prodModules = path.join(TMP, 'deploy-app', 'node_modules');
const webDist = path.join(ROOT, 'dist', 'web');
const modelsDir = path.join(ROOT, 'models', 'piper');

const required = [
  [nodeZip, '便携 Node zip'],
  [pyZip, 'Python embeddable zip'],
  [sitePackages, 'CPU-only site-packages'],
  [prodModules, '后端生产依赖'],
  [webDist, '前端构建产物（先跑 pnpm build）'],
  [modelsDir, '语音模型'],
];

step('检查构建输入');
const missing = required.filter(([p]) => !fs.existsSync(p));
if (missing.length > 0) {
  log('缺少以下构建输入：', 'red');
  for (const [p, label] of missing) log(`  - ${label}: ${p}`, 'red');
  log('\n获取方式：', 'yellow');
  log('  便携 Node:     curl -L -o .tmp/dl/node.zip https://npmmirror.com/mirrors/node/v22.20.0/node-v22.20.0-win-x64.zip');
  log('  Python embed:  curl -L -o .tmp/dl/python-embed.zip https://registry.npmmirror.com/-/binary/python/3.14.6/python-3.14.6-embed-amd64.zip');
  log('  CPU 依赖:      python -m venv .tmp/cpuvenv && .tmp/cpuvenv/Scripts/pip install piper-tts sentence-stream unicode-rbnf');
  log('                 .tmp/cpuvenv/Scripts/pip install --no-deps transformers tokenizers huggingface-hub safetensors');
  log('                 .tmp/cpuvenv/Scripts/pip install httpx charset-normalizer urllib3 filelock regex requests tqdm pyyaml');
  log('  生产依赖:      在 .tmp/deploy-app 执行 npm install --omit=dev fastify @fastify/multipart jszip');
  process.exit(1);
}
log('  全部就绪', 'green');

/* -------------------------------- 输出目录 -------------------------------- */

step(`准备输出目录 ${OUT}`);
if (fs.existsSync(OUT)) {
  log('  目录已存在，清空重建…', 'yellow');
  fs.rmSync(OUT, { recursive: true, force: true });
}
fs.mkdirSync(OUT, { recursive: true });

/* --------------------------------- Node ---------------------------------- */

step('组装 Node 运行时');
{
  const tmp = path.join(TMP, 'build-node');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  const r = spawnSync('tar', ['-xf', nodeZip, '-C', tmp], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('解压 Node zip 失败');
  // zip 内有一层版本目录，取出其内容作为 node/
  const inner = fs.readdirSync(tmp, { withFileTypes: true }).find((e) => e.isDirectory());
  if (!inner) throw new Error('Node zip 结构异常');
  fs.renameSync(path.join(tmp, inner.name), path.join(OUT, 'node'));
  fs.rmSync(tmp, { recursive: true, force: true });
  log(`  node/: ${mb(dirSize(path.join(OUT, 'node')))}`, 'green');
}

/* -------------------------------- Python --------------------------------- */

step('组装 Python 运行时（CPU-only）');
{
  const pyOut = path.join(OUT, 'python');
  fs.mkdirSync(pyOut, { recursive: true });
  const r = spawnSync('tar', ['-xf', pyZip, '-C', pyOut], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('解压 Python embeddable 失败');
  // embeddable 解释器靠 ._pth 决定 sys.path：加入 site-packages 并执行 site 初始化
  fs.writeFileSync(
    path.join(pyOut, 'python314._pth'),
    ['python314.zip', '.', 'Lib\\site-packages', 'import site', ''].join('\r\n'),
    'ascii',
  );
  // 拷贝依赖：排除 pip（部署包不需要包管理器）与 __pycache__
  const dst = path.join(pyOut, 'Lib', 'site-packages');
  fs.mkdirSync(dst, { recursive: true });
  fs.cpSync(sitePackages, dst, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(sitePackages, src);
      const first = rel.split(path.sep)[0];
      if (first === 'pip') return false;
      if (rel.split(path.sep).includes('__pycache__')) return false;
      return true;
    },
  });
  log(`  python/: ${mb(dirSize(pyOut))}`, 'green');
}

/* --------------------------------- 应用 ---------------------------------- */

step('组装应用');
const appOut = path.join(OUT, 'app');
fs.mkdirSync(appOut, { recursive: true });
fs.cpSync(path.join(ROOT, 'src'), path.join(appOut, 'src'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(appOut, 'package.json'));
fs.mkdirSync(path.join(appOut, 'scripts'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'scripts', 'piper-server.py'), path.join(appOut, 'scripts', 'piper-server.py'));
fs.cpSync(webDist, path.join(appOut, 'dist', 'web'), { recursive: true });
fs.cpSync(prodModules, path.join(appOut, 'node_modules'), { recursive: true });
fs.mkdirSync(path.join(appOut, 'data'), { recursive: true });
log(`  app/: ${mb(dirSize(appOut))}`, 'green');

/* ------------------------------- 语音模型 -------------------------------- */

step(`组装语音模型（${VOICES.join(', ')}）`);
const modelOut = path.join(appOut, 'models', 'piper');
fs.mkdirSync(modelOut, { recursive: true });
let needG2pW = false;
for (const v of VOICES) {
  const onnx = path.join(modelsDir, `zh_CN-${v}-medium.onnx`);
  const json = path.join(modelsDir, `zh_CN-${v}-medium.onnx.json`);
  if (!fs.existsSync(onnx)) throw new Error(`缺少模型文件: ${onnx}`);
  fs.copyFileSync(onnx, path.join(modelOut, path.basename(onnx)));
  if (fs.existsSync(json)) fs.copyFileSync(json, path.join(modelOut, path.basename(json)));
  // chaowen / xiao_ya 走拼音 g2pW 路线需要查表资源；huayan 用 espeak
  if (v !== 'huayan') needG2pW = true;
  log(`  + zh_CN-${v}-medium`, 'green');
}
if (needG2pW) {
  const g2pSrc = path.join(modelsDir, '_resources', 'g2pW');
  if (!fs.existsSync(g2pSrc)) throw new Error(`缺少 g2pW 资源: ${g2pSrc}（chaowen/xiao_ya 必需）`);
  const g2pDst = path.join(modelOut, '_resources', 'g2pW');
  fs.mkdirSync(g2pDst, { recursive: true });
  fs.cpSync(g2pSrc, g2pDst, {
    recursive: true,
    filter: (src) => !path.relative(g2pSrc, src).split(path.sep).includes('__pycache__'),
  });
  log('  + g2pW 中文查表资源', 'green');
}
log(`  models/: ${mb(dirSize(modelOut))}`, 'green');

/* ------------------------------ 启动脚本与说明 ---------------------------- */

step('生成启动脚本与说明');

// 注意：.bat 内容必须是纯 ASCII。
// cmd 按字节解析脚本，UTF-8 的中文字符会导致行被截断/命令拼接
// （实测出现 'tal-transform-types'、'cho' 这类碎片报错，服务起不来）。
// 中文说明统一放在 使用说明.txt。
const START_BAT = `@echo off
setlocal
cd /d "%~dp0"
title epubtospeech

echo ==========================================
echo   EPUB Reader - starting
echo ==========================================
echo.

if not exist "%~dp0python\\python.exe" (
  echo [ERROR] missing python\\python.exe - package incomplete.
  pause
  exit /b 1
)
if not exist "%~dp0node\\node.exe" (
  echo [ERROR] missing node\\node.exe - package incomplete.
  pause
  exit /b 1
)
if not exist "%~dp0app\\models\\piper" (
  echo [ERROR] missing app\\models\\piper voice models.
  pause
  exit /b 1
)

netstat -ano | findstr ":8787" | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo Services already running. Opening browser...
  start "" "http://127.0.0.1:8787"
  exit /b 0
)

echo [1/3] starting speech service ^(first load takes about 10s^)...
start "epubtospeech-tts" /min "%~dp0python\\python.exe" "%~dp0app\\scripts\\piper-server.py"

echo [2/3] starting web service...
start "epubtospeech-web" /min "%~dp0node\\node.exe" --no-warnings --experimental-strip-types --experimental-transform-types "%~dp0app\\src\\server\\index.ts"

echo [3/3] waiting for service to be ready...
set /a n=0
:wait
timeout /t 1 /nobreak >nul
set /a n+=1
curl -s -o nul --max-time 3 http://127.0.0.1:8787/api/health
if not errorlevel 1 goto ready
if %n% lss 30 goto wait

echo.
echo [WARN] no response in 30s - opening browser anyway.
start "" "http://127.0.0.1:8787"
goto done

:ready
echo.
echo Ready. Opening browser...
start "" "http://127.0.0.1:8787"

:done
echo.
echo Background services:
echo   speech  http://127.0.0.1:8788
echo   web     http://127.0.0.1:8787
echo.
echo You can close this window; run stop.bat to stop services.
echo.
pause
`;

// 纯 ASCII（原因同 start.bat：cmd 不能解析 UTF-8 中文脚本）
const STOP_BAT = `@echo off
setlocal
echo Stopping epubtospeech services...
for /f "tokens=5" %%p in ('netstat -aon ^| findstr ":8787" ^| findstr "LISTENING"') do taskkill /PID %%p /F >nul 2>&1
for /f "tokens=5" %%p in ('netstat -aon ^| findstr ":8788" ^| findstr "LISTENING"') do taskkill /PID %%p /F >nul 2>&1
echo Stopped. Ports 8787 and 8788 released.
pause
`;

const README = `EPUB 朗读器 · 便携版
================================================

一、怎么用
  1. 把整个文件夹拷到目标电脑（路径尽量不含中文）
  2. 双击 start.bat
  3. 浏览器会自动打开 http://127.0.0.1:8787 ，导入 EPUB 即可
  4. 用完双击 stop.bat 停止服务

二、需要什么环境
  不需要。Node.js、Python、CUDA 全都已打包在内，
  目标机只要是 Windows 10/11 64 位即可。

三、语音朗读
  · 默认使用 Piper 中文语音，完全离线、本机 CPU 合成
  · 阅读器内【设置 → 朗读引擎】可切换到系统/浏览器内置语音
  · 书架页【语音包】可下载更多语音（需要联网）

四、首次使用提示
  · 第一次点朗读会有约 10 秒加载（模型载入内存），之后每句约 1~2 秒
  · 语音合成服务在启动时会预热，稍等片刻再点播放体验最佳

五、出问题怎么办
  · 朗读没声音：确认 start.bat 的两个窗口都还开着；用 stop.bat 停掉后重启
  · 端口被占用：先用 stop.bat 释放 8787/8788，再重新启动
  · 换电脑拷贝：整个文件夹一起拷，不要只拷一部分

  注：start.bat / stop.bat 的提示文字是英文——cmd 解析中文 bat 会因为
      编码问题导致命令被截断、服务起不来，所以脚本保持纯英文；
      中文说明都写在本文件里。

六、目录说明
  node\\              便携 Node.js 运行时
  python\\            便携 Python 运行时（CPU 版依赖）
  app\\src\\          服务端源码
  app\\dist\\web\\    前端页面
  app\\models\\piper\\ 语音模型
  app\\data\\         书库数据（导入的书都在这里）
  start.bat          启动
  stop.bat           停止
`;

fs.writeFileSync(path.join(OUT, 'start.bat'), START_BAT, 'utf8');
fs.writeFileSync(path.join(OUT, 'stop.bat'), STOP_BAT, 'utf8');
fs.writeFileSync(path.join(OUT, '使用说明.txt'), README, 'utf8');
log('  start.bat / stop.bat / 使用说明.txt', 'green');

/* -------------------------------- 体积报告 -------------------------------- */

step('体积报告');
const rows = ['node', 'python', 'app'].map((d) => ({ 目录: d, 大小: mb(dirSize(path.join(OUT, d))) }));
for (const r of rows) log(`  ${r.目录.padEnd(10)} ${r.大小}`);
const total = dirSize(OUT);
log(`  总计       ${mb(total)}`, 'cyan');

/* -------------------------------- 可选压缩 -------------------------------- */

if (WANT_ZIP) {
  step('打包 zip');
  const zipPath = `${OUT}.zip`;
  if (fs.existsSync(zipPath)) fs.rmSync(zipPath, { force: true });
  // 用系统 tar 生成 zip（-a 按扩展名推断格式），避免 Compress-Archive 的慢与 BOM 问题
  const r = spawnSync('tar', ['-a', '-cf', zipPath, '-C', path.dirname(OUT), path.basename(OUT)], { stdio: 'inherit' });
  if (r.status !== 0) log('  zip 打包失败，但目录本身可用', 'yellow');
  else log(`  ${zipPath}  (${mb(fs.statSync(zipPath).size)})`, 'green');
}

step('完成');
log(`输出目录: ${OUT}`, 'green');
log('把整个目录拷到目标机器，双击 start.bat 即可运行。', 'green');

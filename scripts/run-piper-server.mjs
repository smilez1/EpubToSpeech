#!/usr/bin/env node
/**
 * 启动 Piper 语音合成 sidecar。
 *
 * 自动挑选 Python 解释器，让 Windows / macOS / Linux 用同一条命令：
 *   1. 项目内虚拟环境（Windows: .venv-tts\Scripts\python.exe；类 Unix: .venv-tts/bin/python）
 *   2. 退回到 PATH 上的 python3 / python
 *
 * 环境变量：
 *   PYTHON            指定解释器路径（优先于上面的探测）
 *   PIPER_PORT        监听端口（默认 8788，供 Node 侧代理转发）
 *   PIPER_MODEL_DIR   语音模型目录（默认 models/piper）
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const isWin = process.platform === 'win32';

function candidates() {
  const list = [];
  if (process.env.PYTHON) list.push(process.env.PYTHON);
  // 项目虚拟环境（两种平台的目录布局不同）
  list.push(
    isWin
      ? path.join(ROOT, '.venv-tts', 'Scripts', 'python.exe')
      : path.join(ROOT, '.venv-tts', 'bin', 'python'),
  );
  // 退回系统解释器
  list.push(isWin ? 'python' : 'python3', 'python');
  return list;
}

function resolvePython() {
  for (const c of candidates()) {
    if (c.includes(path.sep) || c.includes('/')) {
      if (fs.existsSync(c)) return c;
      continue;
    }
    // PATH 上的命令交给 spawn 解析（找不到会在 spawn 时报 ENOENT）
    return c;
  }
  return null;
}

const python = resolvePython();
if (!python) {
  console.error('找不到 Python。请先创建虚拟环境并安装依赖：');
  console.error('  python -m venv .venv-tts');
  console.error(isWin
    ? '  .venv-tts\\Scripts\\pip install piper-tts sentence-stream unicode-rbnf transformers'
    : '  .venv-tts/bin/pip install piper-tts sentence-stream unicode-rbnf transformers');
  process.exit(1);
}

const server = path.join(ROOT, 'scripts', 'piper-server.py');
if (!fs.existsSync(server)) {
  console.error(`找不到 sidecar 脚本: ${server}`);
  process.exit(1);
}

const modelsDir = process.env.PIPER_MODEL_DIR ?? path.join(ROOT, 'models', 'piper');
if (!fs.existsSync(modelsDir)) {
  console.error(`找不到语音模型目录: ${modelsDir}`);
  console.error('请在书架页「语音包」中下载，或参考 README 手动放置 .onnx + .onnx.json。');
  process.exit(1);
}

console.log(`使用解释器: ${python}`);
const child = spawn(python, [server], { stdio: 'inherit', cwd: ROOT });

// 让 Ctrl+C / 父进程退出能一并结束 sidecar
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    child.kill(sig);
    process.exit(0);
  });
}
child.on('exit', (code) => process.exit(code ?? 0));

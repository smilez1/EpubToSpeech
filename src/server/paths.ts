import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** 仓库根目录（src/server/paths.ts → 上溯两级）。 */
export const ROOT = fileURLToPath(new URL('../../', import.meta.url));

export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(ROOT, 'data');

export const BOOKS_DIR = path.join(DATA_DIR, 'books');
export const COVERS_DIR = path.join(DATA_DIR, 'covers');
export const INDEX_FILE = path.join(DATA_DIR, 'index.json');

/** 构建产物目录，存在时由 API 服务顺带托管。 */
export const DIST_WEB_DIR = path.join(ROOT, 'dist', 'web');

/**
 * 读取 `--name value` 形式的命令行参数。
 * 只给 `--name` 不给值时，按 `0.0.0.0` 处理（对应 `--host` 的简写用法）。
 *
 * 用命令行参数而不是环境变量：Windows 上 PowerShell 与 cmd 的变量语法不同，
 * 而参数写法两边都可靠。
 */
function pickArg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i === -1) return undefined;
  const value = process.argv[i + 1];
  return value && !value.startsWith('--') ? value : '0.0.0.0';
}

export const API_PORT = Number(pickArg('--port') ?? process.env.API_PORT ?? 8787);

/** 监听地址。默认只监听本机；`--host`（或 API_HOST）可改为 0.0.0.0 允许局域网访问。 */
export const API_HOST = pickArg('--host') ?? process.env.API_HOST ?? '127.0.0.1';

/** 是否放开了局域网访问（用于打印醒目提示并启用 CORS）。 */
export const API_IS_LAN =
  API_HOST === '0.0.0.0' || API_HOST === '::' || process.env.API_ALLOW_LAN === '1';

export function bookFilePath(id: string): string {
  return path.join(BOOKS_DIR, `${id}.epub`);
}

export function coverFilePath(id: string): string {
  return path.join(COVERS_DIR, `${id}.bin`);
}

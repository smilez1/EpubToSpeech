import { createHash } from 'node:crypto';

/**
 * 内容寻址 id：取 sha256 前 32 位十六进制。
 * 同一本书重复导入会得到同一个 id，天然去重。
 */
export function bookIdFromSha256(sha256: string): string {
  return sha256.slice(0, 32);
}

export function sha256Of(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * 校验是否真的是 epub：zip 魔数 + mimetype 条目。
 * 只做便宜检查，完整解析交给前端（前端本来就要解析才能渲染）。
 */
export function looksLikeEpub(buf: Buffer): boolean {
  if (buf.length < 4) return false;
  // ZIP 本地文件头 PK\x03\x04
  if (!(buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04)) {
    return false;
  }
  // epub 规范要求首个条目为未压缩的 `mimetype`，内容为 application/epub+zip
  const head = buf.subarray(0, 64).toString('latin1');
  return head.includes('mimetype') || head.includes('application/epub+zip');
}

/** 文件名安全化：仅用于日志与原始名记录，不参与路径拼接。 */
export function sanitizeFileName(name: string): string {
  return name.replace(/[/\\?%*:|"<>\u0000-\u001f]/g, '_').slice(0, 200) || 'unknown.epub';
}

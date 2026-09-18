import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import multipart from '@fastify/multipart';
import { API_HOST, API_IS_LAN, API_PORT, DIST_WEB_DIR } from './paths.ts';
import { registerBookRoutes } from './routes/books.ts';
import { registerPiperRoutes } from './routes/piper.ts';
import { registerTtsRoutes } from './routes/tts.ts';
import { initStore } from './storage.ts';

const MIME_BY_EXT: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

function sendFile(reply: FastifyReply, filePath: string): FastifyReply {
  const ext = path.extname(filePath).toLowerCase();
  return reply
    .header('Content-Type', MIME_BY_EXT[ext] ?? 'application/octet-stream')
    .send(fs.createReadStream(filePath));
}

/**
 * 托管 `vite build` 产物并做 SPA 回退。
 * 开发模式下 dist 不存在，此时给出明确提示（前端由 Vite dev server 提供）。
 */
async function registerStatic(app: FastifyInstance): Promise<void> {
  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply
        .code(404)
        .send({ error: { code: 'NOT_FOUND', message: `没有这个接口: ${request.url}` } });
    }
    if (!fs.existsSync(DIST_WEB_DIR)) {
      return reply
        .code(404)
        .type('text/plain; charset=utf-8')
        .send('前端构建产物不存在。开发时请访问 http://localhost:5173 ，或先执行 pnpm build。');
    }

    // 路径穿越防护：解析后必须仍在 DIST_WEB_DIR 内
    const rel = decodeURIComponent(request.url.split('?')[0] ?? '/');
    const candidate = path.resolve(DIST_WEB_DIR, `.${path.posix.normalize(rel)}`);
    if (
      candidate.startsWith(DIST_WEB_DIR) &&
      fs.existsSync(candidate) &&
      fs.statSync(candidate).isFile()
    ) {
      return sendFile(reply, candidate);
    }
    const indexHtml = path.join(DIST_WEB_DIR, 'index.html');
    if (fs.existsSync(indexHtml)) return sendFile(reply, indexHtml);
    return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '页面不存在' } });
  });
}

async function main(): Promise<void> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    // epub 上传体积上限；multipart 内部会先于这里拦截
    bodyLimit: 210 * 1024 * 1024,
  });

  /**
   * 局域网访问支持。
   *
   * 默认只监听 127.0.0.1（本机）。设置 API_ALLOW_LAN=1 后会：
   *  - 允许跨源请求（手机/平板可能从别的地址访问前端，再由它调这个接口）
   *  - 允许从局域网地址访问封面（<img> 加载，需要放行该来源）
   *
   * 安全提醒：本接口没有任何认证，能访问到的人就能读写你的整库书。
   * 只在可信局域网内开启，绝不要映射到公网。
   */
  if (API_IS_LAN) {
    app.addHook('onRequest', (request, reply, done) => {
      const origin = request.headers.origin;
      if (origin) {
        reply.header('Access-Control-Allow-Origin', origin);
        reply.header('Vary', 'Origin');
        reply.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
        reply.header('Access-Control-Allow-Headers', 'Content-Type');
      }
      if (request.method === 'OPTIONS') {
        reply.code(204).send();
        return;
      }
      done();
    });
  }

  await app.register(multipart, {
    limits: {
      fileSize: 200 * 1024 * 1024,
      files: 2,
      fields: 4,
    },
  });

  app.get('/api/health', async () => ({
    ok: true,
    name: 'epub-to-speech',
    version: '0.1.0',
    time: new Date().toISOString(),
  }));

  await registerBookRoutes(app);
  await registerPiperRoutes(app);
  await registerTtsRoutes(app);
  await initStore();
  await registerStatic(app);

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void app.close().finally(() => process.exit(0));
    });
  }

  app.setErrorHandler((error: unknown, request, reply) => {
    const err = error as { code?: string; statusCode?: number; message?: string };
    const code = err.code;
    if (code === 'FST_REQ_FILE_TOO_LARGE') {
      return reply
        .code(413)
        .send({ error: { code: 'FILE_TOO_LARGE', message: '文件超过 200MB 上限' } });
    }
    if (code === 'FST_INVALID_MULTIPART_CONTENT_TYPE') {
      return reply
        .code(400)
        .send({ error: { code: 'BAD_MULTIPART', message: 'multipart 请求格式有问题' } });
    }
    if (err.statusCode === 400) {
      return reply
        .code(400)
        .send({ error: { code: 'BAD_REQUEST', message: err.message ?? '请求格式有误' } });
    }
    request.log.error(err);
    return reply
      .code(500)
      .send({ error: { code: 'INTERNAL', message: err.message || '服务内部错误' } });
  });

  await app.listen({ host: API_HOST, port: API_PORT });
  if (API_IS_LAN) {
    console.log(`[api] 书库接口就绪: http://${API_HOST}:${API_PORT}/api/health`);
    console.log('');
    console.log('  ⚠ 已开启局域网访问：任何能访问本机端口的人都可以读写你的书籍。');
    console.log('    本应用没有登录/认证，请只在可信局域网内使用，不要映射到公网。');
    console.log('');
  } else {
    console.log(`[api] 书库接口就绪: http://${API_HOST}:${API_PORT}/api/health`);
  }
}

main().catch((err: unknown) => {
  console.error('[api] 启动失败', err);
  process.exit(1);
});

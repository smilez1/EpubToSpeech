import type { FastifyInstance } from 'fastify';
const PIPER_URL = `http://127.0.0.1:${process.env.PIPER_PORT ?? '8788'}`;
async function sidecar(path: string, init?: RequestInit): Promise<Response> { return fetch(`${PIPER_URL}${path}`, { ...init, signal: init?.signal ?? AbortSignal.timeout(30_000) }); }
async function unavailable(reply: { code: (n: number) => { send: (v: unknown) => unknown } }): Promise<unknown> { return reply.code(503).send({ error: { code: 'PIPER_UNAVAILABLE', message: 'Piper 服务未启动，请先启动 piper:server' } }); }
export async function registerTtsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/tts/piper/health', async (_request, reply) => { try { const r=await sidecar('/health'); return reply.code(r.ok?200:503).send(await r.json()); } catch { return unavailable(reply); } });
  app.get('/api/tts/piper/voices', async (_request, reply) => { try { const r=await sidecar('/voices'); return reply.code(r.status).header('Content-Type','application/json').send(await r.text()); } catch { return unavailable(reply); } });
  app.post('/api/tts/piper/synthesize', async (request, reply) => { try { const r=await sidecar('/synthesize',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request.body??{}),signal:AbortSignal.timeout(120_000)}); return reply.code(r.status).header('Content-Type',r.headers.get('content-type')??'audio/wav').send(Buffer.from(await r.arrayBuffer())); } catch { return unavailable(reply); } });
}

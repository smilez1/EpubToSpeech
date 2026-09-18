import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { ROOT } from '../paths.ts';

/**
 * Piper 语音包目录 / 下载。
 *
 * 来源：
 *  - 官方 rhasspy/piper-voices（zh/zh_CN 下，ONNX + JSON 成对）
 *  - 社区 .zip 打包包（从 Hugging Face 任意仓库直接拖入，如特斯拉小政），
 *    下载后自动解压，把里面的 .onnx / .onnx.json 装进 models/piper
 *
 * 许可策略（由页面展示，下载前确认）：
 *  - downloadPolicy='free'    → CC0 之类，可直接一键下载
 *  - downloadPolicy='confirm' → 非商业/未知许可，仍可下载（服务端不禁止），
 *                              但前端下载前会弹确认框提示自担风险
 */

const PIPER_MODELS_DIR = path.join(ROOT, 'models', 'piper');
const HF_BASE = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/zh/zh_CN';
const LIST_API = 'https://huggingface.co/api/models/rhasspy/piper-voices/tree/main/zh/zh_CN';
const LIST_API_MIRROR = 'https://hf-mirror.com/api/models/rhasspy/piper-voices/tree/main/zh/zh_CN';

type DownloadPolicy = 'free' | 'confirm';

/** 语音包元数据。type='single' 是官方成对文件；type='zip' 是社区打包。 */
interface PackMeta {
  id: string;
  type: 'single' | 'zip';
  family: string;
  quality: string;
  display: string;
  license: string;
  downloadPolicy: DownloadPolicy;
  home: string;
  sizeOnnx: number;
}

const KNOWN_PACKS: PackMeta[] = [
  {
    id: 'zh_CN-chaowen-medium',
    type: 'single',
    family: 'chaowen',
    quality: 'medium',
    display: '超文 (chaowen)',
    license: 'CC0 公有领域',
    downloadPolicy: 'free',
    home: 'https://huggingface.co/rhasspy/piper-voices/tree/main/zh/zh_CN/chaowen/medium',
    sizeOnnx: 63_221_984,
  },
  {
    id: 'zh_CN-xiao_ya-medium',
    type: 'single',
    family: 'xiao_ya',
    quality: 'medium',
    display: '小雅 (xiao_ya)',
    license: '非商业使用 (DataBaker/BZNSYP)',
    downloadPolicy: 'confirm',
    home: 'https://huggingface.co/rhasspy/piper-voices/tree/main/zh/zh_CN/xiao_ya/medium',
    sizeOnnx: 63_221_984,
  },
  {
    id: 'zh_CN-huayan-medium',
    type: 'single',
    family: 'huayan',
    quality: 'medium',
    display: '华宴 (huayan)',
    license: '未知（PlayVoice/HuaYan_TTS）',
    downloadPolicy: 'confirm',
    home: 'https://huggingface.co/rhasspy/piper-voices/tree/main/zh/zh_CN/huayan/medium',
    sizeOnnx: 63_201_294,
  },
];

interface DownloadJob {
  voice: string;
  status: 'running' | 'done' | 'error';
  received: number;
  total: number;
  files: string[];
  error?: string;
}

const jobs = new Map<string, DownloadJob>();

function fetchWithTimeout(url: string, ms: number, init?: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
}

/** 官方 zh/zh_CN 下的一个语音变体（family/quality 组合）。 */
interface OfficialVariant {
  family: string;
  quality: string;
  id: string;
}

/**
 * 递归探测官方 HF 仓库（zh/zh_CN 下所有 family 的所有 quality），
 * 解析出形如 `zh/zh_CN/<family>/<quality>/<id>.onnx` 的变体。
 * 失败返回 null。
 */
async function probeRemoteTree(): Promise<OfficialVariant[] | null> {
  for (const api of [LIST_API, LIST_API_MIRROR]) {
    try {
      const url = `${api}?recursive=true`;
      const res = await fetchWithTimeout(url, 10_000);
      if (!res.ok) continue;
      const body = (await res.json()) as Array<{ path: string; type: string }>;
      const variants = new Map<string, OfficialVariant>();
      for (const e of body) {
        if (e.type !== 'file' || !e.path.endsWith('.onnx') || e.path.includes('_resources')) continue;
        // path = zh/zh_CN/<family>/<quality>/<id>.onnx
        const parts = e.path.split('/');
        const family = parts[2];
        const quality = parts[3];
        const id = parts[4]?.replace(/\.onnx$/, '');
        if (family && quality && id) {
          variants.set(id, { family, quality, id });
        }
      }
      if (variants.size > 0) return [...variants.values()];
    } catch {
      /* try next */
    }
  }
  return null;
}

/** 社区仓库条目（HF 搜索发现的）。 */
interface CommunityPack {
  id: string; // repo 名
  display: string;
  home: string;
  files: string[]; // 仓库内 .onnx/.onnx.json/.zip 文件名
  sizeOnnx: number;
}

const SEARCH_API = 'https://hf-mirror.com/api/models';
const COMMUNITY_CACHE_TTL_MS = 15 * 60 * 1000;

/**
 * 用 HF 搜索 API 发现社区 piper 语音包仓库，并探测文件结构。
 * 只保留含 .onnx 或 .zip 的仓库；结果缓存 15 分钟。
 */
async function probeCommunityPacks(): Promise<CommunityPack[]> {
  const out: CommunityPack[] = [];
  try {
    const search = await fetchWithTimeout(`${SEARCH_API}?search=piper%20zh&limit=30&full=true`, 10_000);
    if (!search.ok) return out;
    const models = (await search.json()) as Array<{ id: string; downloads?: number }>;
    // 只看下载量非 0 的仓库，避免大量死仓库
    const candidates = models
      .filter((m) => (m.downloads ?? 0) > 0)
      .sort((a, b) => (b.downloads ?? 0) - (a.downloads ?? 0))
      .slice(0, 12);
    for (const m of candidates) {
      try {
        const tree = await fetchWithTimeout(`${SEARCH_API}/${m.id}/tree/main?recursive=true`, 8000);
        if (!tree.ok) continue;
        const files = ((await tree.json()) as Array<{ path: string; type: string }>)
          .filter((e) => e.type === 'file')
          .map((e) => e.path)
          .filter((p) => /\.(onnx|onnx\.json|zip)$/i.test(p));
        const onnxFiles = files.filter((p) => p.toLowerCase().endsWith('.onnx') && !p.toLowerCase().includes('quant'));
        const zipFiles = files.filter((p) => p.toLowerCase().endsWith('.zip'));
        if (onnxFiles.length === 0 && zipFiles.length === 0) continue;
        // 只取一层子目录以内的文件（仓库根 + 一个子目录），避免深目录包
        const shallow = files.filter((p) => p.split('/').length <= 3);
        if (shallow.length === 0) continue;
        out.push({
          id: m.id,
          display: m.id.split('/').pop() ?? m.id,
          home: `https://huggingface.co/${m.id}`,
          files: shallow,
          sizeOnnx: 0,
        });
      } catch {
        /* 单个仓库探测失败跳过 */
      }
    }
  } catch {
    /* 搜索失败返回已收集部分 */
  }
  return out;
}

interface CatalogEntry {
  id: string;
  type: 'single' | 'zip';
  display: string;
  license: string;
  downloadPolicy: DownloadPolicy;
  home: string;
  sizeOnnx: number;
  installed: boolean;
  /** 社区条目：仓库内文件名列表（用于 URL 直链安装）。 */
  files?: string[];
  source: 'official' | 'community';
  /** 官方变体：真实语音 id（如 zh_CN-huayan-x_low）。 */
  actualVoice?: string;
  /** 官方变体：该变体的完整下载 URL 列表（onnx + json）。 */
  urls?: string[];
}

function listInstalled(): Set<string> {
  const set = new Set<string>();
  if (!fs.existsSync(PIPER_MODELS_DIR)) return set;
  for (const f of fs.readdirSync(PIPER_MODELS_DIR)) {
    if (f.endsWith('.onnx') && !f.startsWith('g2pw')) set.add(f.slice(0, -5));
  }
  return set;
}

/** 远程探测缓存。 */
let remoteVariantsCache: OfficialVariant[] | null = null;
let remoteVariantsAt = 0;
let communityCache: CommunityPack[] | null = null;
let communityAt = 0;
const REMOTE_CACHE_MS = 10 * 60 * 1000;

/** 流式下载单文件到目标路径，累加进度。返回字节数。 */
async function streamDownload(url: string, target: string, job: DownloadJob): Promise<number> {
  const res = await fetchWithTimeout(url, 15_000);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length') ?? 0);
  job.total += total;
  if (!res.body) throw new Error('无响应体');
  const writer = fs.createWriteStream(target);
  const reader = res.body.getReader();
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    writer.write(Buffer.from(value));
    job.received += value.byteLength;
    bytes += value.byteLength;
  }
  await new Promise<void>((resolve, reject) => {
    writer.end(() => resolve());
    writer.on('error', reject);
  });
  return bytes;
}

/** 解压 zip 到临时目录，返回里面 .onnx/.onnx.json 文件路径。 */
async function extractVoiceFiles(zipPath: string, tmpDir: string): Promise<string[]> {
  const data = fs.readFileSync(zipPath);
  const zip = await JSZip.loadAsync(data);
  const wanted: string[] = [];
  const names = Object.keys(zip.files).filter((n) => !zip.files[n]!.dir);
  const onnxFile = names.find((n) => n.toLowerCase().endsWith('.onnx') && !n.toLowerCase().includes('quant')) ?? names.find((n) => n.toLowerCase().endsWith('.onnx'));
  if (!onnxFile) throw new Error('压缩包里没有 .onnx 模型文件');
  const base = onnxFile.slice(0, -5);
  const jsonFile = names.find((n) => n.toLowerCase() === `${base}.onnx.json`);
  if (!jsonFile) throw new Error(`压缩包里缺少 ${base}.onnx.json 配置文件`);
  for (const name of [onnxFile, jsonFile]) {
    const out = path.join(tmpDir, path.basename(name));
    fs.writeFileSync(out, await zip.files[name]!.async('nodebuffer'));
    wanted.push(out);
  }
  return wanted;
}

/** 下载安装 zip 包：下载 → 解压 → 把 onnx/json 装入 models/piper。 */
async function installZipFrom(url: string, job: DownloadJob): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(PIPER_MODELS_DIR, '.zip-tmp-'));
  try {
    const tmpZip = path.join(tmpDir, 'voice.zip');
    const bytes = await streamDownload(url, tmpZip, job);
    if (bytes < 1000) throw new Error('下载内容过小，疑似错误页面');
    const files = await extractVoiceFiles(tmpZip, tmpDir);
    for (const f of files) {
      const dest = path.join(PIPER_MODELS_DIR, path.basename(f));
      fs.copyFileSync(f, dest);
      job.files.push(path.basename(f));
    }
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/** 安装单个 onnx / json 文件（来自 URL）。 */
async function installFileFrom(url: string, job: DownloadJob): Promise<void> {
  const name = decodeURIComponent(url.split('/').pop() ?? 'unknown.bin').split('?')[0]!;
  const base = path.basename(name);
  if (!/\.(onnx|onnx\.json)$/i.test(base)) {
    throw new Error('只支持 .onnx / .onnx.json 文件');
  }
  const tmp = path.join(PIPER_MODELS_DIR, `${base}.part`);
  await streamDownload(url, tmp, job);
  fs.renameSync(tmp, path.join(PIPER_MODELS_DIR, base));
  job.files.push(base);
}

export async function registerPiperRoutes(app: FastifyInstance): Promise<void> {
  /** 目录：立即返回内置清单，远程探测放后台（避免页面等十几秒）。 */
  app.get('/api/piper/catalog', async (_request, reply) => {
    try {
      const installed = listInstalled();
      const entries: CatalogEntry[] = KNOWN_PACKS.map((p) => ({
        id: p.id,
        type: p.type,
        display: p.display,
        license: p.license,
        downloadPolicy: p.downloadPolicy,
        home: p.home,
        sizeOnnx: p.sizeOnnx,
        installed: installed.has(p.id),
        source: 'official',
        urls: [
          `${HF_BASE}/${p.family}/${p.quality}/${p.id}.onnx`,
          `${HF_BASE}/${p.family}/${p.quality}/${p.id}.onnx.json`,
        ],
      }));

      // 后台探测：官方全部变体 + 社区仓储（失败静默，保持已有清单）
      if (remoteVariantsCache === null || Date.now() - remoteVariantsAt > REMOTE_CACHE_MS) {
        void (async () => {
          try {
            const remote = await probeRemoteTree();
            if (remote && remote.length > 0) { remoteVariantsCache = remote; remoteVariantsAt = Date.now(); }
          } catch { /* 保持 */ }
        })();
      }
      if (communityCache === null || Date.now() - communityAt > COMMUNITY_CACHE_TTL_MS) {
        void (async () => {
          try {
            const community = await probeCommunityPacks();
            if (community.length > 0) { communityCache = community; communityAt = Date.now(); }
          } catch { /* 保持 */ }
        })();
      }

      // 官方所有变体（含 x_low / low / high 等）
      if (remoteVariantsCache) {
        for (const v of remoteVariantsCache) {
          if (entries.some((e) => e.id === v.id)) continue;
          entries.push({
            id: v.id,
            type: 'single',
            display: `${v.family}（${v.quality}）`,
            license: '官方 rhasspy/piper-voices',
            downloadPolicy: v.family === 'chaowen' ? 'free' : 'confirm',
            home: `https://huggingface.co/rhasspy/piper-voices/tree/main/zh/zh_CN/${v.family}/${v.quality}`,
            sizeOnnx: 0,
            installed: installed.has(v.id),
            source: 'official',
            actualVoice: v.id,
            urls: [
              `${HF_BASE}/${v.family}/${v.quality}/${v.id}.onnx`,
              `${HF_BASE}/${v.family}/${v.quality}/${v.id}.onnx.json`,
            ],
          });
        }
      }

      // 社区自动发现（HF 搜索）
      const communityList = communityCache ?? [];
      for (const c of communityList) {
        if (entries.some((e) => e.id === c.id)) continue;
        // 过滤出可下载文件（onnx / onnx.json / zip），生成 resolve 直链
        const dlFiles = (c.files ?? []).filter((f) => /\.(onnx|onnx\.json|zip)$/i.test(f));
        const urls = dlFiles.map((f) => `https://huggingface.co/${c.id}/resolve/main/${f}`);
        entries.push({
          id: c.id,
          type: urls.some((u) => u.toLowerCase().endsWith('.zip')) ? 'zip' : 'single',
          display: `${c.display}（社区）`,
          license: '社区来源，许可未标注（请自行核对）',
          downloadPolicy: 'confirm',
          home: c.home,
          sizeOnnx: c.sizeOnnx,
          installed: false,
          files: dlFiles,
          urls,
          source: 'community',
        });
      }

      for (const e of entries) e.installed = installed.has(e.id);
      return reply.send({
        voices: entries,
        sources: ['Hugging Face 官方 (rhasspy/piper-voices)', 'hf-mirror.com 镜像', 'HF 社区 (搜索发现)'],
      });
    } catch (err) {
      return reply.code(500).send({ error: { code: 'CATALOG_FAILED', message: (err as Error).message } });
    }
  });

  /** 发起下载任务。
   *  - KNOWN_PACKS 里的官方包 → 用内置 family/quality 拼 URL
   *  - 请求带 urls 数组（探测到的官方变体 / 社区条目）→ 逐 URL 安装
   */
  app.post('/api/piper/download-all', async (request, reply) => {
    const body = request.body as { voice?: string; urls?: string[] };
    const voice = body?.voice ?? 'urls';
    const urls = Array.isArray(body.urls) ? body.urls : [];
    if (urls.length === 0) {
      return reply.code(400).send({ error: { code: 'NO_URLS', message: '缺少下载链接' } });
    }
    // 只允许 http(s) 且扩展名合法
    for (const u of urls) {
      if (!/^https?:\/\//i.test(u) || !/\.(zip|onnx|onnx\.json)$/i.test(u.split('?')[0]!.toLowerCase())) {
        return reply.code(400).send({ error: { code: 'BAD_URL', message: `不支持的链接：${u}` } });
      }
    }
    if (!fs.existsSync(PIPER_MODELS_DIR)) fs.mkdirSync(PIPER_MODELS_DIR, { recursive: true });

    const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const job: DownloadJob = { voice, status: 'running', received: 0, total: 0, files: [] };
    jobs.set(jobId, job);

    void (async () => {
      try {
        for (const rawUrl of urls) {
          // huggingface.co 直连不稳时回退到 hf-mirror.com（把域名换掉，其余路径/文件名不变）
          const candidates = rawUrl.includes('huggingface.co')
            ? [rawUrl, rawUrl.replace('huggingface.co', 'hf-mirror.com')]
            : [rawUrl];
          let installed = false;
          let lastError: Error | null = null;
          for (const u of candidates) {
            try {
              if (u.toLowerCase().endsWith('.zip')) await installZipFrom(u, job);
              else await installFileFrom(u, job);
              installed = true;
              break;
            } catch (err) {
              lastError = err instanceof Error ? err : new Error(String(err));
              // 文件已部分写入 .part，installFileFrom/installZipFrom 内部清理
            }
          }
          if (!installed) throw lastError ?? new Error(`下载失败：${rawUrl}`);
        }
        job.status = 'done';
      } catch (err) {
        job.status = 'error';
        job.error = (err as Error).message;
      }
    })();

    return reply.send({ jobId, alreadyInstalled: false });
  });

  /**
   * 从任意 URL 安装语音包：
   *  - .zip   → 下载后解压，取出 .onnx / .onnx.json 装进 models/piper
   *  - .onnx / .onnx.json → 直接下载放入
   * 进度走同一个 /api/piper/download/:jobId 轮询。
   */
  app.post('/api/piper/install-url', async (request, reply) => {
    const body = request.body as { url?: string };
    const url = body?.url;
    if (!url || !/^https?:\/\//i.test(url)) {
      return reply.code(400).send({ error: { code: 'BAD_URL', message: '需要一个 http(s) 链接' } });
    }
    const ext = url.split('?')[0]!.toLowerCase();
    if (!/\.(zip|onnx|onnx\.json)$/i.test(ext)) {
      return reply.code(400).send({ error: { code: 'BAD_EXT', message: '只支持 .zip / .onnx / .onnx.json 链接' } });
    }
    if (!fs.existsSync(PIPER_MODELS_DIR)) fs.mkdirSync(PIPER_MODELS_DIR, { recursive: true });

    const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const job: DownloadJob = { voice: url, status: 'running', received: 0, total: 0, files: [] };
    jobs.set(jobId, job);

    void (async () => {
      try {
        if (ext.endsWith('.zip')) await installZipFrom(url, job);
        else await installFileFrom(url, job);
        job.status = 'done';
      } catch (err) {
        job.status = 'error';
        job.error = (err as Error).message;
      }
    })();

    return reply.send({ jobId, alreadyInstalled: false });
  });

  /** 查询下载进度。 */
  app.get('/api/piper/download/:jobId', async (request, reply) => {
    const jobId = (request.params as { jobId: string }).jobId;
    const job = jobs.get(jobId);
    if (!job) return reply.code(404).send({ error: { code: 'JOB_NOT_FOUND', message: '任务不存在' } });
    const installed = job.files.length > 0 ? listInstalled().has(job.voice) : false;
    return reply.send({ ...job, installed: job.status === 'done' && installed });
  });
}
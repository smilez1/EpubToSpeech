/**
 * 测试用的 TS 模块加载器。
 *
 * 为什么不用 Node 的 `--experimental-strip-types` 直接 import .ts：
 * 那是**纯类型擦除**模式，不支持 TypeScript 参数属性
 * （`constructor(private readonly x)`）等需要生成代码的语法，
 * 而这些语法在正常 Vite 构建里完全合法。
 *
 * 做法：用 `stripTypeScriptTypes` 的 `transform` 模式把源码转成真正的 JS 再加载。
 * 两个必须处理的坑：
 *  1. 输出是 `.mjs`，而源码里是 `./speech`（无扩展名）→ 相对导入必须重写
 *  2. 输出文件名必须**由内容决定**，否则同一模块在不同调用里会落到不同文件，
 *     产生多个互不相干的模块实例（测试里会表现为莫名的状态不一致）
 *
 * 因此分两阶段：
 *  - 阶段一：递归收集依赖图，自底向上（DFS 后序）为每个模块决定最终文件名
 *  - 阶段二：按已决定的文件名重写相对导入并写出
 * 文件名 = 内容哈希，所以源码一改就自动换新文件，绝不会命中陈旧产物。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, basename, dirname, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';

// 本文件在 scripts/lib/ 下，上溯两级才是仓库根
const ROOT = resolve(import.meta.dirname, '../..');
const TMP = resolve(ROOT, '.tmp/ts-test');

/** 绝对路径 → 输出文件名（内容哈希，进程内缓存） */
const outNames = new Map();

/** 找出源码里引用的、仓库内的相对 TS 模块。 */
function relativeDepsOf(source, absPath) {
  const deps = [];
  for (const m of source.matchAll(/(['"])(\.{1,2}\/[^'"]+)\1/g)) {
    const spec = m[2];
    for (const cand of [spec, `${spec}.ts`, `${spec}/index.ts`]) {
      const target = resolve(dirname(absPath), cand);
      if (existsSync(target) && target.endsWith('.ts')) {
        deps.push(target);
        break;
      }
    }
  }
  return deps;
}

/** 阶段一：自底向上确定每个模块的输出文件名。 */
async function planOutputs(absPath, visiting = new Set()) {
  if (outNames.has(absPath)) return;
  if (visiting.has(absPath)) return; // 循环引用：打断，稍后自然处理
  visiting.add(absPath);

  const source = await readFile(absPath, 'utf8');
  for (const dep of relativeDepsOf(source, absPath)) {
    await planOutputs(dep, visiting);
  }

  // 依赖名已定，此时重写导入等价于最终形态，可据其算内容哈希
  const rewritten = rewriteImports(source, absPath);
  const hash = createHash('sha1').update(rewritten).digest('hex').slice(0, 12);
  outNames.set(absPath, `${basename(absPath, '.ts')}.${hash}.mjs`);
}

/** 把仓库内的相对 TS 导入重写成对应产物的 file URL。 */
function rewriteImports(source, absPath) {
  return source.replace(/(['"])(\.{1,2}\/[^'"]+)\1/g, (full, quote, spec) => {
    for (const cand of [spec, `${spec}.ts`, `${spec}/index.ts`]) {
      const target = resolve(dirname(absPath), cand);
      const name = outNames.get(target);
      if (name) return `${quote}${pathToFileURL(resolve(TMP, name)).href}${quote}`;
    }
    return full;
  });
}

/** 加载一个 TS 模块（可一次加载多个，互相之间的相对导入会被正确解析）。 */
export async function loadTsModule(relPath) {
  const [mod] = await loadTsModules([relPath]);
  return mod;
}

export async function loadTsModules(relPaths) {
  await mkdir(TMP, { recursive: true });

  const absPaths = relPaths.map((rel) => resolve(ROOT, rel));
  for (const abs of absPaths) {
    if (!existsSync(abs)) throw new Error(`找不到模块: ${abs}`);
    // 递归规划时会读源码，这里只需保证自身在计划内
    await planOutputs(abs);
  }

  // 阶段二：写出所有已规划产物（含递归发现的依赖）
  for (const [abs, name] of outNames) {
    const source = await readFile(abs, 'utf8');
    const js = stripTypeScriptTypes(rewriteImports(source, abs), {
      mode: 'transform',
      sourceUrl: pathToFileURL(abs).href,
    });
    await writeFile(resolve(TMP, name), js, 'utf8');
  }

  const loaded = [];
  for (const abs of absPaths) {
    loaded.push(await import(pathToFileURL(resolve(TMP, outNames.get(abs))).href));
  }
  return loaded;
}

/** 便于测试里定位仓库根。 */
export const repoRoot = ROOT;

export { relative };

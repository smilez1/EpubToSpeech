# EPUB 朗读器（epub-to-speech）

本地运行的 EPUB 阅读器 + 中文语音朗读。**书与语音都在本机处理，不上传任何云端。**

## 功能特性

- **本地书库**：拖入 EPUB 即导入，自动解析书名 / 作者 / 封面 / 目录，支持搜索与排序
- **连续朗读**：从任意位置起读，一句接一句自动续读，跨章节不停
- **句子高亮跟读**：朗读时高亮当前句并自动滚动；点击正文任意位置即可从该句开始
- **断点续读**：记录阅读进度（章节 + 句子 + CFI），下次打开回到原处
- **两种朗读引擎**
  - **Piper**（推荐）：本地神经网络语音，完全离线，CPU 约 3 倍实时合成
  - **Web Speech**：系统 / 浏览器内置语音，Edge 上可免费使用微软在线自然音色
- **语音包管理**：应用内自动发现并下载语音（Hugging Face 官方仓库 + 社区来源），
  带进度条；按许可区分「可自由分发 → 一键下载」与「仅标注来源并提示自担风险」
- **阅读排版**：主题（夜间 / 日间 / 护眼）、字号、行距、行宽、字体、翻页方式均可调
- **局域网访问**：手机 / 平板 / 另一台电脑可连同一服务
- **无环境部署**：可打包成自带 Node + Python 运行时的便携包（约 545 MB），
  目标机免安装任何东西，双击 `start.bat` 即用

## 技术栈

| 层 | 选型 |
| --- | --- |
| 前端 | React 19 + Vite 7 + Tailwind CSS 4 + Zustand；正文由 epub.js 渲染 |
| 后端 | Node 22 + Fastify 5；用 Node 内置类型擦除直接运行 TS，无额外构建步骤 |
| 语音 | Piper（`piper-tts` + ONNX Runtime CPU）Python sidecar；不可用时回退 Web Speech |
| 存储 | 本地文件系统（`data/` 存 EPUB 与进度，无数据库） |

**建议用 Edge 打开**：它的系统语音音色（中文）明显好于 Chrome 自带，
且长文本稳定性更好。

## 快速开始

```bash
pnpm install        # 首次
pnpm dev            # 同时启动接口服务(8787)与前端(5173)
```

然后打开 <http://localhost:5173>，把 EPUB 拖进页面，点封面开始阅读。

## 无环境部署（便携包）

目标机器**不需要**安装 Node.js、Python、CUDA —— 全部运行时都打进包里，
只需 Windows 10/11 64 位。实测包体 **约 545 MB**（未压缩）。

```bash
pnpm build                        # 先构建前端
pnpm build:portable               # 打包（默认输出到项目同级的 epubtospeech-portable）
node scripts/build-portable.mjs --out /path/to/out --voices all --zip  # 指定输出并压缩
```

产物结构：

```
epubtospeech-portable/
├── node/           便携 Node.js（约 94 MB）
├── python/         便携 Python + CPU-only 依赖（约 215 MB）
├── app/
│   ├── src/        服务端源码
│   ├── dist/web/   前端页面
│   ├── models/piper/  语音模型（chaowen + g2pW，约 214 MB）
│   ├── node_modules/  后端生产依赖（约 10 MB）
│   └── data/       书库（空）
├── start.bat       启动（后台起两个服务 + 自动开浏览器）
├── stop.bat        停止（释放 8787 / 8788）
└── 使用说明.txt
```

目标机操作：拷整个目录 → 双击 `start.bat` → 浏览器自动打开
<http://127.0.0.1:8787>（生产模式下由 API 服务直接托管前端，不需要 Vite）。

### 为什么能这么小

| 削减项 | 节省 | 原因 |
| --- | --- | --- |
| CUDA/cuDNN/cuBLAS 等 `nvidia-*` + `onnxruntime-gpu` | **约 2.4 GB** | Piper 走 CPU 推理，改用 `onnxruntime` CPU 版（44 MB） |
| Kokoro 遗留依赖（`kokoro-onnx`、`misaki`、`jieba`、`pypinyin` 等） | 约 300 MB | 该引擎已移除 |
| `pip` 与 `__pycache__` | 约 11 MB | 部署包不需要包管理器 |
| 语音模型（只带 chaowen + g2pW） | 约 120 MB | xiao_ya 非商业、huayan 许可未知，不随包分发 |

构建输入缓存在 `.tmp/`（便携 Node zip、Python embeddable、CPU-only venv、
生产依赖），可重复打包；这些随时可删，重新执行构建命令前按脚本提示补齐即可。

### 实测（便携包，纯 CPU）

```text
语音加载（含 g2pW 初始化）  约 7 s（仅首次）
热请求合成                  0.64~0.80 s / 2.4 s 音频  ≈ 3.1~3.7x 实时
首次合成出声                约 2~3 s（服务启动时已预热）
```

### 阅读器快捷键

| 按键 | 作用 |
| --- | --- |
| 空格 | 播放 / 暂停朗读 |
| → | 下一句 |
| ← | 上一句 |
| Esc | 关闭目录、设置面板或点击菜单 |
| 点击正文 | 弹出操作菜单（从这里朗读 / 从本章开头朗读） |

播放条的左右按钮切换的是**章节**（不是句子）；句子级微调用 ←/→ 键。
目录打开时会自动滚动到**当前章节**位置，而不是从第一条开始。

### 单独启动

```bash
pnpm dev:api        # 只起接口服务  http://127.0.0.1:8787
pnpm dev:web        # 只起前端      http://localhost:5173
```

### 局域网访问（手机 / 平板 / 另一台电脑）

```bash
pnpm dev:lan        # 监听 0.0.0.0，局域网内其他设备可访问
```

启动后在同网络的设备上打开 `http://<这台电脑的IP>:5173`（用 `ipconfig` 查 IPv4 地址）。

**还需要放行 Windows 防火墙**（需管理员权限，普通账号会被拒绝）。
以**管理员身份**打开 PowerShell 执行：

```powershell
New-NetFirewallRule -DisplayName "EPUB朗读器 5173" -Direction Inbound -Action Allow `
  -Protocol TCP -LocalPort 5173 -Profile Private
```

只需要放行 5173：前端的 `/api` 请求由 Vite 内部代理到本机的 8787，
所以 8787 不必对外暴露。若想让设备直连接口（例如自己写脚本调用），再额外放行 8787。

删除规则：

```powershell
Remove-NetFirewallRule -DisplayName "EPUB朗读器 5173"
```

> ⚠️ **安全提醒**：本应用**没有登录与认证**，任何能访问到该端口的人都可以
> 查看、上传、删除你的全部书籍。请只在可信局域网内开启（Windows 网络类别需为
> 「专用网络」），**绝不要**用端口映射或内网穿透把它暴露到公网。
> 开启后接口会打印醒目警告，同时放行跨源请求（供其他来源的前端调用）。

### 生产构建

```bash
pnpm build          # 输出到 dist/web
pnpm start          # 接口服务顺带托管 dist/web，单端口访问
```

## 目录结构

```
src/
  shared/book.ts          前后端共享类型（BookMeta / ReadingProgress / API 契约）
  server/
    index.ts              Fastify 启动、multipart、静态托管与 SPA 回退
    paths.ts              数据目录与端口配置
    ids.ts                sha256 → 书籍 id、epub 结构校验
    storage.ts            仓储层：index.json + books/ + covers/（原子写、串行化、回滚）
    routes/books.ts       书库 REST 接口
  web/
    api.ts                接口客户端（带错误码的 ApiError）
    App.tsx               hash 路由（书架 ↔ 阅读器），阅读器按需加载
    epub/parseEpub.ts     EPUB 元数据解析（书名/作者/语言/封面/目录/章节数）
    tts/
      types.ts            ★ TTS 引擎抽象层（换在线引擎只需加一个实现）
      WebSpeechEngine.ts  系统语音实现，处理 5 个已知浏览器坑
      chunk.ts            分句切块（缩写/小数点保护、短句合并、超长二次切分）
      speech.ts           朗读文本归一化 + 时长估算（看门狗用）
      range.ts            字符偏移 ↔ DOM Range、空白折叠偏移修正
      player.ts           播放队列 + EngineDriver（下标换算）+ 双看门狗
    reader/
      sentences.ts        ★ 句子抽取：把整章拼成朗读文本并保留精确的 DOM 坐标
      highlight.ts        句子高亮（覆盖层，不改动书籍 DOM）+ 自动跟随滚动
      session.ts          ★ 阅读会话：串起 epub.js / 高亮 / 播放 / 进度回写
    store/
      library.ts          书库状态与导入流水线
      readerPrefs.ts      阅读偏好（主题/字号/语速/音色），持久化到 localStorage
    pages/
      LibraryPage.tsx     书架：拖拽导入、搜索排序、删除确认
      ReaderPage.tsx      阅读器：目录抽屉、设置面板、播放条、快捷键
data/                     运行时数据（已 gitignore）
  index.json              书库索引
  books/<id>.epub         书籍原文
  covers/<id>.bin         封面二进制
```

## 朗读是怎么工作的

这是本项目最核心的一条链路，四个坐标系必须严格对齐，否则高亮会越读越偏：

```
DOM 文本节点
  → (sentences.ts) 拼成「整章朗读文本」，记录每个文本节点的累计下标
  → (chunk.ts)     按标点切成句子，句子 = [start, end) 区间
  → (Player)       逐句送进引擎
  → (session.ts)   用句子区间反查出 DOM Range
  → (highlight.ts) 用 Range 定位覆盖层并滚动跟随
```

两个容易被忽略但决定成败的点：

1. **`chunkText` 会去掉句首尾空白**，所以 chunk 的 `[start,end)` 比它的 `text` 更宽。
   这段空白必须一并写进朗读文本，否则后面所有坐标整体偏移。
2. **引擎看到的文本是规范化过的**（连续空白折叠成一个空格），
   所以 `onboundary` 报的下标要先用 `speech.ts` 的映射换算回原始下标，
   再交给 `range.ts` / `sentences.ts` 定位。

看门狗：引擎可能既不报 `onstart` 也不报 `onend`（系统语音服务异常时常见），
`Player` 用两个定时器兜底，超时后强行推进，保证不会永远卡在某一句话上。

## 关于离线语音

本项目支持 [Piper](https://github.com/rhasspy/piper) 作为离线 CPU 神经网络语音。
使用 `piper-tts` Python 包（`scripts/piper-server.py` 直接调用其 API），
中文模型走两种音素路线：

| 模型 | 音素 | 速度（实测） | 说明 |
| --- | --- | --- | --- |
| Piper `zh_CN-chaowen-medium` | 拼音 g2pW | 热请求 1.4~2x 实时 | 推荐，中文查表清晰 |
| Piper `zh_CN-xiao_ya-medium` | 拼音 g2pW | 约 1.2~1.5x 实时 | 与 chaowen 同路线 |
| Piper `zh_CN-huayan-medium` | espeak cmn | 约 2x 实时 | 老模型，中文自然度一般 |

安装与模型准备：

```bash
# 1. 安装 piper-tts 及其中文依赖（在 .venv-tts 内）
.venv-tts\Scripts\pip install piper-tts sentence-stream unicode-rbnf transformers --no-deps
.venv-tts\Scripts\pip install httpx charset-normalizer urllib3 tokenizers huggingface-hub

# 2. 下载中文模型到 models/piper/（ONNX + 同名 .onnx.json 成对）
#    首选直接在应用内完成：书架 →「语音包」→ 下载（自动探测
#    huggingface.co/rhasspy/piper-voices，直连失败自动回退 hf-mirror.com 镜像，
#    下载带进度条，完成后自动放入 models/piper）。
#    也可手动下载到以下路径：
#    huggingface.co/rhasspy/piper-voices 或国内镜像 hf-mirror.com，
#    路径 zh/zh_CN/<voice>/medium/zh_CN-<voice>-medium.onnx(.json)

# 3. g2pW 查表数据（chaowen/xiao_ya 需要）：
#    pip download g2pw --no-deps，从 wheel 内提取 3 个查表 JSON 到
#    models/piper/_resources/g2pW/；或者从
#    huggingface.co/datasets/rhasspy/piper-checkpoints .../zh/zh_CN/_resources/g2pw.tar.gz
#    解压到 models/piper/_resources/g2pW/
```

语音包的许可不同，应用内「语音包」页面按许可决定交互：

- `zh_CN-chaowen-medium`（CC0 公有领域）→ 一键直接下载
- `zh_CN-xiao_ya-medium`（BZNSYP 数据集，非商业）→ 仍可下载，但下载前弹确认框
  提示许可与自担风险
- `zh_CN-huayan-medium`（HuaYan，许可未知）→ 同上，下载前确认
- 页面自动抓取更多语音模型：
  - **官方全部变体**：递归探测 rhasspy/piper-voices 的 zh/zh_CN 目录，
    自动列出 medium / x_low 等所有质量变体
  - **社区发现**：用 Hugging Face 搜索 API 自动找出下载量非零的 piper 中文
    社区仓库（如 Trelis、speaches-ai 镜像），逐个探测文件，含完整
    `.onnx + .onnx.json` 的可一键下载；缺配置文件的仓库如实显示
- 页面底部"从 URL 安装"：支持粘贴任意 `.zip`（自动解压出 .onnx/.onnx.json）
  或单个 `.onnx` / `.onnx.json` 链接，带进度条下载并安装到 `models/piper`。

所有下载（一键或 URL）都由前端弹出进度条任务、轮询到完成；完成后刷新页面即可
在播放条音色下拉里看到新语音。下载均为后台流式 + 直连失败自动回退
hf-mirror.com 镜像。

其他踩过的坑：

- **别用 `synthesize_wav`**：它对部分模型不写声道数，`wave` 模块关闭时报
  `# channels not specified`。自己组装 WAV 头更可靠。
- **模型可用性要实测**：装得上不等于用得了，得真跑一次极短合成验证。
- **g2pW 需要查表数据**：`PiperVoice.load(..., download_dir=...)` 会在
  `download_dir/g2pW` 下找 3 个查表 JSON，缺了会报
  `Chinese lookup tables not found`。sidecar 默认把资源目录设在
  `models/piper/_resources`。

想要比浏览器内置更好的中文音色，**现实路径是在线 TTS 服务**（音色接近微软晓晓、
多设备一致、可导出音频，代价是需要 API Key 与联网）。引擎抽象层（`src/web/tts/`）
就是为这件事留的：实现 `TtsEngine` 接口即可，播放队列与高亮逻辑都不用改。

## 语音音色

**用 Edge 打开音色最好。** Edge 通过标准的 Web Speech API 额外暴露了大量`Microsoft xxx Online (Natural)` 神经网络音色——不需要任何 API Key、完全免费。
实测可提供 **300+ 个音色**，其中中文普通话在线音色十余个（晓晓、云希、云健、晓伊、
云扬、云夏，以及东北/陕西口音等）。用 `pnpm check:voices` 可以列出并逐个试读。

局限：这些音色是**浏览器/设备级**的，只在本机 Edge 可用。
手机或平板打开时用的是那台设备自己的系统语音（通常是 `Microsoft Huihui` 这类
本地音色，音质差一档）。若要多设备音色一致，需要接在线 TTS 服务——
引擎抽象层（`src/web/tts/`）就是为这件事留的：实现 `TtsEngine` 接口即可，
播放队列、句子切分与高亮逻辑都不用改。

### 引擎抽象层现状

`TtsEngineKind` 目前支持 `'webspeech'` 和 `'piper'`。Piper 需要本机 CPU sidecar，
默认不自动启动。保留下来的部分：

- `src/web/tts/types.ts` 的 `TtsEngine` 接口
- `EngineDriver`（负责文本归一化与下标映射）与 `Player` 队列
- `Player.onPrefetch` 钩子（"先合成再播放"的引擎需要它预生成后续句子）
- 偏好里的 `ttsEngine` 字段与 URL 参数 `?engine=`；旧值未知时自动回落到内置引擎

Piper 启动：

```bash
pnpm piper:server
pnpm dev
```

Piper 使用本机 CPU，按句生成 WAV；音色来自 `models/piper/*.onnx` 及其同名 `.onnx.json`。
当前为句子级高亮，不伪造词级边界。Piper 的语速、音量由阅读器播放参数控制；模型
本身的音质取决于所下载或训练的中文音色。切换音色会重新加载模型（约几秒），
同一音色连续朗读时模型常驻，实测 1.4~2x 实时。

Piper 额外提供两个合成参数（阅读器设置面板 → Piper 音色微调）：
- **音色稳定度**（`noise_scale`，默认 0.667）：越小发音越沉稳，越大越有表现力
- **韵律起伏**（`noise_w_scale`，默认 0.8）：越大语调抑扬越明显

两者实时生效并持久化；参数已实测确认生效（改动后波形差异为同参数复现差异的
数千倍），缓存 key 含这两项，调整后旧音频自动失效重合成。
新增引擎时只需实现接口并在 `ReaderSession` 构造处按 `engineKind` 分支，
不需要动高亮与断点续读。

音色下拉框会按以下顺序分组，并把与书本语言匹配的排在最前：

```
当前使用（1）
匹配本书语言（14）      ← 中文书就列出中文音色
其他中文（0）
本机语音（n）
在线自然语音（80）
另有 N 个音色未列出      ← 其余语言/地区折叠，避免 324 项平铺无法使用
```

## 章节定位：两个容易错的点

**目录项数与 spine 节数并不总相等。** 本项目测试用的 epub 有 1516 个 spine 节，
但目录只有 1514 项（前两节是封面类内容，不在目录里），于是「目录第 i 项」与
「第 i 节正文」整体错开 2 位。**绝不能用一个序号同时给目录和正文定位**：

- 章节标题：按 href 匹配（`labelsByHref`），与序号偏移无关
- 目录高亮：同样按 href 匹配（`normalizeHref` 归一化后比较）
- 只有 href 也匹配不到时才退化为序号

**epub.js 的 `display()` 必须传字符串。** 目录里的 href 通常带 OPF 目录前缀
（`OEBPS/text00108.html`），而 epub.js 的 spine 键是 OPF 相对路径
（`text00108.html`），直接传会抛 `No Section Found`。所以要先经
`resolveSection()` 三级匹配（原样 → 归一化 → 只比文件名）解析出正确键，
再传**字符串**给 `display()`。

实测踩到的坑：传 section **对象**给 `display()` 时，它既不报错也不导航——
内容保持不变、`relocated` 不触发，看起来"点了没反应"。
所以 `waitForContent()` 还会校验"当前节是否已变成目标节"，
只判断"有文字"会把旧内容误判为成功（这个坑让排查多绕了很久）。

**跨章续读必须同时切画面。** `loadNextChapterChunks()` 有两件事要做：
把下一章的句子追加进播放队列，**并且** `display()` 切到下一节。
只做前者会出现"语音已经读到第二章、界面还停在第一章"。
另外它用当前 href 精确定位所在节再取下一节，不依赖 `state.chapterIndex`
（那个值可能还没被 `relocated` 更新，会导致跳过或重复一章）。

**切画面会触发 `onRendered`，它会重置播放队列——必须挡住。** 顺序是：

```
追加下一章句子 → isContinuation = true → display(下一节)
  → onRendered 命中 isContinuation 分支：只抽取正文、不碰播放队列
```

反过来的顺序（先 display 再追加）或漏掉这个保护，都会导致
`setChunks()` 把刚排好的句子清掉，表现就是"自动切到下一章后朗读就停了，
得手动再点一次播放"。保护分支里仍然要**抽取新章节正文**，
否则续读会拿旧章节的坐标去定位，高亮会跳到错误位置。

## 阅读排版：三个必须记住的坑

这部分踩过坑，改样式前务必先看：

1. **epub.js 的宽度反馈**。它给 `.epub-container` 设 `width: 100%`，同时又按自己量到的
   宽度给内部 stage 定宽，形成"内容撑宽容器"的反馈：实测容器比窗口宽 10px，
   整页出现常驻横向滚动条（看起来就像"文字超出了显示区域"）。
   修法是约束 stage 宽度 + 让宿主 `.epub-host` 裁掉溢出，**不要**把容器的
   `overflow` 设成 `hidden` —— 分页模式要靠容器内部横向滚动来翻列，
   设成 hidden 会导致后面的列永远看不到。

2. **排版样式必须在每次渲染后重新应用**。`open()` 里那次 `applySettings()` 跑在
   iframe 创建之前，那时 `getContents()` 还是空的；而偏好没变化时不会再触发应用。
   所以 `onRendered` 里也要调一次，否则正文永远是书的原始样式。

3. **书自带的 body 内边距优先级更高**。不少书在 `body` 上写了很大的左右内边距
   （实测 114px），会把正文挤成窄条。必须用 `!important` 的注入样式覆盖，
   这也是唯一需要 `!important` 的地方。

4. **行宽按视口百分比，不是固定像素**。原先固定 720px，在 1800px 的窗口里正文
   只占 40%，大屏显得很窄；而且浏览器放大后也不会跟着变。现在设置里存的是
   百分比（默认 82%），实际生效 `max-width: min(<pct>vw, 1800px)`，
   所以缩放窗口或拖动浏览器缩放时正文会实时跟随。
   旧版本存过 `maxWidth: 720` 的用户会自动迁移成约 51%（按 1400px 视口估算）。

`pnpm diagnose:layout` 会把这些数值直接量出来（正文宽度、左边界、页面横向溢出），
`pnpm check:settings` 则验证改行宽/字号/行距后正文是否真的跟着变，
并覆盖旧设置迁移、浏览器缩放、模拟手机宽度等场景。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| GET | `/api/books` | 书库列表（按最近阅读排序） |
| POST | `/api/books` | 上传 epub；multipart 字段 `file`（必填）、`cover`（可选） |
| GET | `/api/books/:id/file` | 取 epub 原文 |
| GET | `/api/books/:id/cover` | 取封面（无封面返回 404） |
| PATCH | `/api/books/:id/meta` | 回填元数据（书名/作者/目录/章节数等） |
| PUT | `/api/books/:id/progress` | 保存阅读进度 |
| DELETE | `/api/books/:id` | 删除书籍与本地文件 |

**书籍 id 就是 epub 内容的 sha256 前 32 位**，因此同一本书重复导入会命中同一 id，
服务端直接返回已有记录（`deduped: true`），不会重复占空间。

### 数据一致性取舍

- 上传顺序是「先写文件，再写索引」。若索引写入失败，会**回滚刚写的 epub 文件**，
  避免留下无索引的孤儿文件。
- 启动时只清理崩溃残留的 `.tmp` 临时文件，**不会**删除「索引里没有的 epub/封面」。
  这是有意为之：用户可能手工把书放进 `data/books/`，自动删除会造成静默数据丢失。
- 因此 `data/books/` 里若出现无索引文件，属于预期情况（例如索引被人工清理过），
  想清掉就手动删除，应用不会替你决定。

## 为什么元数据由前端解析

服务端只做「存取 + 校验」，不引入 epub 解析依赖。导入流程是：

1. 前端把文件 POST 上去 → 服务端算 sha256、去重、落盘，返回 BookMeta
2. 前端本地解析 epub（书名/作者/目录/封面）
3. 前端 PATCH 回填元数据，并单独上传封面

这样即使第 2、3 步失败，书也已经在库里，不会丢；只是标记为「元数据未解析」。

## 开发辅助脚本

### 日常命令

```bash
pnpm verify         # 一条命令跑完：类型检查 + 单元测试 + 前端冒烟 + 浏览器实测阅读器
pnpm test           # 71 项单元测试（分句/偏移/归一化/播放队列/引擎驱动/句子抽取）
pnpm typecheck      # 前后端类型检查
pnpm build          # 构建前端到 dist/web
pnpm build:portable # 打包无环境部署包（见上文「无环境部署」）
pnpm piper:server   # 启动本地语音合成 sidecar（自动探测 Python 解释器）
pnpm sample:epub    # 生成 .tmp/sample.epub（最小合法 EPUB，用于测试）
pnpm seed:book      # 把样例书导入书库并写入中文元数据，然后回读校验
pnpm check:utf8     # 中文 UTF-8 往返测试（上传 → PATCH → 回读 → 落盘）
```

### 浏览器实测（需先 `pnpm dev`，用无头 Edge + CDP）

| 命令 | 验证内容 |
| --- | --- |
| `pnpm check:reader` | 打开书籍、进入朗读、高亮出现、全程无未捕获异常 |
| `pnpm check:ui` | 目录定位、按钮切章、点击正文弹菜单 |
| `pnpm check:toc` | 目录跳转：标题、目录高亮、正文是否指向同一章 |
| `pnpm check:cross-chapter` | 跨章续读时画面是否跟着切换 |
| `pnpm check:settings` | 阅读设置是否真正作用到正文（行宽 / 字号 / 行距 / 分页） |
| `pnpm check:voices` | 音色列表与分组 |
| `pnpm check:piper` | Piper 端到端：引擎切换、音色列表、播放触发 |
| `pnpm check:piper-noise` | 音色微调滑杆 → 合成请求是否携带新参数 |
| `pnpm check:voices-lines-menu` | 语音包页 + 行距生效 + 弹窗定位 |
| `pnpm check:autodiscover` | 语音包自动发现（官方变体 + 社区来源） |
| `pnpm check:popup` | 点击正文弹窗：锚点位置 / 选中句高亮 / 关闭清理 |
| `pnpm diagnose:layout` | 排版诊断：量正文宽度与横向溢出 |
| `pnpm diagnose:toc` | 目录诊断：对照目录项与 OPF spine |

`check:reader` 是最接近"真实使用"的一条验证：它用无头 Edge 打开阅读器路由，
通过 CDP 订阅异常与网络请求，确认书籍文件被拉取、iframe 被渲染、点击播放后
播放条进入"正在朗读"、高亮覆盖层出现在 iframe 内，并且全程没有未捕获异常。

测试覆盖的内容（都是确定性断言，不依赖浏览器）：

| 文件 | 覆盖 |
| --- | --- |
| `test-tts.mjs` | 分句切块（缩写/小数/引号/长句二次切分）、偏移映射、空白折叠换算 |
| `test-player.mjs` | 播放队列（自动推进、跳句、暂停打断、看门狗、错误）、`EngineDriver` 下标换算 |
| `test-sentences.mjs` | 句子抽取（区间覆盖、跨块节点、跳过非正文）、点击定位、Range 还原 |

### 两个容易踩的测试环境坑（已在脚本里解决）

- Node 的类型擦除是**纯擦除**，不支持 `constructor(private readonly x)` 这类语法 →
  `scripts/lib/load-ts.mjs` 用 `stripTypeScriptTypes` 的 `transform` 模式转换后再加载，
  并把模块间的相对导入按**内容寻址**重写（避免陈旧产物导致"改代码不生效"）。
- `node --test` 会被残留定时器挂住 → 统一加 `--test-force-exit`。

另外提醒两点（本项目实际踩过）：

- **不要用 PowerShell 的 `Set-Content` 改源文件** —— 它按 ANSI/GBK 往返处理，
  会把 UTF-8 的中文与换行破坏掉。一律用编辑器或编辑工具改。
- **不要用 PowerShell 5.1 的 `Invoke-RestMethod -Body <字符串>` 发中文 JSON** ——
  它按本地代码页编码，中文会变成字面 `?`。需要时用 `pnpm check:utf8` 作为可靠基线。

## 工具链约束

以下几点是刻意为之的配置，改动时请留意原因：

1. **后端不需要构建** —— 直接用 Node 的内置 TypeScript 类型擦除运行 `.ts`，
   因此 `dev:api` / `start` 都带 `--experimental-strip-types --experimental-transform-types`。
   这样也避免了 tsx / esbuild 的运行时依赖。
2. **pnpm 缓存放在项目内** —— `.npmrc` 把 `cache` 与 `store-dir` 指向
   `.npm-cache` / `.pnpm-store`，便于随项目清理，也已加入 `.gitignore`。
3. **esbuild 的 postinstall 被显式禁用** —— 它的 `install.js` 只是做版本自检，
   在禁止管道 stdio 的受限环境里会因 `EPERM` 失败；平台二进制由可选依赖
   `@esbuild/win32-x64` 提供，不影响运行。
4. **`pnpm-workspace.yaml` 关闭了供应链门禁** —— pnpm 12 默认拦截「新近发布」的版本
   （`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`），本机工具场景下设 `minimumReleaseAge: 0`。
5. **`@vitejs/plugin-react` 必须留在 5.x** —— 6.x 的 peer 要求 Vite ^8，与当前 Vite 7 不兼容。

## 版本约束

- Node >= 20.19（依赖内置 TypeScript 类型擦除，建议 22.6+）
- Vite 7.x + `@vitejs/plugin-react` 5.x（不要升到 plugin-react 6）
- Python 3.12+（仅语音合成 sidecar 需要；便携包已内置运行时）

## 后续阶段

- **M4** 跟读增强：词级高亮（`EngineDriver` 已经把下标换算打通，只差 UI 渲染）、
  朗读时可选"每句后停顿"、段落级跳转
- **M5** 加固：导出音频（需要在线/本地模型引擎，接口已留 `synthesizeToFile` 能力位）、
  书签与笔记、全文搜索、跨设备进度同步
- **可选** 接入在线 TTS：只需实现 `TtsEngine` 接口并注册到 `createDefaultEngine`，
  播放队列与高亮逻辑不用改

## 许可

本项目代码采用 **MIT License**（见 [LICENSE](LICENSE)）。

### 第三方组件

| 组件 | 许可 |
| --- | --- |
| React / Fastify / Zustand | MIT |
| epub.js | BSD-2-Clause |
| Piper（`piper-tts`、模型格式） | MIT |
| ONNX Runtime | MIT |
| g2pW 中文查表数据 | Apache-2.0 |

### 语音模型的许可（重要）

语音模型**不随本仓库分发**（体积大且许可各异）。应用内「语音包」页按下列情况处理：

| 语音 | 许可 | 应用内行为 |
| --- | --- | --- |
| `zh_CN-chaowen-medium` | **CC0 公有领域** | 可一键下载，可自由再分发 |
| `zh_CN-xiao_ya-medium` | 非商业（BZNSYP / DataBaker 数据集） | 下载前弹确认框，提示自担风险 |
| `zh_CN-huayan-medium` | 未知（PlayVoice/HuaYan_TTS） | 同上 |
| 社区来源（HF 搜索发现） | 未标注 | 同上，界面标注来源 |

**若你要分发自己打包的版本**，建议只附带 `chaowen`（CC0），
其余语音让使用者在应用内自行下载。

### 阅读内容

本工具只做本地解析与朗读，不附带任何书籍内容；
`data/` 目录（用户导入的 EPUB）已被 `.gitignore` 排除，不会进入仓库。

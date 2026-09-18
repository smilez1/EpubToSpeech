/**
 * 生成一个最小但结构合法的 EPUB，用于端到端验证。
 *
 * 用 JSZip 而不是 PowerShell 的 ZipFile.CreateFromDirectory：
 * 后者在 Windows 上会写出含反斜杠的条目名（`META-INF\container.xml`），
 * 而 EPUB/OPF 规范要求正斜杠分隔，JSZip 会按传入字符串原样写成正斜杠。
 *
 * 用法：node scripts/make-sample-epub.mjs [输出路径]
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import JSZip from 'jszip';

const out = resolve(process.argv[2] ?? resolve(import.meta.dirname, '../.tmp/sample.epub'));

const CONTAINER = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

const OPF = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:test-0001</dc:identifier>
    <dc:title>测试书籍：语音朗读样例</dc:title>
    <dc:creator>测试作者</dc:creator>
    <dc:language>zh-CN</dc:language>
    <dc:publisher>本地测试</dc:publisher>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ch1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="chapter2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>`;

const NAV = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>目录</title></head>
<body>
  <nav epub:type="toc" id="toc">
    <ol>
      <li><a href="chapter1.xhtml">第一章 起点</a></li>
      <li><a href="chapter2.xhtml">第二章 途中</a></li>
    </ol>
  </nav>
</body>
</html>`;

const CH1 = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>第一章 起点</title></head>
<body>
  <h1>第一章 起点</h1>
  <p>这是一段用于测试的正文。朗读功能需要把这些句子逐条送进语音合成引擎。</p>
  <p>第二段文字更短一些，用来观察分句是否正确。</p>
</body>
</html>`;

const CH2 = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>第二章 途中</title></head>
<body>
  <h1>第二章 途中</h1>
  <p>自动翻页连续朗读时，读到当前页末尾应当翻到下一页继续。</p>
</body>
</html>`;

const zip = new JSZip();
// 规范要求 mimetype 是第一个条目且不压缩
zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
zip.file('META-INF/container.xml', CONTAINER);
zip.file('OEBPS/content.opf', OPF);
zip.file('OEBPS/nav.xhtml', NAV);
zip.file('OEBPS/chapter1.xhtml', CH1);
zip.file('OEBPS/chapter2.xhtml', CH2);

const buf = await zip.generateAsync({
  type: 'nodebuffer',
  compression: 'DEFLATE',
  compressionOptions: { level: 6 },
});

await mkdir(dirname(out), { recursive: true });
await writeFile(out, buf);
console.log(`已生成 ${out}（${buf.length} 字节）`);

// 回读校验条目名分隔符，防止再次踩到反斜杠的坑
const verify = await JSZip.loadAsync(buf);
console.log('条目：');
for (const name of Object.keys(verify.files)) console.log(`  ${name}`);

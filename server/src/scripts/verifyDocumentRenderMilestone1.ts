import '../env';
import express from 'express';
import JSZip from 'jszip';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DOCX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const DEFAULT_BASE_URL = 'http://127.0.0.1:3000';
const CUSTOMER = '上海测试科技有限公司';
const AMOUNT = '12800 元';
const DATE = '2026-05-12';

type JsonObject = Record<string, unknown>;

type VerifyConfig = {
  baseUrl: string;
  templateUrl: string;
  expectedStorage: string;
  outputPath: string;
  reportPath: string;
  repeat: number;
  concurrency: number;
};

type TemplateServer = {
  url: string;
  close: () => Promise<void>;
};

type Summary = {
  ok: boolean;
  milestoneRunId?: string;
  baseUrl?: string;
  storage?: string;
  requestId?: string;
  downloadBytes?: number;
  generatedFile?: string;
  reportFile?: string;
  checks?: string[];
  stability?: {
    sequential: CountSummary;
    concurrent: CountSummary;
  };
  error?: string;
};

type CountSummary = {
  total: number;
  ok: number;
  p95Ms: number;
  maxMs: number;
};

function getEnvNumber(name: string, fallback: number): number {
  const rawValue = (process.env[name] || '').trim();
  if (!rawValue) {
    return fallback;
  }
  const parsed = Number(rawValue);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function getConfig(): VerifyConfig {
  const baseUrl = (process.env.DOCUMENT_RENDER_VERIFY_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const repeat = getEnvNumber('DOCUMENT_RENDER_VERIFY_REPEAT', 500);
  const concurrency = getEnvNumber('DOCUMENT_RENDER_VERIFY_CONCURRENCY', 20);
  return {
    baseUrl,
    templateUrl: (process.env.DOCUMENT_RENDER_VERIFY_TEMPLATE_URL || '').trim(),
    expectedStorage: (process.env.DOCUMENT_RENDER_VERIFY_EXPECT_STORAGE || '').trim(),
    outputPath: (process.env.DOCUMENT_RENDER_VERIFY_OUTPUT_PATH || '').trim(),
    reportPath: (process.env.DOCUMENT_RENDER_VERIFY_REPORT_PATH || '').trim(),
    repeat,
    concurrency,
  };
}

function fail(message: string): never {
  throw new Error(message);
}

function escapeXml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function createTemplateDocx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>
  <Override PartName="/word/fontTable.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml"/>
  <Override PartName="/word/webSettings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.webSettings+xml"/>
  <Override PartName="/word/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
  <Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>
  <Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>
</Types>`);
  zip.folder('_rels')?.file('.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`);
  zip.folder('word')?.folder('_rels')?.file('document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rHeader1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>
  <Relationship Id="rFooter1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>
  <Relationship Id="rStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rSettings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>
  <Relationship Id="rFontTable" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/fontTable" Target="fontTable.xml"/>
  <Relationship Id="rTheme" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>
  <Relationship Id="rWebSettings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/webSettings" Target="webSettings.xml"/>
</Relationships>`);
  zip.folder('docProps')?.file('core.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>Docx API 里程碑 1 验收模板</dc:title><dc:creator>larkdocvar</dc:creator><cp:lastModifiedBy>larkdocvar</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">2026-05-12T00:00:00Z</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">2026-05-12T00:00:00Z</dcterms:modified></cp:coreProperties>`);
  zip.folder('docProps')?.file('app.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Microsoft Office Word</Application><DocSecurity>0</DocSecurity><ScaleCrop>false</ScaleCrop><LinksUpToDate>false</LinksUpToDate><SharedDoc>false</SharedDoc><HyperlinksChanged>false</HyperlinksChanged><AppVersion>16.0000</AppVersion></Properties>`);
  zip.folder('word')?.file('document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    <w:p><w:r><w:rPr><w:rFonts w:ascii="SimSun" w:eastAsia="SimSun"/><w:b/><w:color w:val="FF0000"/><w:sz w:val="28"/></w:rPr><w:t>客户：{{客户名称}}</w:t></w:r></w:p>
    <w:p><w:r><w:t>{{客</w:t></w:r><w:r><w:t>户名称}}</w:t></w:r><w:r><w:t> / {{金额}}</w:t></w:r></w:p>
    <w:tbl><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4"/></w:tblBorders></w:tblPr><w:tr><w:tc><w:p><w:r><w:t>金额：{{金额}}</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
    <w:sectPr><w:headerReference w:type="default" r:id="rHeader1"/><w:footerReference w:type="default" r:id="rFooter1"/></w:sectPr>
  </w:body>
</w:document>`);
  zip.folder('word')?.file('styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:eastAsia="SimSun"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault/></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style></w:styles>`);
  zip.folder('word')?.file('settings.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:zoom w:percent="100"/><w:defaultTabStop w:val="720"/><w:compat/></w:settings>`);
  zip.folder('word')?.file('fontTable.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:fonts xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:font w:name="Arial"/><w:font w:name="SimSun"/></w:fonts>`);
  zip.folder('word')?.file('webSettings.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:webSettings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:optimizeForBrowser/></w:webSettings>`);
  zip.folder('word')?.folder('theme')?.file('theme1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme"><a:themeElements><a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F497D"/></a:dk2><a:lt2><a:srgbClr val="EEECE1"/></a:lt2><a:accent1><a:srgbClr val="4F81BD"/></a:accent1><a:accent2><a:srgbClr val="C0504D"/></a:accent2><a:accent3><a:srgbClr val="9BBB59"/></a:accent3><a:accent4><a:srgbClr val="8064A2"/></a:accent4><a:accent5><a:srgbClr val="4BACC6"/></a:accent5><a:accent6><a:srgbClr val="F79646"/></a:accent6><a:hlink><a:srgbClr val="0000FF"/></a:hlink><a:folHlink><a:srgbClr val="800080"/></a:folHlink></a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Cambria"/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/></a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst/><a:lnStyleLst/><a:effectStyleLst/><a:bgFillStyleLst/></a:fmtScheme></a:themeElements></a:theme>`);
  zip.folder('word')?.file('header1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>页眉：{{客户名称}}</w:t></w:r></w:p></w:hdr>`);
  zip.folder('word')?.file('footer1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>页脚：{{日期}}</w:t></w:r></w:p></w:ftr>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function startTemplateServer(buffer: Buffer): Promise<TemplateServer> {
  const app = express();
  app.get('/template.docx', (_request, response) => {
    response.setHeader('Content-Type', DOCX_CONTENT_TYPE);
    response.send(buffer);
  });

  const server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo | null;
  if (!address) {
    fail('模板服务器启动失败。');
  }

  return {
    url: `http://127.0.0.1:${address.port}/template.docx`,
    close: () => closeServer(server),
  };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function postJson(url: string, payload: JsonObject): Promise<{ status: number; body: JsonObject }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return {
    status: response.status,
    body: await response.json() as JsonObject,
  };
}

function buildPayload(templateUrl: string, index = 0): JsonObject {
  return {
    template: {
      format: 'docx',
      title: 'Docx API 里程碑 1 验收模板',
      url: templateUrl,
    },
    variables: {
      客户名称: index ? `${CUSTOMER}-${index}` : CUSTOMER,
      金额: index ? `${12800 + index} 元` : AMOUNT,
      日期: DATE,
    },
    output: {
      fileName: `Docx API 验收-${index || 'single'}.docx`,
      expiresInSeconds: 3600,
    },
  };
}

function assertOkResponse(status: number, body: JsonObject): void {
  if (status !== 200 || body.ok !== true) {
    fail(`生成接口失败：status=${status}, error=${String(body.error || '未知错误')}`);
  }
  for (const field of ['requestId', 'document', 'variables', 'download']) {
    if (!(field in body)) {
      fail(`成功响应缺少字段：${field}`);
    }
  }
  const document = body.document as JsonObject | undefined;
  const variables = body.variables as JsonObject | undefined;
  const download = body.download as JsonObject | undefined;
  for (const field of ['title', 'previewText']) {
    if (typeof document?.[field] !== 'string') {
      fail(`document 缺少稳定字段：${field}`);
    }
  }
  for (const field of ['found', 'missing', 'provided', 'unused']) {
    if (!Array.isArray(variables?.[field])) {
      fail(`variables 缺少稳定字段：${field}`);
    }
  }
  for (const field of ['url', 'path', 'fileName', 'contentType', 'storage', 'createdAt', 'expiresAt']) {
    if (typeof download?.[field] !== 'string') {
      fail(`download 缺少稳定字段：${field}`);
    }
  }
  if (typeof download?.size !== 'number') {
    fail('download 缺少稳定字段：size');
  }
}

function verifyDownloadTtl(body: JsonObject, expectedSeconds: number): void {
  const download = body.download as JsonObject | undefined;
  const createdAt = Date.parse(String(download?.createdAt || ''));
  const expiresAt = Date.parse(String(download?.expiresAt || ''));
  if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt)) {
    fail('download.createdAt 或 download.expiresAt 不是有效时间。');
  }
  const deltaMs = expiresAt - createdAt;
  if (deltaMs < expectedSeconds * 1000 - 3000 || deltaMs > expectedSeconds * 1000 + 3000) {
    fail(`下载链接有效期不符合预期：expected=${expectedSeconds}s actual=${Math.round(deltaMs / 1000)}s`);
  }
}

function getDownloadUrl(baseUrl: string, body: JsonObject): string {
  const download = body.download as JsonObject | undefined;
  const rawUrl = typeof download?.url === 'string' ? download.url : '';
  if (!rawUrl) {
    fail('成功响应缺少 download.url。');
  }
  return new URL(rawUrl, baseUrl).toString();
}

async function downloadAndInspect(
  baseUrl: string,
  body: JsonObject,
  outputPath: string,
): Promise<{ bytes: number; checks: string[]; outputPath?: string }> {
  const downloadUrl = getDownloadUrl(baseUrl, body);
  const response = await fetch(downloadUrl);
  if (response.status !== 200) {
    fail(`下载生成文件失败：status=${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (outputPath) {
    await writeFile(outputPath, buffer);
  }
  const zip = await JSZip.loadAsync(buffer);
  const xmlParts = await Promise.all(['word/document.xml', 'word/header1.xml', 'word/footer1.xml'].map((name) => {
    return zip.file(name)?.async('string') || '';
  }));
  const combined = xmlParts.join('\n');
  const requiredTexts = [CUSTOMER, AMOUNT, DATE];
  for (const text of requiredTexts) {
    if (!combined.includes(escapeXml(text))) {
      fail(`生成文件缺少替换后的内容：${text}`);
    }
  }
  if (/\{\{[^{}]+?\}\}/.test(combined)) {
    fail('生成文件仍残留变量占位符。');
  }
  if (!combined.includes('<w:rFonts w:ascii="SimSun" w:eastAsia="SimSun"/>') || !combined.includes('<w:b/>') || !combined.includes('<w:color w:val="FF0000"/>') || !combined.includes('<w:sz w:val="28"/>') || !combined.includes('<w:tblBorders>')) {
    fail('生成文件没有保留基础样式或表格边框。');
  }
  await verifyDocxOpensWithTextutil(buffer);

  return {
    bytes: buffer.length,
    checks: ['download-ok', 'docx-opened-as-zip', 'docx-opened-by-textutil', 'variables-replaced', 'no-placeholders', 'style-kept'],
    outputPath: outputPath || undefined,
  };
}

async function verifyDocxOpensWithTextutil(buffer: Buffer): Promise<void> {
  const tempDir = await mkdtemp(join(tmpdir(), 'larkdocvar-docx-verify-'));
  const docxPath = join(tempDir, 'generated.docx');
  try {
    await writeFile(docxPath, buffer);
    const { stdout } = await execFileAsync('/usr/bin/textutil', ['-convert', 'txt', '-stdout', docxPath], {
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 5 * 1024 * 1024,
    });
    for (const text of [CUSTOMER, AMOUNT]) {
      if (!stdout.includes(text)) {
        fail(`textutil 打开生成文件后缺少内容：${text}`);
      }
    }
    if (stdout.includes('{{')) {
      fail('textutil 打开生成文件后仍看到变量占位符。');
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('textutil 打开')) {
      throw error;
    }
    fail(`textutil 无法打开生成文件：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function verifyMissingVariables(baseUrl: string, templateUrl: string): Promise<void> {
  const payload = buildPayload(templateUrl);
  const variables = payload.variables as JsonObject;
  delete variables['金额'];
  const { status, body } = await postJson(`${baseUrl}/api/v1/document-renders`, payload);
  if (status !== 400 || body.ok !== false || !Array.isArray(body.missingVariables)) {
    fail('缺失变量响应不符合预期。');
  }
  if (typeof body.requestId !== 'string' || typeof body.error !== 'string') {
    fail('缺失变量响应缺少 requestId 或 error。');
  }
  if (!(body.missingVariables as unknown[]).includes('金额')) {
    fail('缺失变量响应没有列出“金额”。');
  }
}

async function verifyUnusedVariables(baseUrl: string, templateUrl: string): Promise<void> {
  const payload = buildPayload(templateUrl);
  const variables = payload.variables as JsonObject;
  variables['不存在字段'] = '不应被忽略';
  const { status, body } = await postJson(`${baseUrl}/api/v1/document-renders`, payload);
  if (status !== 400 || body.ok !== false || !Array.isArray(body.unusedVariables)) {
    fail('未使用变量响应不符合预期。');
  }
  if (typeof body.requestId !== 'string' || typeof body.error !== 'string') {
    fail('未使用变量响应缺少 requestId 或 error。');
  }
  if (!(body.unusedVariables as unknown[]).includes('不存在字段')) {
    fail('未使用变量响应没有列出“不存在字段”。');
  }
}

async function generateOnce(baseUrl: string, templateUrl: string, index: number): Promise<{ ok: boolean; ms: number }> {
  const start = performance.now();
  const { status, body } = await postJson(`${baseUrl}/api/v1/document-renders`, buildPayload(templateUrl, index));
  return {
    ok: status === 200 && body.ok === true,
    ms: performance.now() - start,
  };
}

function summarize(results: Array<{ ok: boolean; ms: number }>): CountSummary {
  const latencies = results.map((item) => item.ms).sort((a, b) => a - b);
  const p95Index = Math.max(0, Math.floor((latencies.length - 1) * 0.95));
  return {
    total: results.length,
    ok: results.filter((item) => item.ok).length,
    p95Ms: Math.round(latencies[p95Index] || 0),
    maxMs: Math.round(latencies[latencies.length - 1] || 0),
  };
}

async function verifyStability(baseUrl: string, templateUrl: string, repeat: number, concurrency: number): Promise<Summary['stability']> {
  const sequential: Array<{ ok: boolean; ms: number }> = [];
  for (let index = 0; index < repeat; index += 1) {
    sequential.push(await generateOnce(baseUrl, templateUrl, index + 1));
    if ((index + 1) % 500 === 0) {
      console.log(JSON.stringify({ progress: index + 1, total: repeat }));
    }
  }
  const concurrentResults = await Promise.all(Array.from({ length: concurrency }, (_, index) => {
    return generateOnce(baseUrl, templateUrl, repeat + index + 1);
  }));
  const sequentialSummary = summarize(sequential);
  const concurrentSummary = summarize(concurrentResults);
  if (sequentialSummary.ok !== sequentialSummary.total) {
    fail(`连续生成失败：${sequentialSummary.ok}/${sequentialSummary.total}`);
  }
  if (concurrentSummary.ok !== concurrentSummary.total) {
    fail(`并发生成失败：${concurrentSummary.ok}/${concurrentSummary.total}`);
  }
  if (sequentialSummary.p95Ms >= 5000 || concurrentSummary.p95Ms >= 5000) {
    fail(`p95 超过 5 秒：sequential=${sequentialSummary.p95Ms}ms concurrent=${concurrentSummary.p95Ms}ms`);
  }
  return {
    sequential: sequentialSummary,
    concurrent: concurrentSummary,
  };
}

async function verifyFrontendTitle(baseUrl: string): Promise<void> {
  const response = await fetch(baseUrl);
  const html = await response.text();
  if (!html.includes('<title>文档模板批量生成</title>')) {
    fail('页面标题不匹配，请确认 baseUrl 指向当前项目。');
  }
}

async function verifySecurityAndRegressionTestSources(): Promise<string[]> {
  const sourceChecks: Array<{ path: string; needles: string[]; check: string }> = [
    {
      path: 'server/src/documentRenderContract.test.ts',
      needles: [
        'Docx 成功响应字段契约保持稳定',
        'Docx API 会清洗 requestId 中的异常字符',
        'Docx 缺失变量错误响应字段契约保持稳定',
        'Docx 未使用变量错误响应字段契约保持稳定',
      ],
      check: 'document-render-contract-tests-present',
    },
    {
      path: 'server/src/documentRenderSecurity.test.ts',
      needles: [
        '模板链接安全检查会识别 IPv6 映射的本机和云元数据地址',
        '模板链接安全检查覆盖常见内网和保留地址段',
        '模板链接 URL 校验会拒绝非标准编码的内网地址',
        '模板链接固定 DNS lookup 会绑定校验时的域名',
        '公开 API 拒绝包含用户名或密码的模板链接',
        '公开 API 拒绝非 HTTP 或 HTTPS 的模板链接协议',
        '公开 API 遇到模板链接重定向次数过多时返回可读错误',
        '公开 API 遇到模板链接重定向缺少目标地址时返回可读错误',
        '公开 API 会重新校验模板重定向目标协议',
        '::ffff:169.254.169.254',
      ],
      check: 'document-render-security-tests-present',
    },
    {
      path: 'server/src/browserOriginGuard.test.ts',
      needles: [
        '浏览器来源校验允许服务端 API 调用不带 Origin 或 Referer',
        '浏览器来源校验拒绝不在白名单里的 Origin',
        'blocked-origin-request',
        '浏览器来源校验不拦截 GET 下载类请求',
      ],
      check: 'browser-origin-guard-tests-present',
    },
    {
      path: 'server/src/index.ts',
      needles: [
        'const enforceDocumentRenderBrowserOrigin = createMutationOriginGuard',
        "app.use('/api/v1/document-renders', enforceDocumentRenderBrowserOrigin, requireDocumentRenderApiKey, createDocumentRenderRouter",
      ],
      check: 'browser-origin-guard-mounted-present',
    },
    {
      path: 'server/src/documentRenderApi.test.ts',
      needles: ['Docx 回归模板库至少覆盖 20 种结构且全部不残留变量'],
      check: 'document-render-20-template-regression-present',
    },
    {
      path: 'docs/docx-regression-template-library.json',
      needles: ['"templates"', '"expectedVariables"', '合同-基础段落', '验收单-完整混合'],
      check: 'document-render-template-library-manifest-present',
    },
    {
      path: 'server/src/documentRenderSize.test.ts',
      needles: ['公开 API 支持接近 20MB 的合法 Docx 模板'],
      check: 'document-render-size-tests-present',
    },
    {
      path: 'server/src/documentRenderApi.ts',
      needles: [
        'maxContentLength: MAX_TEMPLATE_DOWNLOAD_BYTES',
        'maxBodyLength: MAX_TEMPLATE_DOWNLOAD_BYTES',
        'templateBuffer.length > MAX_TEMPLATE_DOWNLOAD_BYTES',
      ],
      check: 'document-render-size-tests-present',
    },
    {
      path: 'server/src/documentRenderErrors.test.ts',
      needles: [
        '公开 API 参数错误不暴露校验库细节',
        '公开 API 遇到 JSON 解析错误时返回稳定 JSON',
        '公开 API 遇到请求体过大时返回稳定 JSON',
        '公开 API 内部异常只返回统一可读错误',
        '公开 API 遇到残留占位符时不生成半成品',
      ],
      check: 'document-render-error-tests-present',
    },
    {
      path: 'server/src/documentRenderDownload.test.ts',
      needles: [
        '本地下载链接失效时返回稳定 requestId',
        '本地下载文件超过上限时会淘汰最旧链接',
        '本地下载链接支持单次配置 24 小时有效期',
        '环境变量配置的默认下载有效期会封顶 7 天',
        '公开 API 拒绝超过上限的下载有效期',
      ],
      check: 'document-render-download-ttl-tests-present',
    },
    {
      path: 'server/src/documentRenderApi.test.ts',
      needles: [
        '公开 API 遇到不完整 OSS 配置时不降级成本地存储',
        '生产环境没有 OSS 配置时不降级成本地存储',
        '公开 API 遇到不完整 TOS 配置时不降级成本地存储',
        '公开 API 有 OSS 存储时上传 Docx 并返回 OSS 临时下载链接',
        '公开 API 有 TOS 配置时上传 Docx 并返回 TOS 临时下载链接',
        '公开 API 遇到 OSS 上传失败时返回可读错误且不降级 local',
      ],
      check: 'document-render-storage-mode-tests-present',
    },
    {
      path: 'server/src/documentRenderOssConfig.test.ts',
      needles: [
        'Docx API OSS 配置读取支持常见环境变量别名',
        'Docx API OSS 配置读取遇到部分配置时返回可读错误',
        'Docx API TOS 配置读取支持生产对象存储链路',
      ],
      check: 'document-render-oss-config-alias-tests-present',
    },
    {
      path: 'server/src/documentRenderTosStorage.test.ts',
      needles: [
        'TOS 预签名下载 URL 符合官方 TOS4 查询参数格式',
        'TOS 存储上传 Docx 并返回带 TTL 的签名下载链接',
        'TOS 存储上传失败时返回用户可理解错误',
      ],
      check: 'document-render-tos-storage-tests-present',
    },
    {
      path: 'server/src/documentRenderOssStorage.test.ts',
      needles: [
        '内置 OSS 存储上传 Docx 并生成带 TTL 的签名下载链接',
        '内置 OSS 存储会清洗 requestId 中的路径片段',
        '内置 OSS 存储上传或签名失败时返回用户可理解错误',
      ],
      check: 'document-render-oss-storage-tests-present',
    },
    {
      path: 'server/src/documentRenderApi.test.ts',
      needles: [
        'Docx 替换覆盖正文、表格、页眉和页脚',
        '公开 API 可以替换 Docx 中跨文本节点的变量',
      ],
      check: 'document-render-docx-scope-tests-present',
    },
    {
      path: 'server/src/documentRenderApi.test.ts',
      needles: [
        '公开 API 遇到 Docx 未使用变量时不上传半成品',
        '公开 API 遇到 Docx 缺失变量时不上传半成品',
      ],
      check: 'document-render-no-half-finished-tests-present',
    },
    {
      path: 'server/src/documentRenderHeaderFooterMissingApi.test.ts',
      needles: ['公开 API 遇到页眉页脚缺失变量时不上传半成品'],
      check: 'document-render-no-half-finished-tests-present',
    },
    {
      path: 'server/src/documentRenderBoundaries.test.ts',
      needles: [
        'Docx 替换不会跨段落拼接半截变量',
        'Docx 替换会正确转义变量值中的 XML 特殊字符',
        'Docx 替换会保留变量值首尾空格',
        'Docx 拆分变量替换后保留起始文本节点样式',
        'Docx 替换支持表格、页眉、页脚里的拆分变量',
      ],
      check: 'document-render-boundary-tests-present',
    },
    {
      path: 'server/src/documentRenderApi.test.ts',
      needles: [
        '公开 API 遇到损坏 Docx 模板时返回可读错误',
        '公开 API 拒绝伪装成 Docx 的普通 zip 文件',
        '公开 API 拒绝缺少主文档关系的伪装 Docx',
        '公开 API 拒绝解压后体积异常的 Docx 模板',
      ],
      check: 'document-render-zip-safety-tests-present',
    },
  ];
  for (const item of sourceChecks) {
    const source = await readFile(item.path, 'utf8');
    const missingNeedle = item.needles.find((needle) => !source.includes(needle));
    if (missingNeedle) {
      fail(`回归测试源缺少验收项：${missingNeedle}`);
    }
  }
  return sourceChecks.map((item) => item.check);
}

async function verifyReadmeApiDocs(): Promise<string[]> {
  const readme = await readFile('README.md', 'utf8');
  const apiDoc = await readFile('docs/docx-api-integration.md', 'utf8');
  const runbook = await readFile('docs/docx-operator-runbook.md', 'utf8');
  const docChecks: Array<{ source: string; sourceName: string; needle: string; check: string }> = [
    { source: readme, sourceName: 'README', needle: '[docs/docx-api-integration.md](docs/docx-api-integration.md)', check: 'readme-api-reference-linked' },
    { source: apiDoc, sourceName: 'Docx API 参考文档', needle: 'curl -s http://localhost:3000/api/v1/document-renders', check: 'api-doc-curl-example-present' },
    { source: apiDoc, sourceName: 'Docx API 参考文档', needle: '"ok": true', check: 'api-doc-success-response-present' },
    { source: apiDoc, sourceName: 'Docx API 参考文档', needle: '"requestId"', check: 'api-doc-stable-fields-present' },
    { source: apiDoc, sourceName: 'Docx API 参考文档', needle: '"document"', check: 'api-doc-stable-fields-present' },
    { source: apiDoc, sourceName: 'Docx API 参考文档', needle: '"variables"', check: 'api-doc-stable-fields-present' },
    { source: apiDoc, sourceName: 'Docx API 参考文档', needle: '"download"', check: 'api-doc-stable-fields-present' },
    { source: apiDoc, sourceName: 'Docx API 参考文档', needle: '"missingVariables": ["金额"]', check: 'api-doc-missing-variable-example-present' },
    { source: apiDoc, sourceName: 'Docx API 参考文档', needle: '"unusedVariables": ["联系人"]', check: 'api-doc-unused-variable-example-present' },
    { source: apiDoc, sourceName: 'Docx API 参考文档', needle: '模板中仍有未替换的变量占位符，请检查模板。', check: 'api-doc-residual-placeholder-example-present' },
    { source: apiDoc, sourceName: 'Docx API 参考文档', needle: '## 1. 上传模板', check: 'api-doc-official-style-sections-present' },
    { source: apiDoc, sourceName: 'Docx API 参考文档', needle: '## 2. 查询模板列表', check: 'api-doc-numbered-api-sections-present' },
    { source: apiDoc, sourceName: 'Docx API 参考文档', needle: '## 11. 查询异步任务结果', check: 'api-doc-numbered-api-sections-present' },
    { source: apiDoc, sourceName: 'Docx API 参考文档', needle: '### 请求', check: 'api-doc-official-style-sections-present' },
    { source: apiDoc, sourceName: 'Docx API 参考文档', needle: '### 请求头', check: 'api-doc-official-style-sections-present' },
    { source: apiDoc, sourceName: 'Docx API 参考文档', needle: '### 响应体', check: 'api-doc-official-style-sections-present' },
    { source: apiDoc, sourceName: 'Docx API 参考文档', needle: '### 常见错误', check: 'api-doc-official-style-sections-present' },
    { source: runbook, sourceName: 'Docx API 运维手册', needle: 'DOCUMENT_RENDER_STORAGE_PROVIDER=tos', check: 'runbook-oss-config-present' },
    { source: runbook, sourceName: 'Docx API 运维手册', needle: 'OSS 预检失败', check: 'runbook-oss-troubleshooting-present' },
    { source: runbook, sourceName: 'Docx API 运维手册', needle: '`NoSuchBucket`', check: 'runbook-oss-troubleshooting-present' },
    { source: runbook, sourceName: 'Docx API 运维手册', needle: '`InvalidAccessKeyId`', check: 'runbook-oss-troubleshooting-present' },
    { source: runbook, sourceName: 'Docx API 运维手册', needle: '`AccessDenied`', check: 'runbook-oss-troubleshooting-present' },
    { source: runbook, sourceName: 'Docx API 运维手册', needle: '`SignatureDoesNotMatch`', check: 'runbook-oss-troubleshooting-present' },
    { source: runbook, sourceName: 'Docx API 运维手册', needle: 'OSS 最小权限', check: 'runbook-oss-permission-checklist-present' },
    { source: runbook, sourceName: 'Docx API 运维手册', needle: '`PutObject`', check: 'runbook-oss-permission-checklist-present' },
    { source: runbook, sourceName: 'Docx API 运维手册', needle: '`GetObject`', check: 'runbook-oss-permission-checklist-present' },
    { source: runbook, sourceName: 'Docx API 运维手册', needle: '`DeleteObject`', check: 'runbook-oss-permission-checklist-present' },
    { source: runbook, sourceName: 'Docx API 运维手册', needle: '`ListBuckets` | 仅诊断', check: 'runbook-oss-permission-checklist-present' },
  ];
  for (const item of docChecks) {
    if (!item.source.includes(item.needle)) {
      fail(`${item.sourceName} 缺少 API 接入示例：${item.needle}`);
    }
  }
  return Array.from(new Set(docChecks.map((item) => item.check)));
}

async function writeReport(reportPath: string, summary: Summary): Promise<Summary> {
  const milestoneRunId = (process.env.DOCUMENT_RENDER_MILESTONE1_RUN_ID || '').trim();
  const withRunId = milestoneRunId ? { milestoneRunId, ...summary } : summary;
  if (!reportPath) return withRunId;
  await mkdir(dirname(reportPath), { recursive: true });
  const report = { ...withRunId, reportFile: reportPath };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

async function main(): Promise<void> {
  const config = getConfig();
  const templateServer = config.templateUrl ? null : await startTemplateServer(await createTemplateDocx());
  const templateUrl = config.templateUrl || templateServer?.url || '';
  try {
    await verifyFrontendTitle(config.baseUrl);
    const { status, body } = await postJson(`${config.baseUrl}/api/v1/document-renders`, buildPayload(templateUrl));
    assertOkResponse(status, body);
    verifyDownloadTtl(body, 3600);
    const download = body.download as JsonObject;
    const storage = String(download.storage || '');
    if (config.expectedStorage && storage !== config.expectedStorage) {
      fail(`下载存储类型不符合预期：expected=${config.expectedStorage}, actual=${storage}`);
    }
    const inspected = await downloadAndInspect(config.baseUrl, body, config.outputPath);
    await verifyMissingVariables(config.baseUrl, templateUrl);
    await verifyUnusedVariables(config.baseUrl, templateUrl);
    const stability = await verifyStability(config.baseUrl, templateUrl, config.repeat, config.concurrency);

    const summaryChecks = Array.from(new Set(inspected.checks.concat([
      'frontend-title-ok',
      'response-contract-ok',
      'download-contract-ok',
      'download-ttl-ok',
      'download-storage-ok',
      'missing-variables-ok',
      'unused-variables-ok',
      'error-contract-ok',
      'stability-ok',
      ...(await verifySecurityAndRegressionTestSources()),
      ...(await verifyReadmeApiDocs()),
    ])));
    const summary: Summary = {
      ok: true,
      baseUrl: config.baseUrl,
      storage,
      requestId: String(body.requestId || ''),
      downloadBytes: inspected.bytes,
      ...(inspected.outputPath ? { generatedFile: inspected.outputPath } : {}),
      checks: summaryChecks,
      stability,
    };
    console.log(JSON.stringify(await writeReport(config.reportPath, summary)));
  } finally {
    await templateServer?.close();
  }
}

main().catch(async (error) => {
  const config = getConfig();
  const report = await writeReport(config.reportPath, {
    ok: false,
    baseUrl: config.baseUrl,
    error: error instanceof Error ? error.message : String(error),
  });
  console.error(JSON.stringify(report));
  process.exit(1);
});

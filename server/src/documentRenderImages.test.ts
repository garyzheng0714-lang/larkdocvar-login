import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import JSZip from 'jszip';
import sharp from 'sharp';
import { __test__ as renderTest } from './documentRenderApi';
import { __test__ as imageTest } from './documentRenderImages';

async function createPng(width = 120, height = 60): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 20, g: 90, b: 180, alpha: 1 },
    },
  }).png().toBuffer();
}

async function createDocxBuffer(input: { documentXml: string; headerXml?: string; footerXml?: string }): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  ${input.headerXml ? '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>' : ''}
  ${input.footerXml ? '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>' : ''}
</Types>`);
  zip.folder('_rels')?.file('.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.folder('word')?.file('document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${input.documentXml}</w:body></w:document>`);
  if (input.headerXml || input.footerXml) {
    zip.folder('word')?.folder('_rels')?.file('document.xml.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${input.headerXml ? '<Relationship Id="rHeader1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>' : ''}${input.footerXml ? '<Relationship Id="rFooter1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>' : ''}</Relationships>`);
  }
  if (input.headerXml) zip.folder('word')?.file('header1.xml', `<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${input.headerXml}</w:hdr>`);
  if (input.footerXml) zip.folder('word')?.file('footer1.xml', `<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${input.footerXml}</w:ftr>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function startImageServer(image: Buffer, onPath?: (path: string) => void): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    onPath?.(request.url || '');
    response.setHeader('Content-Type', 'image/png');
    response.end(image);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo | null;
  assert.ok(address);
  return { url: `http://127.0.0.1:${address.port}/logo.png`, close: () => closeServer(server) };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error) reject(error); else resolve(); });
  });
}

function enablePrivateImageUrlsForTest(): () => void {
  const previous = process.env.DOCUMENT_IMAGE_ALLOW_PRIVATE_URLS;
  process.env.DOCUMENT_IMAGE_ALLOW_PRIVATE_URLS = 'true';
  return () => {
    if (previous === undefined) delete process.env.DOCUMENT_IMAGE_ALLOW_PRIVATE_URLS;
    else process.env.DOCUMENT_IMAGE_ALLOW_PRIVATE_URLS = previous;
  };
}

test('Docx 图片变量可以插入图片并设置尺寸和右对齐', async () => {
  const restore = enablePrivateImageUrlsForTest();
  const imageServer = await startImageServer(await createPng());
  try {
    const template = await createDocxBuffer({
      documentXml: '<w:p><w:r><w:t>{{image:logo|width=30mm|align=right|alt=公司Logo}}</w:t></w:r></w:p>',
    });
    const rendered = await renderTest.renderDocx(template, {}, {
      logo: { url: imageServer.url },
    });

    assert.deepEqual(rendered.missing, []);
    assert.deepEqual(rendered.images.found, ['logo']);
    assert.equal(rendered.images.rendered[0].align, 'right');
    assert.equal(rendered.images.rendered[0].width, 30 * 36000);
    const outputZip = await JSZip.loadAsync(rendered.buffer);
    const documentXml = await outputZip.file('word/document.xml')?.async('string');
    const relsXml = await outputZip.file('word/_rels/document.xml.rels')?.async('string');
    const contentTypesXml = await outputZip.file('[Content_Types].xml')?.async('string');
    assert.ok(outputZip.file('word/media/image1.png'));
    assert.match(documentXml || '', /<w:jc w:val="right"\/>/);
    assert.match(documentXml || '', /<wp:inline/);
    assert.match(documentXml || '', /descr="公司Logo"/);
    assert.doesNotMatch(documentXml || '', /\{\{image:logo/);
    assert.match(relsXml || '', /relationships\/image/);
    assert.match(contentTypesXml || '', /Extension="png" ContentType="image\/png"/);
  } finally {
    await imageServer.close();
    restore();
  }
});

test('Docx 图片变量支持被 Word 拆成多个文本节点', async () => {
  const restore = enablePrivateImageUrlsForTest();
  const imageServer = await startImageServer(await createPng(80, 40));
  try {
    const template = await createDocxBuffer({
      documentXml: '<w:p><w:r><w:t>{{ima</w:t></w:r><w:r><w:t>ge:seal|width=100px|align=center}}</w:t></w:r></w:p>',
    });
    const rendered = await renderTest.renderDocx(template, {}, {
      seal: { url: imageServer.url },
    });
    const outputZip = await JSZip.loadAsync(rendered.buffer);
    const documentXml = await outputZip.file('word/document.xml')?.async('string');
    assert.deepEqual(rendered.missing, []);
    assert.match(documentXml || '', /<w:jc w:val="center"\/>/);
    assert.match(documentXml || '', /cx="952500"/);
    assert.doesNotMatch(documentXml || '', /\{\{/);
  } finally {
    await imageServer.close();
    restore();
  }
});

test('Docx 图片变量可写入页眉并生成独立关系文件', async () => {
  const restore = enablePrivateImageUrlsForTest();
  const imageServer = await startImageServer(await createPng(90, 45));
  try {
    const template = await createDocxBuffer({
      documentXml: '<w:sectPr><w:headerReference w:type="default" r:id="rHeader1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></w:sectPr><w:p><w:r><w:t>正文</w:t></w:r></w:p>',
      headerXml: '<w:p><w:r><w:t>{{图片:logo|宽=20mm|对齐=左}}</w:t></w:r></w:p>',
    });
    const rendered = await renderTest.renderDocx(template, {}, {
      logo: { url: imageServer.url },
    });
    const outputZip = await JSZip.loadAsync(rendered.buffer);
    const headerXml = await outputZip.file('word/header1.xml')?.async('string');
    const headerRelsXml = await outputZip.file('word/_rels/header1.xml.rels')?.async('string');
    assert.deepEqual(rendered.missing, []);
    assert.match(headerXml || '', /<w:jc w:val="left"\/>/);
    assert.match(headerRelsXml || '', /Target="media\/image1\.png"/);
  } finally {
    await imageServer.close();
    restore();
  }
});

test('Docx 图片变量缺少输入时返回 missingVariables 使用 image 前缀', async () => {
  const template = await createDocxBuffer({
    documentXml: '<w:p><w:r><w:t>{{image:logo}}</w:t></w:r></w:p>',
  });
  const rendered = await renderTest.renderDocx(template, {}, {});
  assert.deepEqual(rendered.missing, ['image:logo']);
});

test('图片变量可以追加阿里云 OSS x-oss-process 参数', async () => {
  let lastPath = '';
  const restore = enablePrivateImageUrlsForTest();
  const imageServer = await startImageServer(await createPng(), (path) => { lastPath = path; });
  try {
    const template = await createDocxBuffer({
      documentXml: '<w:p><w:r><w:t>{{image:logo|oss=image/resize,w_600}}</w:t></w:r></w:p>',
    });
    await renderTest.renderDocx(template, {}, {
      logo: { url: imageServer.url },
    });
    assert.match(decodeURIComponent(lastPath), /x-oss-process=image\/resize,w_600/);
  } finally {
    await imageServer.close();
    restore();
  }
});

test('图片变量不允许和其他文字放在同一段', async () => {
  const restore = enablePrivateImageUrlsForTest();
  const imageServer = await startImageServer(await createPng());
  try {
    const template = await createDocxBuffer({
      documentXml: '<w:p><w:r><w:t>Logo：{{image:logo}}</w:t></w:r></w:p>',
    });
    await assert.rejects(
      () => renderTest.renderDocx(template, {}, { logo: { url: imageServer.url } }),
      /图片变量必须单独放在一个段落/,
    );
  } finally {
    await imageServer.close();
    restore();
  }
});

test('图片变量工具会保留已有 query 并设置 OSS 图片处理参数', () => {
  const url = imageTest.buildImageUrlWithOssProcess('https://example.com/a.png?token=abc', 'image/resize,w_600');
  assert.match(url, /^https:\/\/example\.com\/a\.png\?token=abc&x-oss-process=/);
  assert.equal(new URL(url).searchParams.get('x-oss-process'), 'image/resize,w_600');
});

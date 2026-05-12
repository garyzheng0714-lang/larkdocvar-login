import assert from 'node:assert/strict';
import test from 'node:test';
import JSZip from 'jszip';
import sharp from 'sharp';
import { __test__ as renderTest } from './documentRenderApi';
import { convertCommentAnnotationsToTemplate, __test__ as annotationTest } from './documentTemplateAnnotations';

async function tinyPng(): Promise<Buffer> {
  return sharp({
    create: { width: 64, height: 32, channels: 4, background: { r: 80, g: 120, b: 220, alpha: 1 } },
  }).png().toBuffer();
}

async function createAnnotatedDocx(input: {
  documentXml: string;
  comments: Record<string, string>;
  media?: Record<string, Buffer>;
}): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>
</Types>`);
  zip.folder('_rels')?.file('.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.folder('word')?.folder('_rels')?.file('document.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rComments" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/><Relationship Id="rImage1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/></Relationships>');
  zip.folder('word')?.file('document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${input.documentXml}</w:body></w:document>`);
  zip.folder('word')?.file('comments.xml', `<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${Object.entries(input.comments).map(([id, text]) => `<w:comment w:id="${id}"><w:p><w:r><w:t>${escapeXml(text)}</w:t></w:r></w:p></w:comment>`).join('')}</w:comments>`);
  for (const [name, buffer] of Object.entries(input.media || {})) {
    zip.folder('word')?.folder('media')?.file(name, buffer);
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function escapeXml(input: string): string {
  return input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function commentReference(id: string): string {
  return `<w:r><w:commentReference w:id="${id}"/></w:r>`;
}

function inlinePngDrawing(widthEmu: number, heightEmu: number): string {
  return `<w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="${widthEmu}" cy="${heightEmu}"/><wp:docPr id="9" name="原图"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:blipFill><a:blip r:embed="rImage1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
}

test('批注里的变量定义会把成品文字转换为保留样式的模板变量', async () => {
  const docx = await createAnnotatedDocx({
    comments: { 0: '变量：公司名称' },
    documentXml: `<w:p>
      <w:r><w:t>甲方：</w:t></w:r>
      <w:commentRangeStart w:id="0"/>
      <w:r><w:rPr><w:b/><w:color w:val="FF0000"/><w:u w:val="single"/></w:rPr><w:t>上海测试科技有限公司</w:t></w:r>
      <w:commentRangeEnd w:id="0"/>
      ${commentReference('0')}
    </w:p>`,
  });
  const converted = await convertCommentAnnotationsToTemplate(docx);
  assert.deepEqual(converted.variables, ['公司名称']);
  const zip = await JSZip.loadAsync(converted.buffer);
  const xml = await zip.file('word/document.xml')?.async('string');
  assert.match(xml || '', /\{\{公司名称\}\}/);
  assert.match(xml || '', /<w:b\/>/);
  assert.match(xml || '', /<w:color w:val="FF0000"\/>/);
  assert.match(xml || '', /<w:u w:val="single"\/>/);
  assert.doesNotMatch(xml || '', /commentRange|commentReference|上海测试科技有限公司/);

  const rendered = await renderTest.renderDocx(converted.buffer, { 公司名称: '北京客户有限公司' });
  const renderedZip = await JSZip.loadAsync(rendered.buffer);
  const renderedXml = await renderedZip.file('word/document.xml')?.async('string');
  assert.match(renderedXml || '', /北京客户有限公司/);
  assert.match(renderedXml || '', /<w:b\/>/);
  assert.match(renderedXml || '', /<w:color w:val="FF0000"\/>/);
});

test('批注里的图片变量会读取原图尺寸和段落对齐生成图片占位符', async () => {
  const widthEmu = 30 * 36000;
  const heightEmu = 15 * 36000;
  const docx = await createAnnotatedDocx({
    comments: { 1: '图片变量：客户logo' },
    media: { 'image1.png': await tinyPng() },
    documentXml: `<w:p><w:pPr><w:jc w:val="center"/></w:pPr>
      <w:commentRangeStart w:id="1"/>
      ${inlinePngDrawing(widthEmu, heightEmu)}
      <w:commentRangeEnd w:id="1"/>
      ${commentReference('1')}
    </w:p>`,
  });
  const converted = await convertCommentAnnotationsToTemplate(docx);
  assert.deepEqual(converted.variables, ['image:客户logo']);
  const zip = await JSZip.loadAsync(converted.buffer);
  const xml = await zip.file('word/document.xml')?.async('string');
  assert.match(xml || '', /\{\{image:客户logo\|width=30mm\|height=15mm\|align=center\}\}/);
  assert.doesNotMatch(xml || '', /<w:drawing>/);
  assert.equal(Boolean(zip.file('word/comments.xml')), false);
});

test('旧式 VML 图片变量会读取 style 中的宽高', async () => {
  const docx = await createAnnotatedDocx({
    comments: { 2: '图片变量：旧logo' },
    media: { 'image1.png': await tinyPng() },
    documentXml: `<w:p>
      <w:commentRangeStart w:id="2"/>
      <w:r><w:pict><v:shape xmlns:v="urn:schemas-microsoft-com:vml" style="width:72pt;height:36pt"><v:imagedata r:id="rImage1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></v:shape></w:pict></w:r>
      <w:commentRangeEnd w:id="2"/>
      ${commentReference('2')}
    </w:p>`,
  });
  const converted = await convertCommentAnnotationsToTemplate(docx);
  const zip = await JSZip.loadAsync(converted.buffer);
  const xml = await zip.file('word/document.xml')?.async('string');
  assert.match(xml || '', /\{\{image:旧logo\|width=25.4mm\|height=12.7mm\|align=left\}\}/);
});

test('跨段落变量批注会返回明确错误而不是保存半成品', async () => {
  const docx = await createAnnotatedDocx({
    comments: { 3: '变量：跨段内容' },
    documentXml: `<w:p><w:commentRangeStart w:id="3"/><w:r><w:t>第一段</w:t></w:r></w:p>
      <w:p><w:r><w:t>第二段</w:t></w:r><w:commentRangeEnd w:id="3"/>${commentReference('3')}</w:p>`,
  });
  await assert.rejects(
    () => convertCommentAnnotationsToTemplate(docx),
    /变量批注 跨段内容 的范围暂不支持/,
  );
});

test('非变量批注不会触发成品模板转换', async () => {
  const docx = await createAnnotatedDocx({
    comments: { 0: '这里需要复核' },
    documentXml: `<w:p><w:commentRangeStart w:id="0"/><w:r><w:t>上海测试科技有限公司</w:t></w:r><w:commentRangeEnd w:id="0"/>${commentReference('0')}</w:p>`,
  });
  const converted = await convertCommentAnnotationsToTemplate(docx);
  assert.deepEqual(converted.variables, []);
  assert.equal(converted.buffer, docx);
});

test('批注解析支持中文和英文冒号', () => {
  assert.deepEqual(annotationTest.parseAnnotationText('变量：姓名'), { kind: 'text', name: '姓名' });
  assert.deepEqual(annotationTest.parseAnnotationText('图片变量: 客户二维码'), { kind: 'image', name: '客户二维码' });
  assert.equal(annotationTest.parseAnnotationText('普通批注'), null);
});

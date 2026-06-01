import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { __test__ } from './documentRenderApi';

const { renderDocxWithEasyTemplate } = __test__;

// 构造一个最小合法 docx，body 内容由参数注入
async function buildDocx(bodyInner: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);
  zip.folder('_rels')?.file('.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);
  zip.folder('word')?.file('document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${bodyInner}</w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function extractDocumentXml(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  return (await zip.file('word/document.xml')?.async('string')) || '';
}

// 取出包含某段文本的那个 <w:r> 整体
function runContaining(xml: string, value: string): string | null {
  const match = xml.match(new RegExp(`<w:r>(?:(?!</w:r>)[\\s\\S])*?${value}(?:(?!</w:r>)[\\s\\S])*?</w:r>`));
  return match ? match[0] : null;
}

test('跨样式 run 的占位符：替换值保留变量名所在 run 的样式（这是"样式不统一"的根因，必须钉死）', async () => {
  // WHY：Word 编辑/输入法常把 {{客户名称}} 拆成 [{{][客户名称(加粗)][}}] 三个不同样式的 run。
  // 旧引擎把整值塞进起始普通 run、丢掉加粗；新引擎经 run 归一化后必须保留变量名的加粗。
  const tpl = await buildDocx(`<w:p><w:r><w:t>客户：</w:t></w:r><w:r><w:t>{{</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>客户名称</w:t></w:r><w:r><w:t>}}</w:t></w:r></w:p>`);
  const result = await renderDocxWithEasyTemplate(tpl, { 客户名称: '上海测试' });
  const xml = await extractDocumentXml(result.buffer);
  const valueRun = runContaining(xml, '上海测试');
  assert.ok(valueRun, '应能定位到包含替换值的 run');
  assert.match(valueRun as string, /<w:b\s*\/>/, '替换值所在 run 必须保留变量名的加粗样式，而非塌缩成普通样式');
  assert.equal(result.hasResidualPlaceholders, false);
  assert.deepEqual(result.missing, []);
});

test('占位符整体设样式时也保真（最常见场景）', async () => {
  const tpl = await buildDocx(`<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>{{客户名称}}</w:t></w:r></w:p>`);
  const result = await renderDocxWithEasyTemplate(tpl, { 客户名称: '上海测试' });
  const xml = await extractDocumentXml(result.buffer);
  assert.match(runContaining(xml, '上海测试') as string, /<w:b\s*\/>/);
});

test('多行变量值渲染为真正的换行（修复"多行挤成一行"）', async () => {
  const tpl = await buildDocx(`<w:p><w:r><w:t>备注：{{备注}}</w:t></w:r></w:p>`);
  const result = await renderDocxWithEasyTemplate(tpl, { 备注: '第一行\n第二行\n第三行' });
  const xml = await extractDocumentXml(result.buffer);
  assert.match(xml, /<w:br\s*\/>/, '多行值应包含 <w:br/> 而不是被挤成一行');
});

test('任意字段名（含空格）正确字面替换，不报错（docx-templates 在此会崩，故弃用）', async () => {
  const tpl = await buildDocx(`<w:p><w:r><w:t>金额：{{合同 金额}}</w:t></w:r></w:p>`);
  const result = await renderDocxWithEasyTemplate(tpl, { '合同 金额': '12800 元' });
  const xml = await extractDocumentXml(result.buffer);
  assert.match(xml, /12800 元/);
  assert.equal(result.hasResidualPlaceholders, false);
});

test('表格单元格内的占位符也被替换（不漏替换、不误判失败）', async () => {
  const tpl = await buildDocx(`<w:p><w:r><w:t>抬头：{{甲}}</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>表内：{{乙}}</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`);
  const result = await renderDocxWithEasyTemplate(tpl, { 甲: 'AAA', 乙: 'BBB' });
  const xml = await extractDocumentXml(result.buffer);
  assert.match(xml, /AAA/);
  assert.match(xml, /BBB/);
  assert.equal(result.hasResidualPlaceholders, false);
});

test('缺失变量在 missing 中如实列出（供上层报可读错误）', async () => {
  const tpl = await buildDocx(`<w:p><w:r><w:t>{{甲}} {{乙}}</w:t></w:r></w:p>`);
  const result = await renderDocxWithEasyTemplate(tpl, { 甲: 'AAA' });
  assert.deepEqual(result.found.sort(), ['乙', '甲']);
  assert.deepEqual(result.missing, ['乙']);
});

test('基础替换返回 found 与 previewText', async () => {
  const tpl = await buildDocx(`<w:p><w:r><w:t>客户：{{客户名称}}</w:t></w:r></w:p>`);
  const result = await renderDocxWithEasyTemplate(tpl, { 客户名称: '上海测试' });
  assert.deepEqual(result.found, ['客户名称']);
  assert.deepEqual(result.missing, []);
  assert.match(result.previewText, /客户：上海测试/);
});

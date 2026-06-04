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

// 是否存在【单个 run 内部出现两个 <w:rPr>】这种非法形态——Word 打开会触发"文档需要修复"。
// rPr 并集逻辑若把样式追加错位置就会产出双 rPr，必须钉死它不发生。
function hasDoubleRPrInSameRun(xml: string): boolean {
  for (const run of xml.matchAll(/<w:r\b[^>]*>[\s\S]*?<\/w:r>/g)) {
    if ((run[0].match(/<w:rPr\b/g) || []).length > 1) return true;
  }
  return false;
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

test('变量值里含字面 {{ 或 }} 不被误判为残留占位符（公式/代码/JSON 常见，绝不能让整单失败）', async () => {
  // WHY：残留判定一旦对替换后文本裸扫 includes('{{'/'}}')，用户填 "f(x) }} 结束"、"{ a: {{1}} }"
  // 这类含字面括号的值就会被当成"模板仍有未替换占位符"导致整批生成无故失败——这是头号信任杀手。
  // 正确语义：占位符已替换完毕，值里的字面括号只是普通文本。
  const tpl = await buildDocx(`<w:p><w:r><w:t>公式：{{表达式}}；说明：{{说明}}</w:t></w:r></w:p>`);
  const result = await renderDocxWithEasyTemplate(tpl, { 表达式: 'f(x) }} 结束', 说明: '形如 {{ 开头' });
  const xml = await extractDocumentXml(result.buffer);
  assert.match(xml, /f\(x\) \}\} 结束/, '含字面 }} 的值应原样写入');
  assert.match(xml, /形如 \{\{ 开头/, '含字面 {{ 的值应原样写入');
  assert.equal(result.hasResidualPlaceholders, false, '占位符已全部替换，值里的字面括号不算残留');
  assert.deepEqual(result.missing, []);
});

test('下划线只覆盖变量名后半字符：替换后该字符级样式不被 run 归一化抹掉（用户报障的填空横线消失，必须钉死）', async () => {
  // WHY：模板里「{{甲乙丙}}」被拆成 [{{][甲乙][丙(下划线)][}}]，下划线只覆盖「丙」这一个字符（像填空横线）。
  // 旧归一化以「重叠字符最多的 run」(甲乙) 的空 rPr 整块覆盖全组，把「丙」run 的 <w:u> 删光，下划线消失。
  // 正确意图：替换值真正落在的那个 run（占位符起始 run）必须带下划线，用户才看得到填空横线——
  // 仅"整段 XML 某处残留 <w:u>"不算修复（残留在被清空文本的空 run 上对用户不可见）。
  const tpl = await buildDocx(`<w:p><w:r><w:t>{{</w:t></w:r><w:r><w:t>甲乙</w:t></w:r><w:r><w:rPr><w:u w:val="single"/></w:rPr><w:t>丙</w:t></w:r><w:r><w:t>}}</w:t></w:r></w:p>`);
  const result = await renderDocxWithEasyTemplate(tpl, { 甲乙丙: 'XYZ' });
  const xml = await extractDocumentXml(result.buffer);
  const valueRun = runContaining(xml, 'XYZ');
  assert.ok(valueRun, '应能定位到替换值所在 run');
  assert.match(valueRun as string, /<w:u\s+w:val="single"\s*\/>/, '替换值所在 run 必须带下划线，用户才看得到填空横线');
  assert.equal(hasDoubleRPrInSameRun(xml), false, '不得在同一 run 产出双 rPr 非法 XML');
  assert.equal(result.hasResidualPlaceholders, false);
  assert.deepEqual(result.missing, []);
});

test('下划线只覆盖变量名前半字符（镜像 case）：替换后仍保留 <w:u>，证明修复对下划线位置不敏感', async () => {
  // WHY：防止只对尾部字符生效的偏修。下划线在「甲」（前半）时，代表 run 是「乙丙」(重叠2字符) 的空样式，
  // 同样会触发把「甲」的 <w:u> 抹掉的 bug。保真必须与下划线出现的位置无关。
  const tpl = await buildDocx(`<w:p><w:r><w:t>{{</w:t></w:r><w:r><w:rPr><w:u w:val="single"/></w:rPr><w:t>甲</w:t></w:r><w:r><w:t>乙丙</w:t></w:r><w:r><w:t>}}</w:t></w:r></w:p>`);
  const result = await renderDocxWithEasyTemplate(tpl, { 甲乙丙: 'XYZ' });
  const xml = await extractDocumentXml(result.buffer);
  const valueRun = runContaining(xml, 'XYZ');
  assert.ok(valueRun, '应能定位到替换值所在 run');
  assert.match(valueRun as string, /<w:u\s+w:val="single"\s*\/>/, '下划线在变量名前半时，替换值所在 run 同样必须带下划线');
  assert.equal(hasDoubleRPrInSameRun(xml), false);
  assert.equal(result.hasResidualPlaceholders, false);
});

test('变量名整体带下划线（{{价格}} 价格整体 <w:u>，左右花括号无样式）：锁死用户原始正确 case 不回归', async () => {
  // WHY：这是「价格」二字像填空横线整体带下划线的原始场景，修复前它本来就保真（代表 run 即下划线主体）。
  // 改成并集语义后必须仍然保真——它是回归基线，防止合并逻辑把已正确的整体样式路径改坏。
  const tpl = await buildDocx(`<w:p><w:r><w:t>{{</w:t></w:r><w:r><w:rPr><w:u w:val="single"/></w:rPr><w:t>价格</w:t></w:r><w:r><w:t>}}</w:t></w:r></w:p>`);
  const result = await renderDocxWithEasyTemplate(tpl, { 价格: '99' });
  const xml = await extractDocumentXml(result.buffer);
  const valueRun = runContaining(xml, '99');
  assert.ok(valueRun, '应能定位到替换值所在 run');
  assert.match(valueRun as string, /<w:u\s+w:val="single"\s*\/>/, '整体下划线时替换值所在 run 必须带 <w:u>');
});

test('起始 run 自闭合空样式 <w:rPr/> 且主体 run 带 <w:u>：替换值 run 含下划线且不产出双 rPr 非法 XML', async () => {
  // WHY：Word 常把首 run 写成自闭合 <w:rPr/>。若 rPr 提取正则不兼容自闭合形态，会失配退化成空串再把样式抹掉；
  // 且并集时若把追加项插错位置会产出双 rPr 导致 Word 触发文档修复。这条同时验证正则放宽 + 并集落点正确。
  const tpl = await buildDocx(`<w:p><w:r><w:rPr/><w:t>{{</w:t></w:r><w:r><w:rPr><w:u w:val="single"/></w:rPr><w:t>甲乙丙</w:t></w:r><w:r><w:rPr/><w:t>}}</w:t></w:r></w:p>`);
  const result = await renderDocxWithEasyTemplate(tpl, { 甲乙丙: 'XYZ' });
  const xml = await extractDocumentXml(result.buffer);
  const valueRun = runContaining(xml, 'XYZ');
  assert.ok(valueRun, '应能定位到替换值所在 run');
  assert.match(valueRun as string, /<w:u\s+w:val="single"\s*\/>/, '自闭合起始 run 也应从主体并入下划线');
  assert.equal(hasDoubleRPrInSameRun(xml), false, '自闭合 rPr 展开后不得产出双 rPr');
  assert.equal(result.hasResidualPlaceholders, false);
});

test('加粗与下划线并存且分散在不同 run：替换后两种字符级样式都保留（验证并集不丢任一样式）', async () => {
  // WHY：合并语义必须既保住「重叠最多 run」决定的主体样式，又并入其它 covered run 的独有样式。
  // 这里「甲乙」带 <w:b/>（主体、重叠2字符），「丙」带 <w:u>（独有），二者都不能丢。
  const tpl = await buildDocx(`<w:p><w:r><w:t>{{</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>甲乙</w:t></w:r><w:r><w:rPr><w:u w:val="single"/></w:rPr><w:t>丙</w:t></w:r><w:r><w:t>}}</w:t></w:r></w:p>`);
  const result = await renderDocxWithEasyTemplate(tpl, { 甲乙丙: 'XYZ' });
  const xml = await extractDocumentXml(result.buffer);
  const valueRun = runContaining(xml, 'XYZ');
  assert.ok(valueRun, '应能定位到替换值所在 run');
  assert.match(valueRun as string, /<w:b\s*\/>/, '替换值所在 run 必须保留主体加粗样式');
  assert.match(valueRun as string, /<w:u\s+w:val="single"\s*\/>/, '替换值所在 run 必须同时保留另一字符的下划线样式');
  assert.equal(hasDoubleRPrInSameRun(xml), false);
  assert.equal(result.hasResidualPlaceholders, false);
});

test('基础替换返回 found 与 previewText', async () => {
  const tpl = await buildDocx(`<w:p><w:r><w:t>客户：{{客户名称}}</w:t></w:r></w:p>`);
  const result = await renderDocxWithEasyTemplate(tpl, { 客户名称: '上海测试' });
  assert.deepEqual(result.found, ['客户名称']);
  assert.deepEqual(result.missing, []);
  assert.match(result.previewText, /客户：上海测试/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import JSZip from 'jszip';

import { __test__ } from './documentRenderApi';

async function createDocxBuffer(documentXml: string): Promise<Buffer> {
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
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${documentXml}</w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function createDocxBufferWithParts(input: {
  documentXml: string;
  headerXml: string;
  footerXml: string;
}): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>
  <Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>
</Types>`);
  zip.folder('_rels')?.file('.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);
  zip.folder('word')?.folder('_rels')?.file('document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rHeader1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>
  <Relationship Id="rFooter1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>
</Relationships>`);
  zip.folder('word')?.file('document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>${input.documentXml}<w:sectPr><w:headerReference w:type="default" r:id="rHeader1"/><w:footerReference w:type="default" r:id="rFooter1"/></w:sectPr></w:body>
</w:document>`);
  zip.folder('word')?.file('header1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${input.headerXml}</w:hdr>`);
  zip.folder('word')?.file('footer1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${input.footerXml}</w:ftr>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

test('Docx 占位符跨段落（畸形）时报可读错误，不误拼接替换', async () => {
  // {{ 与 }} 落在不同段落属于畸形模板；新引擎明确报错（显式失败），而非静默误拼接或残留半截。
  await assert.rejects(
    __test__.renderDocx(await createDocxBuffer(`
    <w:p><w:r><w:t>{{客</w:t></w:r></w:p>
    <w:p><w:r><w:t>户名称}}</w:t></w:r></w:p>
  `), { 客户名称: '上海测试科技有限公司' }),
    /无法解析|占位符/,
  );
});

test('Docx 替换会正确转义变量值中的 XML 特殊字符', async () => {
  const rendered = await __test__.renderDocx(await createDocxBuffer(
    '<w:p><w:r><w:t>客户：{{客户名称}}</w:t></w:r></w:p>',
  ), { 客户名称: 'A&B <C> "D" \'E\'' });

  assert.deepEqual(rendered.missing, []);
  const outputZip = await JSZip.loadAsync(rendered.buffer);
  const documentXml = await outputZip.file('word/document.xml')?.async('string');
  assert.match(documentXml || '', /A&amp;B &lt;C&gt; &quot;D&quot; &apos;E&apos;/);
  assert.doesNotMatch(documentXml || '', /A&B <C>/);
  assert.doesNotMatch(documentXml || '', /\{\{客户名称\}\}/);
});

test('Docx 替换会保留变量值首尾空格', async () => {
  const rendered = await __test__.renderDocx(await createDocxBuffer(
    '<w:p><w:r><w:t>备注：{{备注}}</w:t></w:r></w:p>',
  ), { 备注: '  需要保留空格  ' });

  const outputZip = await JSZip.loadAsync(rendered.buffer);
  const documentXml = await outputZip.file('word/document.xml')?.async('string');
  // 新引擎把"备注："与值拆成不同 w:t；关键是值的首尾空格被 xml:space="preserve" 完整保留
  assert.match(documentXml || '', /<w:t xml:space="preserve">  需要保留空格  <\/w:t>/);
});

test('Docx 拆分变量替换后采用变量名主体的样式（修复样式不统一根因）', async () => {
  // {{客(加粗红) / 户名称}}(斜体)：变量名"客户名称"主体多数字符落在斜体 run，
  // run 归一化后替换值采用斜体（变量名主体样式），而非起始的加粗红——这正是修复"样式不统一"的意图。
  const rendered = await __test__.renderDocx(await createDocxBuffer(`
    <w:p>
      <w:r><w:rPr><w:b/><w:color w:val="FF0000"/></w:rPr><w:t>{{客</w:t></w:r>
      <w:r><w:rPr><w:i/></w:rPr><w:t>户名称}}</w:t></w:r>
    </w:p>
  `), { 客户名称: '上海测试科技有限公司' });

  const outputZip = await JSZip.loadAsync(rendered.buffer);
  const documentXml = await outputZip.file('word/document.xml')?.async('string');
  assert.doesNotMatch(documentXml || '', /\{\{客户名称\}\}|\{\{客|户名称\}\}/);
  assert.match(documentXml || '', /<w:rPr><w:i\/><\/w:rPr><w:t[^>]*>上海测试科技有限公司<\/w:t>/);
});

test('Docx 单节点变量替换后完整保留占位符字体样式', async () => {
  const rPr = '<w:rPr><w:rFonts w:hint="eastAsia" w:ascii="等线" w:hAnsi="等线" w:eastAsia="等线" w:cs="等线"/><w:b/><w:color w:val="000000"/><w:sz w:val="24"/><w:szCs w:val="24"/><w:u w:val="single"/><w:lang w:val="en-US" w:eastAsia="zh-CN"/></w:rPr>';
  const rendered = await __test__.renderDocx(await createDocxBuffer(`
    <w:p>
      <w:r>${rPr}<w:t xml:space="preserve"> {{姓名}} </w:t></w:r>
    </w:p>
  `), { 姓名: 'Gary' });

  const outputZip = await JSZip.loadAsync(rendered.buffer);
  const documentXml = (await outputZip.file('word/document.xml')?.async('string')) || '';
  // 复杂字体 rPr 必须被保留；新引擎可能把 " Gary " 拆成多个 w:t，但首尾空格与值都在该样式 run 内
  assert.match(documentXml, new RegExp(rPr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const text = (documentXml.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g) || []).map((s) => s.replace(/<[^>]+>/g, '')).join('');
  assert.equal(text, ' Gary ');
});


test('Docx 替换支持表格、页眉、页脚里的拆分变量', async () => {
  const rendered = await __test__.renderDocx(await createDocxBufferWithParts({
    documentXml: `
      <w:tbl><w:tr><w:tc><w:p>
        <w:r><w:t>{{金</w:t></w:r>
        <w:r><w:t>额}}</w:t></w:r>
      </w:p></w:tc></w:tr></w:tbl>
    `,
    headerXml: `
      <w:p>
        <w:r><w:t>{{客</w:t></w:r>
        <w:r><w:t>户名称}}</w:t></w:r>
      </w:p>
    `,
    footerXml: `
      <w:p>
        <w:r><w:t>{{日</w:t></w:r>
        <w:r><w:t>期}}</w:t></w:r>
      </w:p>
    `,
  }), {
    客户名称: '上海测试科技有限公司',
    金额: '12800 元',
    日期: '2026-05-12',
  });

  assert.deepEqual(rendered.missing, []);
  const outputZip = await JSZip.loadAsync(rendered.buffer);
  const documentXml = await outputZip.file('word/document.xml')?.async('string');
  const headerXml = await outputZip.file('word/header1.xml')?.async('string');
  const footerXml = await outputZip.file('word/footer1.xml')?.async('string');
  const combined = `${documentXml}\n${headerXml}\n${footerXml}`;
  assert.match(documentXml || '', /12800 元/);
  assert.match(headerXml || '', /上海测试科技有限公司/);
  assert.match(footerXml || '', /2026-05-12/);
  assert.doesNotMatch(combined, /\{\{|客户名称\}\}|金额\}\}|日期\}\}/);
});

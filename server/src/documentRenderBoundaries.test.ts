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

test('Docx 替换不会跨段落拼接半截变量', async () => {
  const rendered = await __test__.renderDocx(await createDocxBuffer(`
    <w:p><w:r><w:t>{{客</w:t></w:r></w:p>
    <w:p><w:r><w:t>户名称}}</w:t></w:r></w:p>
  `), { 客户名称: '上海测试科技有限公司' });

  assert.deepEqual(rendered.found, []);
  const outputZip = await JSZip.loadAsync(rendered.buffer);
  const documentXml = await outputZip.file('word/document.xml')?.async('string');
  assert.match(documentXml || '', /\{\{客/);
  assert.match(documentXml || '', /户名称\}\}/);
  assert.doesNotMatch(documentXml || '', /上海测试科技有限公司/);
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
  assert.match(documentXml || '', /<w:t xml:space="preserve">备注：  需要保留空格  <\/w:t>/);
});

test('Docx 拆分变量替换后保留起始文本节点样式', async () => {
  const rendered = await __test__.renderDocx(await createDocxBuffer(`
    <w:p>
      <w:r><w:rPr><w:b/><w:color w:val="FF0000"/></w:rPr><w:t>{{客</w:t></w:r>
      <w:r><w:rPr><w:i/></w:rPr><w:t>户名称}}</w:t></w:r>
    </w:p>
  `), { 客户名称: '上海测试科技有限公司' });

  const outputZip = await JSZip.loadAsync(rendered.buffer);
  const documentXml = await outputZip.file('word/document.xml')?.async('string');
  assert.doesNotMatch(documentXml || '', /\{\{客户名称\}\}|\{\{客|户名称\}\}/);
  assert.match(
    documentXml || '',
    /<w:rPr><w:b\/><w:color w:val="FF0000"\/><\/w:rPr><w:t>上海测试科技有限公司<\/w:t>/,
  );
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

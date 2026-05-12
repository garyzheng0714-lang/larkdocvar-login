import assert from 'node:assert/strict';
import test from 'node:test';
import JSZip from 'jszip';

import { __test__ } from './documentRenderApi';

async function createDocxWithHeaderFooter(): Promise<Buffer> {
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
  <w:body><w:p><w:r><w:t>正文：{{客户名称}}</w:t></w:r></w:p><w:sectPr><w:headerReference w:type="default" r:id="rHeader1"/><w:footerReference w:type="default" r:id="rFooter1"/></w:sectPr></w:body>
</w:document>`);
  zip.folder('word')?.file('header1.xml', '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>页眉：{{页眉编号}}</w:t></w:r></w:p></w:hdr>');
  zip.folder('word')?.file('footer1.xml', '<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>页脚：{{页脚日期}}</w:t></w:r></w:p></w:ftr>');
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

test('Docx 页眉页脚里的缺失变量会返回 missingVariables', async () => {
  const rendered = await __test__.renderDocx(await createDocxWithHeaderFooter(), {
    客户名称: '上海测试科技有限公司',
  });

  assert.deepEqual(rendered.found.sort(), ['客户名称', '页眉编号', '页脚日期'].sort());
  assert.deepEqual(rendered.missing.sort(), ['页眉编号', '页脚日期'].sort());
});

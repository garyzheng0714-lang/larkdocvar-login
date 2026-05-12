import assert from 'node:assert/strict';
import test from 'node:test';
import JSZip from 'jszip';

import { __test__ } from './documentRenderApi';

async function createDocxWithFootnote(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>
</Types>`);
  zip.folder('_rels')?.file('.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.folder('word')?.file('document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>正文：{{客户名称}}</w:t></w:r></w:p></w:body></w:document>');
  zip.folder('word')?.file('footnotes.xml', '<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:footnote w:id="1"><w:p><w:r><w:t>脚注：{{脚注说明}}</w:t></w:r></w:p></w:footnote></w:footnotes>');
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

test('Docx 替换会覆盖 word 目录下的脚注 XML 部件', async () => {
  const rendered = await __test__.renderDocx(await createDocxWithFootnote(), {
    客户名称: '上海测试科技有限公司',
    脚注说明: '已完成验收',
  });

  assert.deepEqual(rendered.missing, []);
  assert.deepEqual(rendered.found.sort(), ['客户名称', '脚注说明'].sort());
  const outputZip = await JSZip.loadAsync(rendered.buffer);
  const footnotesXml = await outputZip.file('word/footnotes.xml')?.async('string');
  assert.match(footnotesXml || '', /脚注：已完成验收/);
  assert.doesNotMatch(footnotesXml || '', /\{\{脚注说明\}\}/);
});

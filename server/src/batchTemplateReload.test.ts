import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { renderBatchRecords } from './documentRenderBatchApi';
import { DocumentTemplateService } from './documentTemplateService';
import { LocalTemplateObjectStore } from './documentTemplateStorage';

// 测试目标：renderBatchRecords 应该复用模板 buffer，而不是每条记录都重新加载。
// 这是一个性能回归测试，确保批量渲染不会重复下载/加载模板。

async function createDocx(text: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);
  zip.folder('_rels')?.file('.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.folder('word')?.file('document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('renderBatchRecords 模板复用', () => {
  it('多条记录使用同一个 templateId 时，模板应该只加载一次', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'batch-template-reload-'));
    const store = new LocalTemplateObjectStore(dir);
    const service = new DocumentTemplateService(store);

    // 创建有效的 Docx 模板
    const templateBuffer = await createDocx('客户：{{客户名称}}，金额：{{金额}}');
    const template = await service.createTemplate({
      name: '测试模板',
      fileName: 'template.docx',
      fileBase64: templateBuffer.toString('base64'),
    });

    let loadCount = 0;
    const originalLoadTemplate = service.loadTemplate.bind(service);
    service.loadTemplate = async (...args) => {
      loadCount++;
      return originalLoadTemplate(...args);
    };

    const storage = {
      saveDocx: mock.fn(async () => ({
        path: '/tmp/test.docx',
        fileName: 'test.docx',
        size: 100,
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        storage: 'local' as const,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        url: 'http://localhost/test.docx',
      })),
    };

    // 批量渲染 3 条记录
    const results = await renderBatchRecords({
      template: { templateId: template.templateId, format: 'docx' },
      records: [
        { recordId: 'rec_1', variables: { '客户名称': 'Alice', '金额': '100' } },
        { recordId: 'rec_2', variables: { '客户名称': 'Bob', '金额': '200' } },
        { recordId: 'rec_3', variables: { '客户名称': 'Charlie', '金额': '300' } },
      ],
    }, {
      storage,
      templateResolver: service,
    });

    // 验证：模板应该只加载一次（预加载），而不是每条记录都加载
    assert.equal(loadCount, 1, `模板应该只加载一次，实际加载了 ${loadCount} 次`);
    assert.equal(results.length, 3, '应该返回 3 条结果');
    assert.ok(results.every(r => r.ok), '所有记录应该成功');
  });
});

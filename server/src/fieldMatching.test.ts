import assert from 'node:assert/strict';
import test from 'node:test';
import type { TableField } from '../../src/components/document-generator/types';
import { matchField, normalizeFieldName } from '../../src/components/document-generator/fieldMatching';

function field(id: string, name: string, type: TableField['type'] = 'text'): TableField {
  return { id, name, type, icon: '' };
}

test('字段名归一化会去掉装饰字符，避免云文档变量和表格字段只因格式不同而匹配失败', () => {
  assert.equal(normalizeFieldName('  客户 名称  '), '客户名称');
  assert.equal(normalizeFieldName('Customer_Name'), 'customername');
  assert.equal(normalizeFieldName('【报价】(2026)'), '报价2026');
});

test('Docx 智能匹配先按字段名精确匹配，再回退到模板里的 suggested 字段', () => {
  const fields = [
    field('suggested_name', '客户全称'),
    field('exact_name', '客户名称'),
  ];

  assert.equal(
    matchField('客户名称', fields, {
      strategy: 'exact',
      suggestedId: 'suggested_name',
    })?.id,
    'exact_name',
  );

  assert.equal(
    matchField('客户', fields, {
      strategy: 'exact',
      suggestedId: 'suggested_name',
    })?.id,
    'suggested_name',
  );
});

test('字段兼容性过滤会阻止图片变量匹配到文本字段', () => {
  const fields = [
    field('text_photo', '照片', 'text'),
    field('attachment_photo', '照片附件', 'attachment'),
  ];

  assert.equal(
    matchField('照片', fields, {
      strategy: 'normalized',
      allowContains: true,
      compatible: (candidate) => candidate.type === 'attachment',
    })?.id,
    'attachment_photo',
  );
});

test('云文档字段匹配无精确匹配时允许归一化包含匹配', () => {
  const fields = [field('customer_full_name', '客户全称信息')];

  assert.equal(
    matchField('客户', fields, {
      strategy: 'normalized',
      allowContains: true,
    })?.id,
    'customer_full_name',
  );
});

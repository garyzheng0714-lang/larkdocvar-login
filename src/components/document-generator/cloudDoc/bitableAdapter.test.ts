import assert from 'node:assert/strict';
import test from 'node:test';
import { FieldType } from '@lark-base-open/js-sdk';
import type { ITable } from '@lark-base-open/js-sdk';
import {
  ensureOutputField,
  getCloudDocOutputFields,
  readMappedVariables,
} from './bitableAdapter';
import type { TableField } from '../types';

test('云文档写回字段允许文本类、URL 和公司字段，避免把链接写进附件等不兼容字段', () => {
  const fields: TableField[] = [
    { id: 'text', name: '文本', type: 'text', icon: '' },
    { id: 'url', name: '链接', type: 'text', rawType: FieldType.Url, icon: '' },
    { id: 'company', name: '公司', type: 'text', rawType: FieldType.Object, icon: '' },
    { id: 'attachment', name: '附件', type: 'attachment', rawType: FieldType.Attachment, icon: '' },
  ];

  assert.deepEqual(getCloudDocOutputFields(fields).map((field) => field.id), ['text', 'url', 'company']);
});

test('自动写回字段会避开重名字段并刷新字段列表', async () => {
  let refreshed = false;
  const table = {
    async addField(input: { name: string; type: FieldType }) {
      assert.equal(input.name, '生成文档链接2');
      assert.equal(input.type, FieldType.Url);
      return 'new_output_field';
    },
  } as unknown as ITable;

  const id = await ensureOutputField({
    table,
    fields: [{ id: 'existing', name: '生成文档链接', type: 'text', icon: '' }],
    outputFieldId: '__auto_output_field__',
    refreshBitable: async () => {
      refreshed = true;
    },
  });

  assert.equal(id, 'new_output_field');
  assert.equal(refreshed, true);
});

test('读取映射变量必须使用 stringValue 分页结果，并按记录独立组装变量', async () => {
  const calls: unknown[] = [];
  const table = {
    async getRecordsByPage(input: unknown) {
      calls.push(input);
      return {
        hasMore: false,
        records: [
          { recordId: 'rec1', fields: { f_name: [{ text: '甲' }], f_date: '2026-05-31' } },
          { recordId: 'rec2', fields: { f_name: [{ name: '乙' }], f_date: '2026-06-01' } },
        ],
      };
    },
  } as unknown as ITable;

  const rows = await readMappedVariables(table, ['rec1', 'rec2'], ['姓名', '日期'], {
    姓名: 'f_name',
    日期: 'f_date',
  });

  assert.deepEqual(calls, [{ pageSize: 200, pageToken: undefined, stringValue: true }]);
  assert.deepEqual(rows, [
    { recordId: 'rec1', variables: { 姓名: '甲', 日期: '2026-05-31' } },
    { recordId: 'rec2', variables: { 姓名: '乙', 日期: '2026-06-01' } },
  ]);
});

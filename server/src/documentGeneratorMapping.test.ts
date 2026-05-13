import assert from 'node:assert/strict';
import test from 'node:test';
import { CUSTOM_MAPPING_VALUE, reconcileMapping } from '../../src/components/document-generator/mapping';
import type { TableField, Template } from '../../src/components/document-generator/types';

const template: Template = {
  id: 'tpl',
  name: '离职证明',
  varCount: 3,
  updatedAt: '今天',
  category: '证明类',
  kind: 'doc',
  variables: [
    { name: '姓名', kind: 'text' },
    { name: '证件号', kind: 'text' },
    { name: '照片', kind: 'image' },
  ],
};

test('切换子表后字段映射会丢弃旧表字段并按当前表重新匹配', () => {
  const previous = {
    姓名: 'old_name',
    证件号: 'old_id',
    照片: 'old_photo',
  };
  const newTableFields: TableField[] = [
    { id: 'new_name', name: '姓名', type: 'text', icon: '' },
    { id: 'new_id', name: '证件号', type: 'text', icon: '' },
    { id: 'new_photo', name: '照片', type: 'attachment', icon: '' },
  ];

  assert.deepEqual(reconcileMapping(template, newTableFields, previous), {
    姓名: 'new_name',
    证件号: 'new_id',
    照片: 'new_photo',
  });
});

test('字段刷新会保留当前表内仍合法的手动选择', () => {
  const previous = {
    姓名: 'manual_name',
    证件号: 'old_id',
  };
  const fields: TableField[] = [
    { id: 'manual_name', name: '员工姓名', type: 'text', icon: '' },
    { id: 'new_id', name: '证件号', type: 'text', icon: '' },
    { id: 'wrong_photo', name: '照片', type: 'text', icon: '' },
  ];

  assert.deepEqual(reconcileMapping(template, fields, previous), {
    姓名: 'manual_name',
    证件号: 'new_id',
  });
});

test('字段刷新允许显式保留固定值映射', () => {
  const previous = {
    姓名: CUSTOM_MAPPING_VALUE,
    证件号: 'old_id',
  };
  const fields: TableField[] = [
    { id: 'new_name', name: '姓名', type: 'text', icon: '' },
    { id: 'new_id', name: '证件号', type: 'text', icon: '' },
  ];

  assert.deepEqual(reconcileMapping(template, fields, previous, { allowCustom: true }), {
    姓名: CUSTOM_MAPPING_VALUE,
    证件号: 'new_id',
  });
});

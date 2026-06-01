import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDefaultMapping } from './mapping';
import type { TableField, Template } from './types';

function field(id: string, name: string): TableField {
  return { id, name, type: 1, icon: '' } as unknown as TableField;
}

test('Word 模板变量带星号时仍按同名表格字段智能匹配', () => {
  const template: Template = {
    id: 'tpl_contract',
    name: '合同模板',
    varCount: 2,
    updatedAt: '今天',
    category: '合同类',
    kind: 'doc',
    visibility: 'shared',
    variables: [
      { name: '合同编号*', kind: 'text' },
      { name: '乙方电话*', kind: 'text' },
    ],
  };

  assert.deepEqual(
    buildDefaultMapping(template, [field('fld_contract_no', '合同编号'), field('fld_phone', '乙方电话')]),
    {
      '合同编号*': 'fld_contract_no',
      '乙方电话*': 'fld_phone',
    },
  );
});

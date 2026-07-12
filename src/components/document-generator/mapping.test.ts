import assert from 'node:assert/strict';
import test from 'node:test';
import { FieldType } from '@lark-base-open/js-sdk';
import { buildDefaultMapping, reconcileMapping } from './mapping';
import type { TableField, Template } from './types';

function field(id: string, name: string, type: TableField['type'] = 'text', rawType?: number): TableField {
  return { id, name, type, rawType, icon: '' };
}

function textTemplate(names: string[]): Template {
  return {
    id: 'tpl', name: 't', varCount: names.length, updatedAt: '今天', category: 'c', kind: 'doc', visibility: 'shared',
    variables: names.map((name) => ({ name, kind: 'text' as const })),
  };
}

test('reconcileMapping 尊重用户显式清空的绑定，不因选区变化被智能匹配偷偷绑回', () => {
  const template = textTemplate(['客户名称', '金额']);
  const fields = [field('fld_customer', '客户名称'), field('fld_amount', '金额')];
  // 客户名称 被用户显式清空为 ''；金额 从未设置（无 key）。
  const result = reconcileMapping(template, fields, { 客户名称: '' }, { allowCustom: true });
  assert.equal(result['客户名称'], '', '显式清空的绑定必须保持空，绝不能被 fld_customer 重新绑回');
  assert.equal(result['金额'], 'fld_amount', '从未设置过的变量仍应智能匹配');
});

test('reconcileMapping 保留用户手选的有效字段，不被智能匹配覆盖', () => {
  const template = textTemplate(['客户名称']);
  const fields = [field('fld_a', '甲'), field('fld_customer', '客户名称')];
  const result = reconcileMapping(template, fields, { 客户名称: 'fld_a' }, { allowCustom: true });
  assert.equal(result['客户名称'], 'fld_a', '用户手选的有效字段必须保留');
});

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

test('公司对象字段按文本类字段参与 Word 模板变量匹配', () => {
  const template: Template = {
    id: 'tpl_contract_company',
    name: '合同模板',
    varCount: 1,
    updatedAt: '今天',
    category: '合同类',
    kind: 'doc',
    visibility: 'shared',
    variables: [{ name: '合同公司名', kind: 'text' }],
  };

  assert.deepEqual(
    buildDefaultMapping(template, [field('fld_company', '合同公司名', 'text', FieldType.Object)]),
    { 合同公司名: 'fld_company' },
  );
});

import assert from 'node:assert/strict';
import test from 'node:test';
import type { TableField } from './types';
import { normalizeFieldName } from './fieldMatching';
import { findBestMatchedField, stringifyCellValue } from './cloudFieldMapping';

// 这些纯函数此前内联在 CloudDocGeneratorApp.tsx（747 行上帝组件）里，无任何测试。
// 提取到独立模块并锁住行为，改善 locality，且不触碰 React 渲染（可用 node --test 验证）。
// 字段名归一化由 fieldMatching.ts 统一提供，云文档模式仍额外允许包含匹配。

function field(id: string, name: string): TableField {
  return { id, name, type: 1, icon: '' } as unknown as TableField;
}

test('normalizeFieldName 去空白、转小写、剥离括号下划线等装饰字符', () => {
  assert.equal(normalizeFieldName('  客户 名称  '), '客户名称');
  assert.equal(normalizeFieldName('Customer_Name'), 'customername');
  assert.equal(normalizeFieldName('【报价】(2026)'), '报价2026');
});

test('findBestMatchedField 优先精确匹配归一化后的字段名', () => {
  const fields = [field('f1', '客户名称'), field('f2', '客户')];
  assert.equal(findBestMatchedField('客户名称', fields)?.id, 'f1');
});

test('findBestMatchedField 无精确匹配时回退到包含匹配', () => {
  const fields = [field('f1', '客户全称信息')];
  assert.equal(findBestMatchedField('客户', fields)?.id, 'f1');
});

test('findBestMatchedField 变量为空或无任何匹配时返回 undefined', () => {
  const fields = [field('f1', '日期')];
  assert.equal(findBestMatchedField('', fields), undefined);
  assert.equal(findBestMatchedField('金额', fields), undefined);
});

test('stringifyCellValue 处理字符串/数字/布尔的标量值', () => {
  assert.equal(stringifyCellValue('hello'), 'hello');
  assert.equal(stringifyCellValue(42), '42');
  assert.equal(stringifyCellValue(true), 'true');
  assert.equal(stringifyCellValue(null), '');
  assert.equal(stringifyCellValue(undefined), '');
});

test('stringifyCellValue 递归拼接数组并过滤空值', () => {
  assert.equal(stringifyCellValue([{ text: '甲' }, { text: '乙' }]), '甲乙');
});

test('stringifyCellValue 从对象按 text/name/title 顺序取文本', () => {
  assert.equal(stringifyCellValue({ text: 'T' }), 'T');
  assert.equal(stringifyCellValue({ name: 'N' }), 'N');
  assert.equal(stringifyCellValue({ title: 'TI' }), 'TI');
});

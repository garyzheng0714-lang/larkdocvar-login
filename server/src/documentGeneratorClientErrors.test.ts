import assert from 'node:assert/strict';
import test from 'node:test';
import { __test__ as generatorClient } from '../../src/components/document-generator/useGenerate';

test('批量生成接口的变量错误要保留后端给出的 missingVariables/unusedVariables 明细', () => {
  assert.equal(
    generatorClient.formatBatchRecordError({
      recordId: 'rec_1',
      ok: false,
      error: '还有变量没有填写，请补齐后再生成。',
      missingVariables: ['金额', '联系人'],
    }),
    '还有变量没有填写，请补齐后再生成。缺少：金额、联系人',
  );

  assert.equal(
    generatorClient.formatBatchRecordError({
      recordId: 'rec_2',
      ok: false,
      error: '有变量没有出现在模板中，请检查变量名。',
      unusedVariables: ['旧字段'],
    }),
    '有变量没有出现在模板中，请检查变量名。未使用：旧字段',
  );
});

test('HTTP 失败响应要显示可读 JSON 错误，不退化成 HTTP 状态码', async () => {
  const response = new Response(
    JSON.stringify({
      ok: false,
      error: '还有变量没有填写，请补齐后再生成。',
      missingVariables: ['金额'],
    }),
    {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    },
  );

  assert.equal(
    await generatorClient.readBatchResponseError(response),
    '还有变量没有填写，请补齐后再生成。缺少：金额',
  );
});

test('字段读取失败必须显示读取失败，不能伪装成当前记录字段值为空', () => {
  assert.equal(
    generatorClient.formatFieldReadError('乙方电话'),
    '读取变量「乙方电话」对应字段失败，请检查字段权限或刷新字段后重试。',
  );

  assert.notEqual(
    generatorClient.formatFieldReadError('乙方电话'),
    '当前记录中「乙方电话」对应字段的值为空。',
  );
});

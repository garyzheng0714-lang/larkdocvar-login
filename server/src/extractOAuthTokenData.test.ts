import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractOAuthTokenData } from './auth';

describe('extractOAuthTokenData', () => {
  it('从 body.data 提取嵌套对象', () => {
    const body = { data: { access_token: 'tok_123', expires_in: 7200 } };
    const result = extractOAuthTokenData(body);
    assert.deepEqual(result, { access_token: 'tok_123', expires_in: 7200 });
  });

  it('body.data 不存在时返回 body 本身', () => {
    const body = { access_token: 'tok_456', expires_in: 3600 };
    const result = extractOAuthTokenData(body);
    assert.equal(result, body);
  });

  it('body.data 是非对象类型时返回 body 本身', () => {
    const body = { data: 'string_value' };
    const result = extractOAuthTokenData(body);
    assert.equal(result, body);
  });

  it('body.data 是 null 时返回 body 本身', () => {
    const body = { data: null };
    const result = extractOAuthTokenData(body);
    assert.equal(result, body);
  });
});

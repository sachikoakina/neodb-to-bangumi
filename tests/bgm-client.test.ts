import { describe, expect, it } from 'vitest';
import { bangumiGot, retriesMethod } from '../src/clients/bangumi-http';

describe('Bangumi 共享实例', () => {
  it('只对幂等方法重试：GET / PUT 是，POST / PATCH / DELETE 不是', () => {
    expect(retriesMethod('GET')).toBe(true);
    expect(retriesMethod('PUT')).toBe(true);
    expect(retriesMethod('POST')).toBe(false);
    expect(retriesMethod('PATCH')).toBe(false);
    expect(retriesMethod('DELETE')).toBe(false);
  });

  it('重试上限与状态码符合预期', () => {
    const retry = bangumiGot.defaults.options.retry;
    expect(retry.limit).toBe(2);
    expect(retry.statusCodes).toContain(429);
    expect(retry.statusCodes).toContain(500);
    expect(retry.statusCodes).toContain(503);
  });

  it('重试方法集合不含 POST', () => {
    const methods = bangumiGot.defaults.options.retry.methods ?? [];
    expect(methods).toContain('GET');
    expect(methods).toContain('PUT');
    expect(methods).not.toContain('POST');
  });

  it('设置请求超时，避免挂死整轮', () => {
    expect(bangumiGot.defaults.options.timeout.request).toBe(30000);
  });
});

import { describe, expect, it } from 'vitest';
import { classifyWriteFailure, summarizeErrorBody } from '../src/rules/write-result';

describe('写入失败归因', () => {
  it('401/403 → auth：凭据失效，必须中止整轮', () => {
    expect(classifyWriteFailure(401)).toBe('auth');
    expect(classifyWriteFailure(403)).toBe('auth');
  });

  it('404 → not-found：服务端拒绝建收藏，重试无意义', () => {
    expect(classifyWriteFailure(404)).toBe('not-found');
  });

  it('5xx / 4xx 其余 / 无响应 → transient：下轮可重试', () => {
    expect(classifyWriteFailure(500)).toBe('transient');
    expect(classifyWriteFailure(502)).toBe('transient');
    expect(classifyWriteFailure(429)).toBe('transient');
    expect(classifyWriteFailure(400)).toBe('transient');
    expect(classifyWriteFailure(null)).toBe('transient');
  });

  it('错误体摘要优先取 title / description 并压成单行', () => {
    expect(
      summarizeErrorBody({ title: 'Not Found', description: 'subject not found' }),
    ).toBe('Not Found: subject not found');
    expect(summarizeErrorBody({ message: 'boom' })).toBe('boom');
    expect(summarizeErrorBody('  line1\nline2  ')).toBe('line1 line2');
  });

  it('空体返回空串（调用方据此决定是否拼接）', () => {
    expect(summarizeErrorBody(null)).toBe('');
    expect(summarizeErrorBody(undefined)).toBe('');
    expect(summarizeErrorBody({})).toBe('');
    expect(summarizeErrorBody('   ')).toBe('');
  });

  it('超长错误体截断，避免把整包响应塞进日志', () => {
    const long = 'x'.repeat(400);
    const summary = summarizeErrorBody(long);
    expect(summary.length).toBe(301);
    expect(summary.endsWith('…')).toBe(true);
  });
});

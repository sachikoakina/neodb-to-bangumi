import { describe, expect, it } from 'vitest';
import { decideExitCode } from '../src/rules/exit-code';

const base = { aborted: false, invariantOk: true, failed: 0, failOnItemErrors: false };

describe('退出码分级', () => {
  it('认证中止 → 2（凭据失效必须人工介入）', () => {
    expect(decideExitCode({ ...base, aborted: true })).toBe(2);
  });

  it('报告恒等式破坏 → 1，即使没有失败条目', () => {
    expect(decideExitCode({ ...base, invariantOk: false })).toBe(1);
  });

  it('默认宽松：条目失败只告警，不判红', () => {
    expect(decideExitCode({ ...base, failed: 3 })).toBe(0);
  });

  it('严格模式：条目失败 → 1', () => {
    expect(decideExitCode({ ...base, failed: 1, failOnItemErrors: true })).toBe(1);
  });

  it('全部正常 → 0', () => {
    expect(decideExitCode(base)).toBe(0);
  });

  it('中止优先于恒等式与条目失败', () => {
    expect(
      decideExitCode({
        aborted: true,
        invariantOk: false,
        failed: 9,
        failOnItemErrors: true,
      }),
    ).toBe(2);
  });
});

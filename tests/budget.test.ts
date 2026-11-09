import { describe, expect, it } from 'vitest';
import { timeBudgetExhausted } from '../src/rules/budget';

describe('单轮时间预算', () => {
  it('0 或负数表示不限制', () => {
    expect(timeBudgetExhausted(10_000_000, 0)).toBe(false);
    expect(timeBudgetExhausted(10_000_000, -1)).toBe(false);
  });

  it('非法预算值按不限制处理', () => {
    expect(timeBudgetExhausted(999, Number.NaN)).toBe(false);
    expect(timeBudgetExhausted(999, Number.POSITIVE_INFINITY)).toBe(false);
  });

  it('未到点继续', () => {
    expect(timeBudgetExhausted(1_000, 2_000)).toBe(false);
  });

  it('恰好到点即停止', () => {
    expect(timeBudgetExhausted(2_000, 2_000)).toBe(true);
  });

  it('已超时停止', () => {
    expect(timeBudgetExhausted(2_500, 2_000)).toBe(true);
  });

  it('非法 elapsed 不触发停止（避免误停）', () => {
    expect(timeBudgetExhausted(Number.NaN, 2_000)).toBe(false);
  });
});

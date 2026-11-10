import { describe, expect, it } from 'vitest';
import { mergeStopReason, timeBudgetExhausted } from '../src/rules/budget';

describe('停止原因合并', () => {
  it('null 视为「尚未中断」，被任何原因覆盖', () => {
    expect(mergeStopReason(null, 'max-items')).toBe('max-items');
    expect(mergeStopReason('time-budget', null)).toBe('time-budget');
    expect(mergeStopReason(null, null)).toBeNull();
  });

  it('截断优先于时间预算，时间预算优先于配额', () => {
    expect(mergeStopReason('max-items', 'time-budget')).toBe('time-budget');
    expect(mergeStopReason('time-budget', 'partial-read')).toBe('partial-read');
    expect(mergeStopReason('max-items', 'partial-read')).toBe('partial-read');
  });

  it('严重度低的原因不会覆盖已记录的高严重度原因', () => {
    expect(mergeStopReason('partial-read', 'max-items')).toBe('partial-read');
    expect(mergeStopReason('partial-read', 'time-budget')).toBe('partial-read');
    expect(mergeStopReason('time-budget', 'max-items')).toBe('time-budget');
  });

  it('同原因重复合并保持稳定', () => {
    expect(mergeStopReason('max-items', 'max-items')).toBe('max-items');
    expect(mergeStopReason('partial-read', 'partial-read')).toBe('partial-read');
  });
});

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

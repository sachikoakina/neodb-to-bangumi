import { describe, expect, it } from 'vitest';
import { nextCheckAt, recheckDelayDays, shouldRecheck } from '../src/rules/recheck';

const now = new Date('2026-11-09T00:00:00.000Z');
const DAY = 86_400_000;

describe('退避阶梯', () => {
  it('按 1 / 2 / 4 / 7 天递增并封顶', () => {
    expect([1, 2, 3, 4, 5, 99].map((n) => recheckDelayDays(n, 30))).toEqual([
      1, 2, 4, 7, 7, 7,
    ]);
  });

  it('attempts 为 0 或负数按第一次处理', () => {
    expect(recheckDelayDays(0, 30)).toBe(1);
    expect(recheckDelayDays(-3, 30)).toBe(1);
  });

  it('上限天数小于阶梯值时按上限封顶', () => {
    expect([1, 2, 3, 4].map((n) => recheckDelayDays(n, 3))).toEqual([1, 2, 3, 3]);
  });

  it('上限为 0 或非法 → 不避让', () => {
    expect(recheckDelayDays(2, 0)).toBe(0);
    expect(recheckDelayDays(2, -1)).toBe(0);
    expect(recheckDelayDays(2, Number.NaN)).toBe(0);
  });
});

describe('下次复查时间', () => {
  it('按天数推进', () => {
    expect(nextCheckAt(2, now, 30)).toBe(
      new Date(now.getTime() + 2 * DAY).toISOString(),
    );
  });

  it('已封顶时用最后一档', () => {
    expect(nextCheckAt(9, now, 30)).toBe(
      new Date(now.getTime() + 7 * DAY).toISOString(),
    );
  });

  it('关闭退避时返回 undefined', () => {
    expect(nextCheckAt(1, now, 0)).toBeUndefined();
  });
});

describe('是否该复查', () => {
  it('无记录 → 该查', () => {
    expect(shouldRecheck(undefined, now, 7)).toBe(true);
  });

  it('没有 nextCheckAt → 该查', () => {
    expect(shouldRecheck({ attempts: 3 }, now, 7)).toBe(true);
  });

  it('未来时间 → 不查（退避生效）', () => {
    expect(
      shouldRecheck(
        { attempts: 1, nextCheckAt: new Date(now.getTime() + DAY).toISOString() },
        now,
        7,
      ),
    ).toBe(false);
  });

  it('已过期 → 该查', () => {
    expect(
      shouldRecheck(
        {
          attempts: 1,
          nextCheckAt: new Date(now.getTime() - DAY).toISOString(),
        },
        now,
        7,
      ),
    ).toBe(true);
  });

  it('恰好到点 → 该查', () => {
    expect(shouldRecheck({ attempts: 1, nextCheckAt: now.toISOString() }, now, 7)).toBe(
      true,
    );
  });

  it('非法时间戳 → 该查（脏数据不能把缺口永久锁死）', () => {
    expect(shouldRecheck({ attempts: 2, nextCheckAt: 'not-a-date' }, now, 7)).toBe(
      true,
    );
  });

  it('关闭退避 → 每轮都查', () => {
    expect(
      shouldRecheck(
        { attempts: 9, nextCheckAt: new Date(now.getTime() + 7 * DAY).toISOString() },
        now,
        0,
      ),
    ).toBe(true);
  });
});

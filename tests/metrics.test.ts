import { afterEach, describe, expect, it } from 'vitest';
import {
  addItemTime,
  addStageTime,
  metricsSnapshot,
  percentile,
  recordSleep,
  resetMetrics,
  sleepCount,
  sleepMs,
  timeStage,
} from '../src/metrics';

describe('分位数（最近秩）', () => {
  it('空数组返回 0', () => {
    expect(percentile([], 0.5)).toBe(0);
  });

  it('单元素返回自身', () => {
    expect(percentile([7], 0.9)).toBe(7);
  });

  it('偶数长度按最近秩取上界', () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2);
    expect(percentile([1, 2, 3, 4], 0.9)).toBe(4);
  });

  it('不修改入参顺序', () => {
    const values = [3, 1, 2];
    percentile(values, 0.5);
    expect(values).toEqual([3, 1, 2]);
  });
});

describe('指标累加', () => {
  afterEach(() => {
    resetMetrics();
  });

  it('reset 后快照为零', () => {
    addStageTime('read', 10);
    addItemTime(99);
    recordSleep('bangumi', 400);
    resetMetrics();

    const snapshot = metricsSnapshot();
    expect(snapshot.stages.read).toEqual({
      count: 0,
      totalMs: 0,
      p50Ms: 0,
      p90Ms: 0,
      maxMs: 0,
    });
    expect(snapshot.items.count).toBe(0);
    expect(snapshot.sleeps.bangumi).toBe(0);
    expect(snapshot.sleepMs.bangumi).toBe(0);
  });

  it('阶段与条目分别统计，p90 取高位', () => {
    addStageTime('read', 10);
    addStageTime('read', 30);
    addStageTime('read', 20);
    addItemTime(50);
    addItemTime(150);

    const snapshot = metricsSnapshot();
    expect(snapshot.stages.read.count).toBe(3);
    expect(snapshot.stages.read.totalMs).toBe(60);
    expect(snapshot.stages.read.p50Ms).toBe(20);
    expect(snapshot.stages.read.p90Ms).toBe(30);
    expect(snapshot.stages.read.maxMs).toBe(30);
    expect(snapshot.items.count).toBe(2);
    expect(snapshot.items.maxMs).toBe(150);
  });

  it('负数与 NaN 不计入', () => {
    addStageTime('match', -1);
    addStageTime('match', Number.NaN);
    addItemTime(-5);
    expect(metricsSnapshot().stages.match.count).toBe(0);
    expect(metricsSnapshot().items.count).toBe(0);
  });

  it('等待的次数与毫秒分开计：delay=0 仍计入次数', () => {
    recordSleep('bangumi', 0);
    recordSleep('bangumi', 400);
    expect(sleepCount('bangumi')).toBe(2);
    expect(sleepMs('bangumi')).toBe(400);
  });

  it('两个 host 互不干扰', () => {
    recordSleep('bangumi', 400);
    recordSleep('neodb', 300);
    const snapshot = metricsSnapshot();
    expect(snapshot.sleeps).toEqual({ bangumi: 1, neodb: 1 });
    expect(snapshot.sleepMs).toEqual({ bangumi: 400, neodb: 300 });
  });
});

describe('timeStage', () => {
  afterEach(() => {
    resetMetrics();
  });

  it('正常返回并把耗时记到对应阶段', async () => {
    const value = await timeStage('write', async () => 'ok');
    expect(value).toBe('ok');
    expect(metricsSnapshot().stages.write.count).toBe(1);
  });

  it('抛异常时同样计时，不吞掉错误', async () => {
    await expect(
      timeStage('episode', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(metricsSnapshot().stages.episode.count).toBe(1);
  });
});

import { describe, expect, it } from 'vitest';
import {
  assertReportInvariant,
  createReport,
  record,
  renderSummaryMarkdown,
  upsertUnmatched,
} from '../src/sync-report';

describe('PathReport 恒等式', () => {
  it('初始为全零且成立', () => {
    const report = createReport();
    expect(assertReportInvariant(report)).toBe(true);
  });

  it('各 outcome 计入后仍满足 scanned = 五项之和', () => {
    const report = createReport();
    // 遍历方先对每条扫描 +1；record 只记 outcome。
    report.scanned = 7;
    record(report, 'written');
    record(report, 'unchanged');
    record(report, 'unchanged');
    record(report, 'skipped');
    record(report, 'unresolved');
    record(report, 'failed');
    record(report, 'written');
    expect(report).toEqual({
      scanned: 7,
      written: 2,
      unchanged: 2,
      skipped: 1,
      unresolved: 1,
      failed: 1,
    });
    expect(assertReportInvariant(report)).toBe(true);
  });

  it('计数不满足恒等式时能被发现', () => {
    const broken = { ...createReport(), scanned: 5 };
    expect(assertReportInvariant(broken)).toBe(false);
  });
});

describe('待核对名单 upsert', () => {
  it('同一条目重复未命中只刷新 lastSeenAt，firstSeenAt 不动', () => {
    const map = new Map();
    upsertUnmatched(map, 'uuid-1', {
      reason: 'no-bangumi-match',
      title: 'A',
      itemUrl: 'https://neodb.social/movie/abc',
    });
    const first = map.get('uuid-1')!;
    upsertUnmatched(map, 'uuid-1', {
      reason: 'no-bangumi-match',
      title: 'A',
      itemUrl: 'https://neodb.social/movie/abc',
    });
    const second = map.get('uuid-1')!;
    expect(second.firstSeenAt).toBe(first.firstSeenAt);
    expect(second.lastSeenAt >= first.lastSeenAt).toBe(true);
    expect(map.size).toBe(1);
  });
});

describe('摘要渲染', () => {
  it('包含计数表与截断告警', () => {
    const report = createReport();
    record(report, 'written');
    const md = renderSummaryMarkdown(report, {
      startedAt: '2026-11-05T00:00:00Z',
      finishedAt: '2026-11-05T00:01:00Z',
      dryRun: true,
      fullSync: true,
      shelves: ['wishlist', 'complete'],
      truncatedShelves: ['complete'],
      unmatchedCount: 3,
    });
    expect(md).toContain('dry-run（written 为计划，未提交）');
    expect(md).toContain('全量');
    expect(md).toContain('未遍历完整');
    expect(md).toContain('待核对名单条目数：3');
  });
});

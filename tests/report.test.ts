import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertReportInvariant,
  buildMatchAuditDocument,
  createReport,
  dryRunUnmatchedPath,
  pruneUnmatched,
  record,
  renderSummaryMarkdown,
  saveMatchAudit,
  upsertUnmatched,
  type MatchAuditEntry,
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

  it('记录分类/书架/uuid 元数据，便于人工核对', () => {
    const map = new Map();
    upsertUnmatched(map, 'uuid-2', {
      reason: 'ambiguous-bangumi-match',
      title: '同名作品',
      itemUrl: 'https://neodb.social/tv/xyz',
      category: 'tv',
      shelf: 'complete',
      neodbUuid: 'uuid-2',
    });
    expect(map.get('uuid-2')).toMatchObject({
      category: 'tv',
      shelf: 'complete',
      neodbUuid: 'uuid-2',
      reason: 'ambiguous-bangumi-match',
    });
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

  it('按原因渲染待核对分布', () => {
    const md = renderSummaryMarkdown(createReport(), {
      startedAt: '2026-11-05T00:00:00Z',
      finishedAt: '2026-11-05T00:01:00Z',
      dryRun: false,
      fullSync: false,
      shelves: ['complete'],
      truncatedShelves: [],
      unmatchedCount: 5,
      unmatchedByReason: {
        'no-bangumi-match': 3,
        'ambiguous-bangumi-match': 2,
      },
    });
    expect(md).toContain('| 待核对原因 | 条目数 |');
    expect(md).toContain('| no-bangumi-match | 3 |');
    expect(md).toContain('| ambiguous-bangumi-match | 2 |');
  });
});

describe('待核对名单老化清理', () => {
  const now = new Date('2026-11-08T00:00:00.000Z');

  function entry(lastSeenAt: string) {
    return {
      source: 'neodb-bangumi' as const,
      reason: 'no-bangumi-match',
      title: 'A',
      itemUrl: 'https://neodb.social/movie/a',
      firstSeenAt: lastSeenAt,
      lastSeenAt,
    };
  }

  it('过期条目删除，未过期保留；恰好等于截止时间保留', () => {
    const entries = new Map([
      ['old', entry('2026-10-01T00:00:00.000Z')],
      ['exact', entry('2026-10-09T00:00:00.000Z')],
      ['fresh', entry('2026-11-07T00:00:00.000Z')],
    ]);
    const result = pruneUnmatched(entries, 30, now);
    expect(result.removed).toBe(1);
    expect([...result.entries.keys()]).toEqual(['exact', 'fresh']);
  });

  it('maxAgeDays 为 0 或负数时不清理', () => {
    const entries = new Map([['old', entry('2000-01-01T00:00:00.000Z')]]);
    expect(pruneUnmatched(entries, 0, now).removed).toBe(0);
    expect(pruneUnmatched(entries, -5, now).removed).toBe(0);
    expect(pruneUnmatched(entries, Number.NaN, now).removed).toBe(0);
  });

  it('无效 lastSeenAt 保留，避免脏数据误删', () => {
    const entries = new Map([['broken', entry('not-a-date')]]);
    const result = pruneUnmatched(entries, 30, now);
    expect(result.removed).toBe(0);
    expect(result.entries.has('broken')).toBe(true);
  });

  it('返回新 Map，不修改入参', () => {
    const entries = new Map([['old', entry('2000-01-01T00:00:00.000Z')]]);
    const result = pruneUnmatched(entries, 30, now);
    expect(entries.size).toBe(1);
    expect(result.entries.size).toBe(0);
  });

  it('空 Map 返回 removed = 0', () => {
    expect(pruneUnmatched(new Map(), 30, now)).toEqual({
      entries: new Map(),
      removed: 0,
    });
  });
});

describe('匹配审计文档', () => {
  const entry: MatchAuditEntry = {
    uuid: 'abc123',
    label: '猫鼠游戏',
    category: 'movie',
    shelf: 'complete',
    via: 'title',
    subjectId: 407681,
    subjectName: '猫鼠游戏',
    sourceYear: 2002,
    sourceMediaForm: 'movie',
    candidateYear: null,
    candidateMediaForm: null,
    candidates: [407681],
    strictHold: false,
    outcome: 'written',
    reason: 'status',
  };

  const meta = {
    startedAt: '2026-11-08T00:00:00.000Z',
    finishedAt: '2026-11-08T01:00:00.000Z',
    dryRun: true,
    fullSync: true,
    matchStrict: true,
    yearTolerance: 1,
  };

  it('文档携带版本与运行元数据，条目原样透传', () => {
    const doc = buildMatchAuditDocument(meta, [entry]);
    expect(doc).toEqual({ version: 1, ...meta, entries: [entry] });
  });

  it('dry-run 也能落盘：文件可读回且内容一致', () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-'));
    try {
      const path = join(dir, 'nested', 'match-audit.json');
      const doc = buildMatchAuditDocument(meta, [entry]);
      saveMatchAudit(path, doc);
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(doc);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('dry-run 待核对路径派生', () => {
  it('.json 后缀前插入 -dryrun', () => {
    expect(dryRunUnmatchedPath('.cache/unmatched.json')).toBe(
      '.cache/unmatched-dryrun.json',
    );
  });

  it('无后缀时补 .json', () => {
    expect(dryRunUnmatchedPath('.cache/unmatched')).toBe(
      '.cache/unmatched-dryrun.json',
    );
  });
});

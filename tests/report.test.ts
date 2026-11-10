import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertReportInvariant,
  buildMatchAuditDocument,
  createReport,
  dryRunUnmatchedPath,
  loadUnmatched,
  record,
  renderFailureAnnotations,
  renderSummaryMarkdown,
  saveMatchAudit,
  saveUnmatched,
  type MatchAuditEntry,
  type UnmatchedEntry,
} from '../src/sync-report';

function entry(partial: Partial<UnmatchedEntry> = {}): UnmatchedEntry {
  return {
    source: 'neodb-bangumi',
    kind: 'unresolved',
    reason: 'no-bangumi-match',
    title: '海底两万里',
    itemUrl: 'https://neodb.social/book/1',
    category: 'book',
    shelf: 'progress',
    neodbUuid: 'uuid-1',
    firstSeenAt: '2026-11-04T16:06:16Z',
    lastSeenAt: '2026-11-09T16:06:16Z',
    seenRounds: 1,
    missedRounds: 0,
    ...partial,
  };
}

function withTempFile(run: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'unmatched-'));
  try {
    run(join(dir, 'nested', 'unmatched.json'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('PathReport 恒等式', () => {
  it('初始为全零且成立', () => {
    const report = createReport();
    expect(assertReportInvariant(report)).toBe(true);
  });

  it('各 outcome 计入后仍满足 scanned = 五项之和', () => {
    const report = createReport();
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

describe('待核对名单落盘', () => {
  it('写入带版本的信封，读回字段一致', () => {
    withTempFile((path) => {
      const entries = [entry(), entry({ neodbUuid: 'uuid-2', kind: 'failed' })];
      saveUnmatched(path, entries);
      const doc = JSON.parse(readFileSync(path, 'utf8'));
      expect(doc.version).toBe(2);
      expect(typeof doc.updatedAt).toBe('string');
      expect(doc.entries).toHaveLength(2);
      expect(loadUnmatched(path)).toEqual(entries);
    });
  });

  it('文件不存在时返回空名单', () => {
    withTempFile((path) => {
      expect(loadUnmatched(path)).toEqual([]);
    });
  });

  it('版本不符按空名单重建', () => {
    withTempFile((path) => {
      saveUnmatched(path, [entry()]);
      const doc = JSON.parse(readFileSync(path, 'utf8'));
      writeFileSync(path, JSON.stringify({ ...doc, version: 1 }), 'utf8');
      expect(loadUnmatched(path)).toEqual([]);
    });
  });

  it('条目缺少必需字段时整份重建，不做局部修补', () => {
    withTempFile((path) => {
      saveUnmatched(path, [entry()]);
      const doc = JSON.parse(readFileSync(path, 'utf8'));
      const broken = { ...doc.entries[0] };
      delete broken.seenRounds;
      writeFileSync(path, JSON.stringify({ ...doc, entries: [broken] }), 'utf8');
      expect(loadUnmatched(path)).toEqual([]);
    });
  });

  it('非法 JSON 按空名单重建', () => {
    withTempFile((path) => {
      saveUnmatched(path, [entry()]);
      writeFileSync(path, '{ not json', 'utf8');
      expect(loadUnmatched(path)).toEqual([]);
    });
  });
});

describe('摘要渲染', () => {
  const baseCtx = {
    startedAt: '2026-11-05T00:00:00Z',
    finishedAt: '2026-11-05T00:01:00Z',
    dryRun: false,
    fullSync: false,
    shelves: ['complete'] as const,
    truncatedShelves: [],
  };

  it('包含计数表与截断告警', () => {
    const report = createReport();
    record(report, 'written');
    const md = renderSummaryMarkdown(report, {
      ...baseCtx,
      dryRun: true,
      fullSync: true,
      shelves: ['wishlist', 'complete'],
      truncatedShelves: ['complete'],
    });
    expect(md).toContain('dry-run（written 为计划，未提交）');
    expect(md).toContain('全量');
    expect(md).toContain('未遍历完整');
    expect(md).toContain('## 待核对名单（0 条）');
    expect(md).toContain('本轮无待核对条目。');
  });

  it('接入待核对清单：分组标题、条目行与 subject 后缀', () => {
    const md = renderSummaryMarkdown(createReport(), {
      ...baseCtx,
      startedAt: '2026-11-09T15:58:24Z',
      finishedAt: '2026-11-09T16:06:16Z',
      unmatchedEntries: [
        entry(),
        entry({
          kind: 'skipped',
          reason: 'duplicate-target',
          title: '是，大臣 第二季',
          itemUrl: 'https://neodb.social/tv/2',
          category: 'tv',
          shelf: 'complete',
          subjectId: 16260,
          neodbUuid: 'uuid-2',
        }),
      ],
      unmatchedAdded: [entry()],
    });
    expect(md).toContain('## 待核对名单（2 条）');
    expect(md).toContain('新增 1 · 移除 0 · 观察中 0 · 名单合计 2');
    expect(md).toContain('### NeoDB → Bangumi（2）');
    expect(md).toContain('#### unresolved（1）');
    expect(md).toContain('#### skipped（1）');
    expect(md).toContain(
      ' 1. 海底两万里 — https://neodb.social/book/1 · no-bangumi-match · 已存在 5 天',
    );
    expect(md).toContain('duplicate-target(subject/16260)');
  });

  it('本轮移除逐条列出，名称加删除线并标注原因', () => {
    const removed = [
      { entry: entry({ title: '锦衣卫' }), cause: 'imported' as const },
      {
        entry: entry({ title: '最游记', neodbUuid: 'uuid-3' }),
        cause: 'absent' as const,
      },
    ];
    const md = renderSummaryMarkdown(createReport(), {
      ...baseCtx,
      unmatchedRemoved: removed,
    });
    expect(md).toContain('**本轮移除（2）**');
    expect(md).toContain('~~锦衣卫~~ — ');
    expect(md).toContain('· 已导入');
    expect(md).toContain('· 连续两轮未再出现');
  });

  it('移除全部为缺席型时才使用「连续两轮被扫描到且未再出现」标题', () => {
    const md = renderSummaryMarkdown(createReport(), {
      ...baseCtx,
      unmatchedRemoved: [{ entry: entry({ title: '最游记' }), cause: 'absent' }],
    });
    expect(md).toContain('**本轮移除（1，连续两轮被扫描到且未再出现）**');
  });

  it('观察中单独成块，不计入名单合计', () => {
    const md = renderSummaryMarkdown(createReport(), {
      ...baseCtx,
      unmatchedObserving: [
        entry({ kind: 'failed', reason: 'collection-write-failed' }),
      ],
    });
    expect(md).toContain('**观察中（1，下一轮仍出现才入名单）**');
    expect(md).toContain('## 待核对名单（0 条）');
    expect(md).toContain('本轮无待核对条目。');
  });

  it('冻结条目只说明数量，不进入正文', () => {
    const md = renderSummaryMarkdown(createReport(), {
      ...baseCtx,
      unmatchedFrozen: [entry()],
    });
    expect(md).toContain('本轮有 1 条不在扫描集合里');
    expect(md).toContain('已保留、不计缺席');
  });

  it('不传 metrics 时不出现阶段耗时表（保持旧输出）', () => {
    const md = renderSummaryMarkdown(createReport(), baseCtx);
    expect(md).not.toContain('| 阶段 |');
    expect(md).not.toContain('固定等待');
  });

  it('传入 metrics 时追加阶段耗时表与等待统计', () => {
    const md = renderSummaryMarkdown(createReport(), {
      ...baseCtx,
      metrics: {
        wallMs: 1000,
        sleeps: { bangumi: 2, neodb: 0 },
        sleepMs: { bangumi: 800, neodb: 0 },
        stages: {
          shelf: { count: 4, totalMs: 500, p50Ms: 125, p90Ms: 160, maxMs: 200 },
          match: { count: 0, totalMs: 0, p50Ms: 0, p90Ms: 0, maxMs: 0 },
          read: { count: 1, totalMs: 300, p50Ms: 300, p90Ms: 300, maxMs: 300 },
          write: { count: 0, totalMs: 0, p50Ms: 0, p90Ms: 0, maxMs: 0 },
          episode: { count: 0, totalMs: 0, p50Ms: 0, p90Ms: 0, maxMs: 0 },
        },
        items: { count: 3, totalMs: 900, p50Ms: 300, p90Ms: 400, maxMs: 400 },
      },
    });
    expect(md).toContain('| 阶段 | 次数 | 总耗时 | 占墙钟 |');
    expect(md).toContain('| 书架分页 | 4 | 500ms | 50.0% |');
    expect(md).toContain('| 读目标收藏 | 1 | 300ms | 30.0% |');
    expect(md).toContain('固定等待：Bangumi 2 次');
    expect(md).not.toContain('| 匹配（搜索/候选详情） |');
  });

  it('停止原因会出现在摘要里', () => {
    const md = renderSummaryMarkdown(createReport(), {
      ...baseCtx,
      stopReason: 'time-budget',
    });
    expect(md).toContain('时间预算用尽');
  });

  it('缓存状态被丢弃时摘要标出「按空状态运行」', () => {
    const md = renderSummaryMarkdown(createReport(), {
      ...baseCtx,
      stateReset: 'version-mismatch',
    });
    expect(md).toContain('缓存被丢弃（version-mismatch）');
    expect(md).toContain('按空状态运行');
  });
});

describe('匹配审计文档', () => {
  const auditEntry: MatchAuditEntry = {
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
    const doc = buildMatchAuditDocument(meta, [auditEntry]);
    expect(doc).toEqual({ version: 1, ...meta, entries: [auditEntry] });
  });

  it('dry-run 也能落盘：文件可读回且内容一致', () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-'));
    try {
      const path = join(dir, 'nested', 'match-audit.json');
      const doc = buildMatchAuditDocument(meta, [auditEntry]);
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

describe('失败条目进入 failed 分组', () => {
  it('按 kind 分组，不再单列表格', () => {
    const md = renderSummaryMarkdown(createReport(), {
      startedAt: '2026-11-09T15:58:24Z',
      finishedAt: '2026-11-09T16:06:16Z',
      dryRun: false,
      fullSync: false,
      shelves: ['complete'],
      truncatedShelves: [],
      unmatchedEntries: [
        entry({
          kind: 'failed',
          reason: 'collection-write-failed',
          title: '欢迎来龙餐馆',
          itemUrl: 'https://neodb.social/movie/x',
          category: 'movie',
          shelf: 'complete',
          subjectId: 695934,
          firstSeenAt: '2026-11-09T16:06:16Z',
          lastSeenAt: '2026-11-09T16:06:16Z',
          seenRounds: 2,
        }),
      ],
    });
    expect(md).not.toContain('需要人工处理的条目');
    expect(md).toContain('#### failed（1）');
    expect(md).toContain('collection-write-failed(subject/695934)');
    expect(md).toContain('已存在 0 天');
  });
});

describe('失败注解', () => {
  const auditEntry: MatchAuditEntry = {
    uuid: 'uuid-1',
    label: '欢迎来龙餐馆',
    category: 'movie',
    shelf: 'complete',
    via: 'title',
    subjectId: 695934,
    subjectName: '欢迎来龙餐馆',
    sourceYear: 2026,
    sourceMediaForm: 'movie',
    candidateYear: 2026,
    candidateMediaForm: 'movie',
    candidates: [695934],
    strictHold: false,
    outcome: 'failed',
    reason: 'collection-not-found',
    error: 'collection 695934 returned 404\n第二行 100%',
  };

  it('注解为单行，并转义 % 与换行', () => {
    const [line] = renderFailureAnnotations([auditEntry]);
    expect(line!.startsWith('::warning title=collection-not-found::')).toBe(true);
    expect(line).not.toContain('\n');
    expect(line).toContain('%0A');
    expect(line).toContain('100%25');
    expect(line).toContain('subject/695934');
  });

  it('没有问题时注解为空数组', () => {
    expect(renderFailureAnnotations([])).toEqual([]);
  });
});

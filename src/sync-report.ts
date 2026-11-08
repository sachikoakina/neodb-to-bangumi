/**
 * 运行报告与待核对名单。
 *
 * 每条链路返回统一 PathReport，并满足恒等式：
 *   scanned = written + unchanged + skipped + unresolved + failed
 * `failed` 或中止会让退出码非零；`unresolved` 单独不导致失败。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { consola } from 'consola';
import type { ShelfType } from './types';

export type Outcome = 'written' | 'unchanged' | 'skipped' | 'unresolved' | 'failed';

export type PathReport = {
  scanned: number;
  written: number;
  unchanged: number;
  skipped: number;
  unresolved: number;
  failed: number;
};

export function createReport(): PathReport {
  return { scanned: 0, written: 0, unchanged: 0, skipped: 0, unresolved: 0, failed: 0 };
}

export function record(report: PathReport, outcome: Outcome): void {
  report[outcome] += 1;
}

/** 恒等式校验；不满足说明计数逻辑有 bug，宁可失败也不发布假报告。 */
export function assertReportInvariant(report: PathReport): boolean {
  return (
    report.scanned ===
    report.written +
      report.unchanged +
      report.skipped +
      report.unresolved +
      report.failed
  );
}

// ─── 待核对名单 ─────────────────────────────────────────────────────────

export type UnmatchedEntry = {
  source: 'neodb-bangumi';
  reason: string;
  title: string;
  itemUrl: string;
  /** 分类与书架元数据：人工核对时无需回查 NeoDB。 */
  category?: string;
  shelf?: string;
  neodbUuid?: string;
  firstSeenAt: string;
  lastSeenAt: string;
};

export type UnmatchedMap = Map<string, UnmatchedEntry>;

/**
 * upsert 而非追加：同一条目再次未命中只刷新 `lastSeenAt`，`firstSeenAt` 不动，
 * 文件保持在唯一集合的规模，长期缺口与新出现缺口仍可区分。
 */
export function upsertUnmatched(
  entries: UnmatchedMap,
  key: string,
  detail: {
    reason: string;
    title: string;
    itemUrl: string;
    category?: string;
    shelf?: string;
    neodbUuid?: string;
  },
): void {
  const now = new Date().toISOString();
  const existing = entries.get(key);
  if (existing) {
    existing.reason = detail.reason;
    existing.lastSeenAt = now;
    return;
  }
  entries.set(key, {
    source: 'neodb-bangumi',
    reason: detail.reason,
    title: detail.title,
    itemUrl: detail.itemUrl,
    ...(detail.category ? { category: detail.category } : {}),
    ...(detail.shelf ? { shelf: detail.shelf } : {}),
    ...(detail.neodbUuid ? { neodbUuid: detail.neodbUuid } : {}),
    firstSeenAt: now,
    lastSeenAt: now,
  });
}

export function loadUnmatched(path: string): UnmatchedMap {
  if (!existsSync(path)) {
    return new Map();
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<
      string,
      UnmatchedEntry
    >;
    return new Map(Object.entries(parsed));
  } catch {
    consola.warn(`待核对名单文件损坏，按空名单处理: ${path}`);
    return new Map();
  }
}

export function saveUnmatched(path: string, entries: UnmatchedMap): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(Object.fromEntries(entries), null, 2), 'utf8');
}

const DAY_MS = 86_400_000;

/**
 * 按最后出现时间清理待核对名单。
 *
 * 只做「长期未再出现」的老化，不做「本轮未出现就删」——单链路没有多路径
 * coverage 对账，按轮次淘汰会在一次分页截断或限流后误删真实缺口。
 *
 * 规则：
 * - `maxAgeDays` 非有限数或 <= 0 → 不清理（0 = 永不清理）；
 * - `lastSeenAt` 无效 → 保留（不能因脏数据误删）；
 * - 严格早于截止时间才删除，恰好等于截止时间保留。
 *
 * 返回新 Map，不修改入参。
 */
export function pruneUnmatched(
  entries: UnmatchedMap,
  maxAgeDays: number,
  now: Date = new Date(),
): { entries: UnmatchedMap; removed: number } {
  const next = new Map(entries);
  if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) {
    return { entries: next, removed: 0 };
  }

  const cutoff = now.getTime() - maxAgeDays * DAY_MS;
  let removed = 0;
  for (const [key, entry] of next) {
    const lastSeen = Date.parse(entry.lastSeenAt);
    if (Number.isNaN(lastSeen)) {
      continue;
    }
    if (lastSeen < cutoff) {
      next.delete(key);
      removed += 1;
    }
  }
  return { entries: next, removed };
}

// ─── 匹配审计 ───────────────────────────────────────────────────────────
//
// 每条进入处理的条目记录「为什么被写到了这个 subject」（或为什么没写）。
// 日志会滚走、unmatched.json 只覆盖未匹配侧，这份产物让错配可以离线复核，
// 也是清理脚本（撤销错配收藏）的输入来源。

export type MatchAuditEntry = {
  uuid: string;
  label: string;
  category: string;
  shelf: string;
  /** 匹配方式：link = NeoDB 外链直连；title = 标题搜索；null = 未进入匹配。 */
  via: 'link' | 'title' | null;
  subjectId: number | null;
  /** 命中条目名；仅标题匹配可即时获得（link 直连不额外发请求补名字）。 */
  subjectName: string | null;
  sourceYear: number | null;
  sourceMediaForm: string | null;
  candidateYear: number | null;
  candidateMediaForm: string | null;
  /** 参与裁决的精确同名候选 id 列表（含未命中者）；未进入标题匹配为 null。 */
  candidates: number[] | null;
  /** strict 模式下因证据不足被持留（未写入）。 */
  strictHold: boolean;
  outcome: Outcome;
  reason: string | null;
};

export type MatchAuditMeta = {
  startedAt: string;
  finishedAt: string;
  dryRun: boolean;
  fullSync: boolean;
  matchStrict: boolean;
  yearTolerance: number;
};

export type MatchAuditDocument = { version: 1 } & MatchAuditMeta & {
    entries: MatchAuditEntry[];
  };

export function buildMatchAuditDocument(
  meta: MatchAuditMeta,
  entries: MatchAuditEntry[],
): MatchAuditDocument {
  return { version: 1, ...meta, entries };
}

export function saveMatchAudit(path: string, doc: MatchAuditDocument): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(doc, null, 2), 'utf8');
}

/**
 * dry-run 视角的待核对名单落盘路径：派生自正式路径（unmatched.json →
 * unmatched-dryrun.json），不老化、不污染正式文件——dry-run 的价值在于
 * 「写之前看清楚」，它不应该改变下一次正式运行的起点。
 */
export function dryRunUnmatchedPath(path: string): string {
  return path.replace(/(\.json)?$/i, (ext) => `-dryrun${ext || '.json'}`);
}

// ─── 摘要渲染 ───────────────────────────────────────────────────────────

export type SummaryContext = {
  startedAt: string;
  finishedAt: string;
  dryRun: boolean;
  fullSync: boolean;
  shelves: ShelfType[];
  truncatedShelves: ShelfType[];
  unmatchedCount: number;
  /** 待核对原因分布：直接告诉读者该补外链还是该重跑。 */
  unmatchedByReason?: Record<string, number>;
};

export function renderSummaryMarkdown(report: PathReport, ctx: SummaryContext): string {
  const lines: string[] = [];
  lines.push('# NeoDB → Bangumi 迁移报告');
  lines.push('');
  lines.push(`- 起止：${ctx.startedAt} → ${ctx.finishedAt}（UTC）`);
  lines.push(
    `- 模式：${ctx.dryRun ? 'dry-run（written 为计划，未提交）' : '正式写入'}｜${ctx.fullSync ? '全量' : '常规'}`,
  );
  lines.push(`- 书架：${ctx.shelves.join(', ')}`);
  if (ctx.truncatedShelves.length) {
    lines.push(
      `- ⚠️ 以下书架因错误或页数上限未遍历完整：${ctx.truncatedShelves.join(', ')}`,
    );
  }
  lines.push('');
  lines.push('| 扫描 | 写入 | 无变化 | 跳过 | 未匹配 | 失败 |');
  lines.push('| ---: | ---: | ---: | ---: | ---: | ---: |');
  lines.push(
    `| ${report.scanned} | ${report.written} | ${report.unchanged} | ${report.skipped} | ${report.unresolved} | ${report.failed} |`,
  );
  lines.push('');
  lines.push(`待核对名单条目数：${ctx.unmatchedCount}`);
  const reasons = Object.entries(ctx.unmatchedByReason ?? {}).sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
  if (reasons.length) {
    lines.push('');
    lines.push('| 待核对原因 | 条目数 |');
    lines.push('| --- | ---: |');
    for (const [reason, count] of reasons) {
      lines.push(`| ${reason} | ${count} |`);
    }
  }
  return lines.join('\n');
}

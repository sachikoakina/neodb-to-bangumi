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
import type { RunMetricsSnapshot, StageName } from './metrics';
import type { StopReason } from './rules/budget';
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
  /** 累计未命中次数，驱动退避阶梯（1/2/4/7 天）。 */
  attempts?: number;
  /** 下次允许重新发起匹配的时间（ISO）；缺失表示立即可查。 */
  nextCheckAt?: string;
  /**
   * 条目当前状态。旧文件缺这个字段时按 reason 推导（见 `unmatched-report.ts`），
   * 因此历史名单不需要迁移。
   *
   * - `unresolved`：数据缺口（搜不到、年份对不上、目标不可收藏）；
   * - `skipped`：被规则让位（如同一目标被更强标记认领）；
   * - `failed`：技术失败（5xx/超时），下轮重试，不受退避限制。
   */
  state?: 'unresolved' | 'skipped' | 'failed';
  /** 已知的 Bangumi 目标（`duplicate-target` / `collection-not-found` 才有）。 */
  subjectId?: number;
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
    /** 累计尝试次数；传入则覆盖旧值。 */
    attempts?: number;
    /** 下次允许复查时间；传入则覆盖旧值。 */
    nextCheckAt?: string;
    /** 条目状态；传入则覆盖旧值。`failed` 会清掉残留的退避时间。 */
    state?: 'unresolved' | 'skipped' | 'failed';
    /** 已知的 Bangumi 目标；传入则覆盖旧值。 */
    subjectId?: number;
    /**
     * 是否刷新 `lastSeenAt`，默认 true。
     * 退避期内不会走到这里；保留该开关是为了让「跳过网络但仍视为本轮见过」
     * 这类用法不必伪造一次 upsert。
     */
    refreshLastSeen?: boolean;
  },
): void {
  const now = new Date().toISOString();
  const existing = entries.get(key);
  if (existing) {
    existing.reason = detail.reason;
    if (detail.refreshLastSeen !== false) {
      existing.lastSeenAt = now;
    }
    if (detail.state != null) existing.state = detail.state;
    if (detail.subjectId != null) existing.subjectId = detail.subjectId;
    if (detail.attempts != null) existing.attempts = detail.attempts;
    if (detail.nextCheckAt != null) existing.nextCheckAt = detail.nextCheckAt;
    // 失败条目必须立刻可重试：残留的退避时间会把一次 5xx 推迟到下个窗口。
    if (detail.state === 'failed') delete existing.nextCheckAt;
    return;
  }
  // 失败条目不带退避：它属于「这轮没成功」，不是「这条数据有缺口」。
  const nextCheckAt = detail.state === 'failed' ? undefined : detail.nextCheckAt;
  entries.set(key, {
    source: 'neodb-bangumi',
    reason: detail.reason,
    title: detail.title,
    itemUrl: detail.itemUrl,
    ...(detail.category ? { category: detail.category } : {}),
    ...(detail.shelf ? { shelf: detail.shelf } : {}),
    ...(detail.neodbUuid ? { neodbUuid: detail.neodbUuid } : {}),
    ...(detail.attempts != null ? { attempts: detail.attempts } : {}),
    ...(detail.state != null ? { state: detail.state } : {}),
    ...(detail.subjectId != null ? { subjectId: detail.subjectId } : {}),
    ...(nextCheckAt ? { nextCheckAt } : {}),
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
  /**
   * 失败时的归一化短消息（首行、≤200 字）。
   * 控制台日志会随运行滚走，产物需要能独立回答「为什么失败」。
   */
  error?: string | null;
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
  /**
   * 可选：阶段耗时与请求等待快照。
   * 不传时摘要里不出现「耗时」小节，其余区块照常渲染。
   */
  metrics?: RunMetricsSnapshot;
  /** 提前停止原因：条目配额或时间预算；未触发为 null/undefined。 */
  stopReason?: StopReason;
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
  if (ctx.stopReason === 'time-budget') {
    lines.push('- 本轮提前收尾：时间预算用尽（已处理条目的状态已落盘，下一轮继续）');
  } else if (ctx.stopReason === 'max-items') {
    lines.push('- 本轮提前收尾：条目配额用尽（下一轮从新增条目继续）');
  }
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
  if (ctx.metrics) {
    lines.push(...renderMetricsSection(ctx.metrics));
    lines.push('');
  }
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

const STAGE_LABELS: Record<StageName, string> = {
  shelf: '书架分页',
  match: '匹配（搜索/候选详情）',
  read: '读目标收藏',
  write: '写目标收藏',
  episode: '分集读取与写入',
};

function formatDuration(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

function formatShare(partMs: number, totalMs: number): string {
  if (totalMs <= 0) return '—';
  return `${((partMs / totalMs) * 100).toFixed(1)}%`;
}

/**
 * 阶段耗时表。各阶段刻意互不重叠（书架分页 / 条目内三段），
 * 因此每一项都可以直接除以本轮墙钟得到占比。
 */
function renderMetricsSection(metrics: RunMetricsSnapshot): string[] {
  const lines = [
    '| 阶段 | 次数 | 总耗时 | 占墙钟 | p50 | p90 | 最大 |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  const stages: readonly StageName[] = ['shelf', 'match', 'read', 'write', 'episode'];
  for (const stage of stages) {
    const stat = metrics.stages[stage];
    if (stat.count === 0) continue;
    lines.push(
      `| ${STAGE_LABELS[stage]} | ${stat.count} | ${formatDuration(stat.totalMs)} | ` +
        `${formatShare(stat.totalMs, metrics.wallMs)} | ${formatDuration(stat.p50Ms)} | ` +
        `${formatDuration(stat.p90Ms)} | ${formatDuration(stat.maxMs)} |`,
    );
  }
  const items = metrics.items;
  lines.push(
    `| 条目墙钟 | ${items.count} | ${formatDuration(items.totalMs)} | ` +
      `${formatShare(items.totalMs, metrics.wallMs)} | ${formatDuration(items.p50Ms)} | ` +
      `${formatDuration(items.p90Ms)} | ${formatDuration(items.maxMs)} |`,
  );
  lines.push('');
  lines.push(
    `- 固定等待：Bangumi ${metrics.sleeps.bangumi} 次 / ${formatDuration(metrics.sleepMs.bangumi)}；` +
      `NeoDB ${metrics.sleeps.neodb} 次 / ${formatDuration(metrics.sleepMs.neodb)}`,
  );
  lines.push(`- 本轮墙钟：${formatDuration(metrics.wallMs)}`);
  return lines;
}

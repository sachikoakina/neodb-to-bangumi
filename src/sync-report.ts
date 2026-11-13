/**
 * 运行报告与待核对名单。
 *
 * 每条链路返回统一 PathReport，并满足恒等式：
 *   scanned = written + unchanged + skipped + unresolved + failed
 * `failed` 与 `unresolved` 都只是计数：退出码由 `rules/exit-code.ts` 分级决定
 * （中止 → 2；恒等式破坏 → 1；条目失败仅在 `SYNC_FAIL_ON_ITEM_ERRORS=1` 时 → 1）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { consola } from 'consola';
import type { RunMetricsSnapshot, StageName } from './metrics';
import { renderUnmatchedSection } from './unmatched-report';
import type { StopReason } from './rules/budget';
import type { ShelfType, SyncStateDiscardReason } from './types';

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

/** 条目结局。观察窗轮数按 kind 取值，见 `rules/review-rounds.ts`。 */
export type UnmatchedKind = 'unresolved' | 'skipped' | 'failed';

export type UnmatchedEntry = {
  source: 'neodb-bangumi';
  kind: UnmatchedKind;
  reason: string;
  title: string;
  /** 绝对地址。 */
  itemUrl: string;
  /** 分类与书架元数据：人工核对时无需回查 NeoDB。 */
  category?: string;
  /** 书架类型：缺席判定看它所在书架本轮是否完整遍历。 */
  shelf: string;
  neodbUuid: string;
  /** 已知的 Bangumi 目标（`duplicate-target` / `collection-not-found` 才有）。 */
  subjectId?: number;
  firstSeenAt: string;
  lastSeenAt: string;
  /** 连续「被检查到且仍在上报」的轮数，决定是否越过观察窗。 */
  seenRounds: number;
  /** 连续「被检查到但未再上报」的轮数，达到上限即移出名单。 */
  missedRounds: number;
};

/** 本轮移出名单的条目与原因。 */
export type RemovedEntry = {
  entry: UnmatchedEntry;
  cause: 'imported' | 'absent';
};

export type UnmatchedMap = Map<string, UnmatchedEntry>;

export const UNMATCHED_VERSION = 2;

export type UnmatchedDocument = {
  version: typeof UNMATCHED_VERSION;
  updatedAt: string;
  entries: UnmatchedEntry[];
};

const UNMATCHED_KINDS: ReadonlySet<string> = new Set([
  'unresolved',
  'skipped',
  'failed',
]);

export function createUnmatchedEntry(input: {
  kind: UnmatchedKind;
  reason: string;
  title: string;
  itemUrl: string;
  shelf: string;
  neodbUuid: string;
  category?: string;
  subjectId?: number;
  now: string;
}): UnmatchedEntry {
  return {
    source: 'neodb-bangumi',
    kind: input.kind,
    reason: input.reason,
    title: input.title,
    itemUrl: input.itemUrl,
    ...(input.category ? { category: input.category } : {}),
    shelf: input.shelf,
    neodbUuid: input.neodbUuid,
    ...(input.subjectId != null ? { subjectId: input.subjectId } : {}),
    firstSeenAt: input.now,
    lastSeenAt: input.now,
    seenRounds: 1,
    missedRounds: 0,
  };
}

export function loadUnmatched(path: string): UnmatchedEntry[] {
  if (!existsSync(path)) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    consola.warn(`待核对名单不是合法 JSON，按空名单重建: ${path}`);
    return [];
  }
  const doc = parsed as Partial<UnmatchedDocument>;
  if (
    doc?.version !== UNMATCHED_VERSION ||
    !Array.isArray(doc.entries) ||
    !doc.entries.every(isUnmatchedEntry)
  ) {
    consola.warn(`待核对名单结构不受支持，按空名单重建: ${path}`);
    return [];
  }
  return doc.entries.map((entry) => ({ ...entry }));
}

function isUnmatchedEntry(value: unknown): value is UnmatchedEntry {
  if (value == null || typeof value !== 'object') return false;
  const entry = value as Partial<UnmatchedEntry>;
  return (
    entry.source === 'neodb-bangumi' &&
    typeof entry.kind === 'string' &&
    UNMATCHED_KINDS.has(entry.kind) &&
    typeof entry.reason === 'string' &&
    typeof entry.title === 'string' &&
    typeof entry.itemUrl === 'string' &&
    typeof entry.shelf === 'string' &&
    typeof entry.neodbUuid === 'string' &&
    typeof entry.firstSeenAt === 'string' &&
    typeof entry.lastSeenAt === 'string' &&
    Number.isFinite(entry.seenRounds) &&
    Number.isFinite(entry.missedRounds)
  );
}

export function saveUnmatched(path: string, entries: readonly UnmatchedEntry[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const doc: UnmatchedDocument = {
    version: UNMATCHED_VERSION,
    updatedAt: new Date().toISOString(),
    entries: [...entries],
  };
  writeFileSync(path, JSON.stringify(doc, null, 2), 'utf8');
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
  /** 匹配方式：link = 外链直连；isbn = ISBN 命中；title = 标题搜索；null = 未进入匹配。 */
  via: 'link' | 'isbn' | 'title' | null;
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
  shelves: readonly ShelfType[];
  truncatedShelves: readonly ShelfType[];
  /**
   * 名单正文（已越过观察窗）。渲染由 `unmatched-report.ts` 负责：
   * 按链路→状态→分类→书架四级分组逐条列出。
   */
  unmatchedEntries?: readonly UnmatchedEntry[];
  /** 本轮首次越过观察窗的条目。 */
  unmatchedAdded?: readonly UnmatchedEntry[];
  /** 本轮移出名单的条目与原因。 */
  unmatchedRemoved?: readonly RemovedEntry[];
  /** 仍在观察窗内、尚未进入正文的条目。 */
  unmatchedObserving?: readonly UnmatchedEntry[];
  /** 本轮没进入扫描集合、因此冻结的条目。 */
  unmatchedFrozen?: readonly UnmatchedEntry[];
  /** NeoDB 实例地址，供渲染层把历史名单里的相对链接补成绝对地址。 */
  neodbBaseUrl?: string;
  /** 「已存在 N 天」的参照时刻；不传则用 `finishedAt`。 */
  runNow?: Date;
  /**
   * 可选：阶段耗时与请求等待快照。
   * 不传时摘要里不出现「耗时」小节，其余区块照常渲染。
   */
  metrics?: RunMetricsSnapshot;
  /** 提前停止原因：条目配额或时间预算；未触发为 null/undefined。 */
  stopReason?: StopReason;
  /**
   * 缓存状态被丢弃的原因。非 null 表示本轮按空状态运行 —— 不标出来的话，
   * 读者会把「多扫了一轮」误读成增量正常。
   */
  stateReset?: SyncStateDiscardReason | null;
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
  if (ctx.stateReset) {
    lines.push(
      `- 增量状态：缓存被丢弃（${ctx.stateReset}），本轮按空状态运行；` +
        '写入本身幂等，代价是多扫一轮。',
    );
  }
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
  // 待核对清单是这份报告的主内容，排在耗时统计之前：读者先看「哪些没导进去」。
  lines.push(
    ...renderUnmatchedSection(ctx.unmatchedEntries ?? [], {
      startedAt: ctx.startedAt,
      now: ctx.runNow ?? new Date(ctx.finishedAt),
      added: ctx.unmatchedAdded ?? [],
      removed: ctx.unmatchedRemoved ?? [],
      observing: ctx.unmatchedObserving ?? [],
      frozen: ctx.unmatchedFrozen ?? [],
      truncatedShelves: ctx.truncatedShelves,
      neodbBaseUrl: ctx.neodbBaseUrl,
    }),
  );
  if (ctx.metrics) {
    lines.push('');
    lines.push(...renderMetricsSection(ctx.metrics));
  }
  return lines.join('\n');
}

/**
 * 把问题条目渲染成 Actions 注解（`::warning title=...::text`）。
 *
 * 目的是让 Actions 页面的运行摘要、以及仓库的 Annotations 面板直接列出
 * 「哪一条、哪个 subject、为什么」——不必下载 artifact 才知道发生了什么。
 * workflow command 要求单行，因此换行与 `%` 必须转义，否则解析会失败。
 */
export function renderFailureAnnotations(entries: MatchAuditEntry[]): string[] {
  return entries.map((entry) => {
    const where = entry.subjectId == null ? '' : ` subject/${entry.subjectId}`;
    const detail = entry.error == null ? '' : ` — ${entry.error}`;
    return (
      `::warning title=${escapeWorkflowCommand(entry.reason ?? 'failed')}::` +
      escapeWorkflowCommand(`${entry.label}${where}${detail}`)
    );
  });
}

function escapeWorkflowCommand(text: string): string {
  return text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
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

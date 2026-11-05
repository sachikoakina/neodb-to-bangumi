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
  detail: { reason: string; title: string; itemUrl: string },
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

// ─── 摘要渲染 ───────────────────────────────────────────────────────────

export type SummaryContext = {
  startedAt: string;
  finishedAt: string;
  dryRun: boolean;
  fullSync: boolean;
  shelves: ShelfType[];
  truncatedShelves: ShelfType[];
  unmatchedCount: number;
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
  return lines.join('\n');
}

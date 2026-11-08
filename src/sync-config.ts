/**
 * 同步配置 —— 集中解析环境变量，向其余代码暴露有类型的配置对象。
 *
 * 环境变量**名称属于对外接口，不要改名**。非法值一律「失败在关闭一侧」：
 * 告警并回落到最保守的行为，绝不悄悄退化成「全部同步」。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import dotenv from 'dotenv';
import { consola } from 'consola';
import { SHELF_TYPES, type NeodbShelfMark, type ShelfType } from './types';
import type {
  BangumiPrivateMode,
  CommentMergeProfile,
  RatingMergeProfile,
  StatusGuard,
} from './rules/neodb-bangumi-mapping';

dotenv.config();

/** 本项目读取的全部环境变量名 —— verify-docs 以此与 .env.example 双向核对。 */
export const ENV_KEYS: readonly string[] = [
  'NEODB_API_TOKEN',
  'NEODB_BASE_URL',
  'NEODB_REQUEST_DELAY_MS',
  'NEODB_MAX_PAGES',
  'BANGUMI_ACCESS_TOKEN',
  'BANGUMI_USER_AGENT',
  'BANGUMI_REQUEST_DELAY_MS',
  'SYNC_DRY_RUN',
  'SYNC_MAX_ITEMS',
  'SYNC_SHELF_TYPES',
  'SYNC_CATEGORIES',
  'SYNC_YEAR_TOLERANCE',
  'SYNC_YEAR_TOLERANCE_BOOK',
  'SYNC_MATCH_STRICT',
  'SYNC_MATCH_AUDIT_FILE',
  'SYNC_NEODB_BANGUMI_RATING',
  'SYNC_NEODB_BANGUMI_COMMENT',
  'SYNC_STATUS_GUARD',
  'SYNC_BANGUMI_PRIVATE_MODE',
  'SYNC_BANGUMI_PRIVATE',
  'SYNC_PROGRESS',
  'SYNC_INCLUDE_SP',
  'SYNC_INCLUDE_OP_ED',
  'SYNC_INCREMENTAL',
  'SYNC_STATE_FILE',
  'FULL_SYNC',
  'FULL_SYNC_CURSOR_FILE',
  'SYNC_UNMATCHED_LOG',
  'REVIEW_STATE_MAX_AGE_DAYS',
  'SYNC_REPORT_FILE',
  'SYNC_SUMMARY_FILE',
];

const VALID_CATEGORIES: readonly string[] = [
  'book',
  'movie',
  'tv',
  'music',
  'game',
  'podcast',
  'performance',
];

export type CategoryAllowlist =
  | { mode: 'all' }
  | { mode: 'none'; raw: string }
  | { mode: 'set'; values: ReadonlySet<string> };

function envEnabled(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return defaultValue;
  }
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

function envNumber(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    return defaultValue;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    consola.warn(`${name}=${raw} 不是数字；回落到默认值 ${defaultValue}`);
    return defaultValue;
  }
  return value;
}

function envString(name: string, defaultValue: string): string {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === '' ? defaultValue : raw.trim();
}

/**
 * 解析分类白名单，刻意保持三态：`none` 与 `all` 必须区分开，写错分类名时
 * **失败在关闭一侧**（不同步任何东西并明确告知），而不是退化成「全部同步」。
 */
function parseCategoryAllowlist(
  name: string,
  raw: string | undefined,
): CategoryAllowlist {
  const tokens = (raw ?? '')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  if (!tokens.length) {
    return { mode: 'all' };
  }
  const values = new Set<string>();
  for (const token of tokens) {
    if (!VALID_CATEGORIES.includes(token)) {
      consola.warn(
        `${name} 里的分类「${token}」无法识别；白名单整体作废，本次不同步任何分类。可用值: ${VALID_CATEGORIES.join(',')}`,
      );
      return { mode: 'none', raw: raw ?? '' };
    }
    values.add(token);
  }
  return { mode: 'set', values };
}

function parseShelfTypes(name: string, raw: string | undefined): ShelfType[] {
  const tokens = (raw ?? '')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  if (!tokens.length) {
    return [...SHELF_TYPES];
  }
  const values: ShelfType[] = [];
  for (const token of tokens) {
    if (!SHELF_TYPES.includes(token as ShelfType)) {
      consola.warn(
        `${name} 里的书架「${token}」无法识别，已忽略。可用值: ${SHELF_TYPES.join(',')}`,
      );
      continue;
    }
    if (!values.includes(token as ShelfType)) {
      values.push(token as ShelfType);
    }
  }
  return values;
}

function parseEnum<T extends string>(
  name: string,
  raw: string | undefined,
  allowed: readonly T[],
  defaultValue: T,
): T {
  const value = raw?.trim().toLowerCase();
  if (value === undefined || value === '') {
    return defaultValue;
  }
  if (allowed.includes(value as T)) {
    return value as T;
  }
  consola.warn(
    `${name}=${raw} 非法（可用值: ${allowed.join('|')}）；回落到 ${defaultValue}`,
  );
  return defaultValue;
}

export type SyncConfig = {
  neodb: {
    token?: string;
    baseUrl: string;
    delayMs: number;
    maxPages: number;
  };
  bangumi: {
    token?: string;
    userAgent: string;
    delayMs: number;
  };
  sync: {
    dryRun: boolean;
    maxItems: number;
    shelfTypes: ShelfType[];
    categories: CategoryAllowlist;
    yearTolerance: number;
    /**
     * 书籍（type 1）的年份容差：初版/再版年份口径差异大，可单独放宽。
     */
    bookYearTolerance: number;
    /**
     * 匹配严格模式：唯一同名候选若年份无法核对且形态不可判定 → 转待核对，
     * 不自动写入。默认开启——宁可漏配，不可错配。
     */
    matchStrict: boolean;
    /** 匹配审计产物路径：每条目的匹配对象、证据与结局。 */
    matchAuditFile: string;
    ratingProfile: RatingMergeProfile;
    commentProfile: CommentMergeProfile;
    statusGuard: StatusGuard;
    bangumiPrivateMode: BangumiPrivateMode;
    bangumiPrivate: boolean;
    progress: boolean;
    includeSp: boolean;
    includeOpEd: boolean;
    incremental: boolean;
    stateFile: string;
    fullSync: boolean;
    fullSyncCursorFile: string;
    unmatchedLog: string;
    /** 待核对名单按 lastSeenAt 老化的天数；0 表示永不清理。 */
    reviewStateMaxAgeDays: number;
    reportFile: string;
    summaryFile: string;
  };
};

export function loadSyncConfig(): SyncConfig {
  const maxItemsRaw = envNumber('SYNC_MAX_ITEMS', 50);
  const maxPagesRaw = envNumber('NEODB_MAX_PAGES', 10);
  return {
    neodb: {
      token: process.env.NEODB_API_TOKEN || undefined,
      baseUrl: envString('NEODB_BASE_URL', 'https://neodb.social'),
      delayMs: envNumber('NEODB_REQUEST_DELAY_MS', 300),
      maxPages: maxPagesRaw >= 1 ? Math.floor(maxPagesRaw) : 10,
    },
    bangumi: {
      token: process.env.BANGUMI_ACCESS_TOKEN || undefined,
      userAgent: envString(
        'BANGUMI_USER_AGENT',
        'neodb-to-bangumi/1.0 (+https://github.com/sachikoakina/neodb-to-bangumi)',
      ),
      delayMs: envNumber('BANGUMI_REQUEST_DELAY_MS', 400),
    },
    sync: {
      dryRun: envEnabled('SYNC_DRY_RUN', false),
      // SYNC_MAX_ITEMS=0 不是「无限」——低于 1 回落为 50。
      maxItems: maxItemsRaw >= 1 ? Math.floor(maxItemsRaw) : 50,
      shelfTypes: parseShelfTypes('SYNC_SHELF_TYPES', process.env.SYNC_SHELF_TYPES),
      categories: parseCategoryAllowlist(
        'SYNC_CATEGORIES',
        process.env.SYNC_CATEGORIES,
      ),
      yearTolerance: Math.max(0, envNumber('SYNC_YEAR_TOLERANCE', 1)),
      bookYearTolerance: Math.max(0, envNumber('SYNC_YEAR_TOLERANCE_BOOK', 1)),
      matchStrict: envEnabled('SYNC_MATCH_STRICT', true),
      matchAuditFile: envString('SYNC_MATCH_AUDIT_FILE', '.cache/match-audit.json'),
      ratingProfile: parseEnum(
        'SYNC_NEODB_BANGUMI_RATING',
        process.env.SYNC_NEODB_BANGUMI_RATING,
        ['bangumi_prefer', 'overwrite'] as const,
        'bangumi_prefer',
      ),
      commentProfile: parseEnum(
        'SYNC_NEODB_BANGUMI_COMMENT',
        process.env.SYNC_NEODB_BANGUMI_COMMENT,
        ['bangumi_prefer', 'overwrite'] as const,
        'bangumi_prefer',
      ),
      statusGuard: parseEnum(
        'SYNC_STATUS_GUARD',
        process.env.SYNC_STATUS_GUARD,
        ['off', 'no-downgrade'] as const,
        'off',
      ),
      bangumiPrivateMode: parseEnum(
        'SYNC_BANGUMI_PRIVATE_MODE',
        process.env.SYNC_BANGUMI_PRIVATE_MODE,
        ['target', 'source'] as const,
        'target',
      ),
      bangumiPrivate: envEnabled('SYNC_BANGUMI_PRIVATE', false),
      progress: envEnabled('SYNC_PROGRESS', false),
      includeSp: envEnabled('SYNC_INCLUDE_SP', false),
      includeOpEd: envEnabled('SYNC_INCLUDE_OP_ED', false),
      incremental: envEnabled('SYNC_INCREMENTAL', true),
      stateFile: envString('SYNC_STATE_FILE', '.cache/sync-state.json'),
      fullSync: envEnabled('FULL_SYNC', false),
      fullSyncCursorFile: envString(
        'FULL_SYNC_CURSOR_FILE',
        '.cache/full-sync-cursor.json',
      ),
      unmatchedLog: envString('SYNC_UNMATCHED_LOG', '.cache/unmatched.json'),
      reviewStateMaxAgeDays: Math.max(
        0,
        Math.floor(envNumber('REVIEW_STATE_MAX_AGE_DAYS', 30)),
      ),
      reportFile: envString('SYNC_REPORT_FILE', '.cache/sync-report.json'),
      summaryFile: envString('SYNC_SUMMARY_FILE', '.cache/sync-summary.md'),
    },
  };
}

/** 打印最终生效的配置，便于在日志里核对、在不同运行之间 diff。 */
export function describeSyncConfig(config: SyncConfig): string {
  const s = config.sync;
  const categories =
    s.categories.mode === 'all'
      ? '全部'
      : s.categories.mode === 'none'
        ? `无（原文: ${s.categories.raw}）`
        : [...s.categories.values].join(',');
  return [
    '生效配置:',
    `  NeoDB: ${config.neodb.baseUrl}（延迟 ${config.neodb.delayMs}ms，页上限 ${config.neodb.maxPages}，token ${config.neodb.token ? '已设置' : '未设置'}）`,
    `  Bangumi: token ${config.bangumi.token ? '已设置' : '未设置'}（延迟 ${config.bangumi.delayMs}ms）`,
    `  书架: ${s.shelfTypes.join(',')}`,
    `  分类白名单: ${categories}`,
    `  dry-run: ${s.dryRun ? 1 : 0}｜全量: ${s.fullSync ? 1 : 0}｜条目上限: ${s.maxItems}`,
    `  评分: ${s.ratingProfile}｜短评: ${s.commentProfile}｜状态保护: ${s.statusGuard}`,
    `  隐私: ${s.bangumiPrivateMode}${s.bangumiPrivateMode === 'target' ? `（private=${s.bangumiPrivate}）` : ''}` +
      `｜进度拉满: ${s.progress ? 1 : 0}（SP: ${s.includeSp ? 1 : 0}，OP/ED: ${s.includeOpEd ? 1 : 0}）`,
    `  增量: ${s.incremental && !s.fullSync ? 1 : 0}｜状态文件: ${s.stateFile}`,
    `  全量游标: ${s.fullSync ? s.fullSyncCursorFile : '未启用（仅 FULL_SYNC=1 使用）'}`,
    `  待核对名单: ${s.unmatchedLog}（${
      s.reviewStateMaxAgeDays > 0
        ? `${s.reviewStateMaxAgeDays} 天未出现后清理`
        : '永不清理'
    }）`,
    `  年份容差: ${s.yearTolerance}（书籍: ${s.bookYearTolerance}）｜匹配严格: ${s.matchStrict ? 1 : 0}`,
    `  匹配审计: ${s.matchAuditFile}`,
  ].join('\n');
}

// ─── 增量状态 ───────────────────────────────────────────────────────────

export type SyncState = Record<string, string>;

/** 条目指纹：书架状态、评分、短评、可见性任一变化都会改变指纹。 */
export function fingerprintMark(mark: NeodbShelfMark): string {
  return createHash('sha1')
    .update(
      [
        mark.item.uuid,
        mark.shelf_type,
        mark.rating_grade ?? 0,
        mark.comment_text ?? '',
        mark.visibility ?? '',
      ].join('|'),
    )
    .digest('hex');
}

export function loadSyncState(path: string): SyncState {
  if (!existsSync(path)) {
    return {};
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { marks?: SyncState };
    return parsed.marks ?? {};
  } catch {
    consola.warn(`增量状态文件损坏，按空状态处理: ${path}`);
    return {};
  }
}

export function saveSyncState(path: string, state: SyncState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), marks: state }),
    'utf8',
  );
}

// ─── 全量游标 ───────────────────────────────────────────────────────────
//
// 只有 `FULL_SYNC=1` 使用。常规运行必须从第 1 页开始：它的窗口就是最新
// 一页，沿用旧游标会静默藏掉这一轮本来要抓的新标记。

/** 书架 → 下一页页码。 */
export type FullSyncCursor = Record<string, number>;

export function loadFullSyncCursor(path: string): FullSyncCursor {
  if (!existsSync(path)) {
    return {};
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      pages?: FullSyncCursor;
    };
    return parsed.pages ?? {};
  } catch {
    consola.warn(`全量游标文件损坏，按从头开始处理: ${path}`);
    return {};
  }
}

export function saveFullSyncCursor(path: string, cursor: FullSyncCursor): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify(
      { version: 1, updatedAt: new Date().toISOString(), pages: cursor },
      null,
      2,
    ),
    'utf8',
  );
}

/** 允许 category 判断的辅助（供测试复用）。 */
export function categoryAllowed(
  allowlist: CategoryAllowlist,
  category: string | undefined,
): boolean {
  if (allowlist.mode === 'all') return true;
  if (allowlist.mode === 'none') return false;
  return category != null && allowlist.values.has(category);
}

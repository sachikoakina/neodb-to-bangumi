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
  'SYNC_TIME_BUDGET_MS',
  'SYNC_MAX_EPISODES_PER_ITEM',
  'SYNC_UNMATCHED_RETRY_DAYS',
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
    /** 评分合并策略：`bangumi_prefer` 保留目标非 0 分；`overwrite` 用 NeoDB 分覆盖。 */
    ratingProfile: RatingMergeProfile;
    /** 短评合并策略：`bangumi_prefer` 保留目标非空短评；`overwrite` 用 NeoDB 短评覆盖（含清空）。 */
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
    /** 单轮时间预算（毫秒）；0 表示不限制。仅常规运行生效。 */
    timeBudgetMs: number;
    /** 单条每轮最多写入的分集数；0 表示不限。 */
    maxEpisodesPerItem: number;
    /** 未匹配条目的退避上限天数；0 表示不避让，每轮都重试。 */
    unmatchedRetryDays: number;
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
      // 0 = 关闭。负值一律归零（失败在关闭一侧：不限制时间/集数）。
      timeBudgetMs: Math.max(0, Math.floor(envNumber('SYNC_TIME_BUDGET_MS', 0))),
      maxEpisodesPerItem: Math.max(
        0,
        Math.floor(envNumber('SYNC_MAX_EPISODES_PER_ITEM', 0)),
      ),
      unmatchedRetryDays: Math.max(
        0,
        Math.floor(envNumber('SYNC_UNMATCHED_RETRY_DAYS', 7)),
      ),
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
    `  评分合并: ${s.ratingProfile}｜短评合并: ${s.commentProfile}｜状态保护: ${s.statusGuard}`,
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
    `  时间预算: ${s.timeBudgetMs > 0 ? `${s.timeBudgetMs}ms` : '关闭'}` +
      `｜单条分集上限: ${s.maxEpisodesPerItem > 0 ? s.maxEpisodesPerItem : '不限'}` +
      `｜未匹配退避: ${s.unmatchedRetryDays > 0 ? `${s.unmatchedRetryDays} 天` : '关闭'}`,
  ].join('\n');
}

// ─── 增量状态 ───────────────────────────────────────────────────────────

/** 状态文件的唯一版本号。读到其他版本一律丢弃，不做迁移。 */
const STATE_VERSION = 2;

/**
 * 增量状态（内存形态），字段与落盘形态一一对应。
 *
 * - `marks`：uuid → 指纹。指纹只覆盖收藏字段，**不含进度**；
 * - `targets`：uuid → 上次命中的 Bangumi subject，仅供诊断（清理错配时对照），
 *   刻意不参与匹配判定——否则一次错配会被永久复用；
 * - `progress`：uuid → `done`，表示该条的进度（书籍上限 / 分集）已拉满。
 *   它的存在让「开进度拉满」不必再靠 `FULL_SYNC=1` 全量重跑。
 */
export type SyncState = {
  marks: Record<string, string>;
  targets: Record<string, number>;
  progress: Record<string, 'done'>;
};

/** 落盘形态：版本号 + 三张表，全部必填。 */
type SyncStateFile = {
  version: typeof STATE_VERSION;
  updatedAt: string;
  marks: Record<string, string>;
  targets: Record<string, number>;
  progress: Record<string, 'done'>;
};

export function createSyncState(): SyncState {
  return { marks: {}, targets: {}, progress: {} };
}

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

/**
 * 读取增量状态。
 *
 * 只接受当前版本：版本号不符、字段缺失或类型错的文件，一律**丢弃并告警**，
 * 不做任何字段级兼容。丢弃的代价是这一轮按「没有历史」处理（条目会重算一次，
 * 写入本身幂等），换来的是「状态文件只有一种形状」这一条硬约束。
 */
export function loadSyncState(path: string): SyncState {
  if (!existsSync(path)) {
    return createSyncState();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    consola.warn(`增量状态文件不是合法 JSON，按空状态处理: ${path}`);
    return createSyncState();
  }

  if (!isSyncStateFile(parsed)) {
    consola.warn(
      `增量状态文件格式不符（要求 version=${STATE_VERSION}，且 marks/targets/progress 类型正确），按空状态处理: ${path}`,
    );
    return createSyncState();
  }

  return {
    marks: parsed.marks,
    targets: parsed.targets,
    progress: parsed.progress,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSyncStateFile(value: unknown): value is SyncStateFile {
  if (!isPlainObject(value)) return false;
  if (value.version !== STATE_VERSION) return false;
  const { marks, targets, progress } = value;
  if (!isPlainObject(marks) || !isPlainObject(targets) || !isPlainObject(progress)) {
    return false;
  }
  return (
    Object.values(marks).every((hash) => typeof hash === 'string') &&
    Object.values(targets).every((id) => typeof id === 'number') &&
    Object.values(progress).every((mark) => mark === 'done')
  );
}

export function saveSyncState(path: string, state: SyncState): void {
  mkdirSync(dirname(path), { recursive: true });
  const doc: SyncStateFile = {
    version: STATE_VERSION,
    updatedAt: new Date().toISOString(),
    marks: state.marks,
    targets: state.targets,
    progress: state.progress,
  };
  writeFileSync(path, JSON.stringify(doc), 'utf8');
}

// ─── 全量游标 ───────────────────────────────────────────────────────────
//
// 只有 `FULL_SYNC=1` 使用。常规运行必须从第 1 页开始：它的窗口就是最新
// 一页，沿用旧游标会静默藏掉这一轮本来要抓的新标记。

/** 书架 → 下一页页码。 */
export type FullSyncCursor = Record<string, number>;

/** 游标文件的唯一版本号。读到别的版本直接从头开始，不做迁移。 */
const CURSOR_VERSION = 1;

type FullSyncCursorFile = {
  version: typeof CURSOR_VERSION;
  updatedAt: string;
  pages: FullSyncCursor;
};

/**
 * 读取全量游标。与状态文件同一条规则：只认当前版本与完整形状，
 * 否则按「从头开始」处理（最坏结果只是重复处理一页，写入幂等）。
 */
export function loadFullSyncCursor(path: string): FullSyncCursor {
  if (!existsSync(path)) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    consola.warn(`全量游标文件不是合法 JSON，按从头开始处理: ${path}`);
    return {};
  }

  if (!isCursorFile(parsed)) {
    consola.warn(
      `全量游标文件格式不符（要求 version=${CURSOR_VERSION} 且 pages 为页码对象），按从头开始处理: ${path}`,
    );
    return {};
  }

  return parsed.pages;
}

function isCursorFile(value: unknown): value is FullSyncCursorFile {
  if (!isPlainObject(value)) return false;
  if (value.version !== CURSOR_VERSION) return false;
  if (!isPlainObject(value.pages)) return false;
  return Object.values(value.pages).every(
    (page) => typeof page === 'number' && Number.isInteger(page) && page >= 1,
  );
}

export function saveFullSyncCursor(path: string, cursor: FullSyncCursor): void {
  mkdirSync(dirname(path), { recursive: true });
  const doc: FullSyncCursorFile = {
    version: CURSOR_VERSION,
    updatedAt: new Date().toISOString(),
    pages: cursor,
  };
  writeFileSync(path, JSON.stringify(doc, null, 2), 'utf8');
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

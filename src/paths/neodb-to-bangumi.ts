/**
 * 主链路：NeoDB 书架 → Bangumi 收藏。
 *
 * 流程：凭据探测 → 逐书架遍历 → 分类/增量闸门 → 三级匹配（外链→标题→年份）
 * → 读目标收藏 → 按映射与保护规则 diff → 有变化才写 → 可选进度拉满。
 *
 * 契约：
 * - 目标读取失败（非 404）→ 该条 failed，绝不当作「未收藏」覆盖；
 * - 401/403 → 中止整条链路（aborted），不再继续写；
 * - 未匹配 → unresolved 并进待核对名单，不单独导致失败；
 * - dry-run 只输出计划，不代表已提交。
 */
import { consola } from 'consola';
import { neodbToken } from '../clients/neodb-http';
import {
  getNeodbItemDetail,
  verifyNeodbToken,
  walkShelfPages,
} from '../clients/neodb-shelf';
import { bangumiToken } from '../clients/bangumi-http';
import {
  getBangumiCollection,
  getBangumiEpisodeStates,
  getBangumiEpisodes,
  getBangumiMe,
  getBangumiSubject,
  markBangumiEpisodeWatched,
  searchBangumiSubjects,
  upsertBangumiCollection,
} from '../clients/bangumi';
import {
  bangumiSubjectYear,
  exactMatches,
  extractBangumiSubjectId,
  neodbItemYear,
  pickExactMatchByYear,
  titleCandidates,
} from '../rules/neodb-bangumi-matching';
import {
  isBangumiSupportedCategory,
  mapShelfType,
  mapVisibilityToPrivate,
  mergeComment,
  mergeRating,
  neodbCategoryToBangumiSubjectTypes,
} from '../rules/neodb-bangumi-mapping';
import { planBookProgress, planEpisodeProgress } from '../rules/bangumi-progress';
import {
  categoryAllowed,
  fingerprintMark,
  loadSyncState,
  saveSyncState,
  type SyncConfig,
  type SyncState,
} from '../sync-config';
import {
  createReport,
  loadUnmatched,
  record,
  saveUnmatched,
  upsertUnmatched,
  type PathReport,
  type UnmatchedMap,
} from '../sync-report';
import type { NeodbItem, NeodbShelfMark, ShelfType } from '../types';

type ItemOutcome = 'written' | 'unchanged' | 'skipped' | 'unresolved' | 'failed';

type SyncContext = {
  config: SyncConfig;
  username: string;
  state: SyncState;
  stateDirty: boolean;
  yearCache: Map<string, number | null>;
  unmatched: UnmatchedMap;
};

export type SyncRunResult = {
  aborted: false | 'neodb-auth' | 'bangumi-auth';
  report: PathReport;
  unmatched: UnmatchedMap;
  truncatedShelves: ShelfType[];
};

export default async function runNeodbToBangumi(
  config: SyncConfig,
): Promise<SyncRunResult> {
  const report = createReport();
  const unmatched = loadUnmatched(config.sync.unmatchedLog);
  const truncatedShelves: ShelfType[] = [];

  // ── 凭据探测：认证失败中止链路，不带病运行 ──
  if (!neodbToken || !(await verifyNeodbToken())) {
    consola.error('NeoDB 凭据不可用，链路中止。');
    return { aborted: 'neodb-auth', report, unmatched, truncatedShelves };
  }
  if (!bangumiToken) {
    consola.error('BANGUMI_ACCESS_TOKEN 未设置，链路中止。');
    return { aborted: 'bangumi-auth', report, unmatched, truncatedShelves };
  }
  const me = await getBangumiMe();
  if (!me) {
    consola.error('无法确认 Bangumi 账号身份，链路中止。');
    return { aborted: 'bangumi-auth', report, unmatched, truncatedShelves };
  }

  const state: SyncState =
    config.sync.incremental && !config.sync.fullSync
      ? loadSyncState(config.sync.stateFile)
      : {};
  const ctx: SyncContext = {
    config,
    username: me.username,
    state,
    stateDirty: false,
    yearCache: new Map(),
    unmatched,
  };

  consola.info(`Bangumi 账号: ${me.nickname || me.username}`);

  // 配额只统计真正进入处理流程的条目：增量跳过不消耗预算。否则定时运行每天都会在
  // 前 maxItems 条已同步条目上原地打转，永远走不到新增条目。
  let budgetUsed = 0;

  for (const shelfType of config.sync.shelfTypes) {
    consola.info(`开始遍历书架: ${shelfType}`);
    const result = await walkShelfPages(
      shelfType,
      config.sync.fullSync ? Number.MAX_SAFE_INTEGER : config.neodb.maxPages,
      async (marks) => {
        for (const mark of marks) {
          // 增量跳过在配额判断之前：已同步条目既不计扫描配额，也不消耗条目预算。
          if (
            config.sync.incremental &&
            !config.sync.fullSync &&
            ctx.state[mark.item.uuid] === fingerprintMark(mark)
          ) {
            record(report, 'skipped');
            report.scanned += 1;
            continue;
          }
          if (!config.sync.fullSync && budgetUsed >= config.sync.maxItems) {
            return false;
          }
          report.scanned += 1;
          budgetUsed += 1;
          const outcome = await processMark(mark, ctx);
          record(report, outcome);
        }
        return true;
      },
    );
    if (result.truncated) {
      truncatedShelves.push(shelfType);
    }
    // 每趟写一次状态：中断后最多重走一个书架的增量比较。
    if (ctx.stateDirty && !config.sync.dryRun) {
      saveSyncState(config.sync.stateFile, state);
      ctx.stateDirty = false;
    }
  }

  if (!config.sync.dryRun) {
    saveUnmatched(config.sync.unmatchedLog, unmatched);
  }
  return { aborted: false, report, unmatched, truncatedShelves };
}

// ─────────────────────────────────────────────────────────────────────────
// 单条处理
// ─────────────────────────────────────────────────────────────────────────

async function processMark(
  mark: NeodbShelfMark,
  ctx: SyncContext,
): Promise<ItemOutcome> {
  const { config } = ctx;
  const item = mark.item;
  const label = item.display_title || item.title || item.uuid;
  const fingerprint = fingerprintMark(mark);

  // 分类白名单（三态，写错配置时已在解析期失败在关闭一侧）。
  if (!categoryAllowed(config.sync.categories, item.category)) {
    return 'skipped';
  }

  // Bangumi 不支持该分类（podcast / performance）。
  if (!isBangumiSupportedCategory(item.category)) {
    consola.info(`Bangumi 无对应分类，跳过: ${item.category} ${label}`);
    return 'skipped';
  }

  // ── 三级匹配 ──
  const subjectId = await resolveSubjectId(item, ctx);
  if (subjectId == null) {
    upsertUnmatched(ctx.unmatched, item.uuid, {
      reason: 'no-bangumi-match',
      title: label,
      itemUrl: item.url,
    });
    consola.info(`未匹配 Bangumi 条目，记入待核对: ${label}`);
    return 'unresolved';
  }

  // ── 读取目标收藏：error 绝不当作 absent ──
  const existingRes = await getBangumiCollection(ctx.username, subjectId);
  if (existingRes.status === 'error') {
    return 'failed';
  }
  const existing = existingRes.status === 'found' ? existingRes.value : null;

  // ── 状态映射与保护 ──
  const status = mapShelfType(
    mark.shelf_type,
    existing?.type ?? 0,
    config.sync.statusGuard,
  );
  if (status.kind === 'unknown-shelf-type') {
    consola.warn(`无法识别的 NeoDB 书架状态「${mark.shelf_type}」，跳过: ${label}`);
    return 'skipped';
  }
  if (status.kind === 'skip-on-hold') {
    consola.info(`Bangumi 现有「搁置」，NeoDB 无法表达该状态，保留: ${label}`);
    return 'skipped';
  }
  if (status.kind === 'no-downgrade') {
    consola.info(`状态保护：Bangumi 已「看过」，不降级为想看/在看: ${label}`);
    return 'skipped';
  }

  // ── 字段合并 ──
  const rate = mergeRating(
    mark.rating_grade,
    existing?.rate ?? 0,
    config.sync.ratingProfile,
  );
  const comment = mergeComment(
    mark.comment_text,
    existing?.comment,
    config.sync.commentProfile,
  );

  const statusDiffers = (existing?.type ?? 0) !== status.type;
  const rateDiffers = rate !== (existing?.rate ?? 0);
  const commentDiffers = comment !== (existing?.comment ?? '');
  const privateDiffers =
    config.sync.mapPrivate &&
    existing != null &&
    mapVisibilityToPrivate(mark.visibility) !== existing.private;
  const differs =
    existing == null ||
    statusDiffers ||
    rateDiffers ||
    commentDiffers ||
    privateDiffers;

  // ── 书籍进度（迁移语义）：写入前规划，随收藏 upsert 同一请求提交 ──
  let epStatus: number | undefined;
  let volStatus: number | undefined;
  if (
    config.sync.progress &&
    mark.shelf_type === 'complete' &&
    item.category === 'book'
  ) {
    const subjectRes = await getBangumiSubject(subjectId);
    if (subjectRes.status !== 'found') {
      return 'failed';
    }
    const plan = planBookProgress(
      existing ?? { ep_status: 0, vol_status: 0 },
      subjectRes.value,
      { sourceComplete: true },
    );
    if (!plan.skip) {
      epStatus = plan.epStatus;
      volStatus = plan.volStatus;
    }
  }

  if (!differs && epStatus == null && volStatus == null) {
    rememberState(ctx, item.uuid, fingerprint);
    return 'unchanged';
  }

  if (config.sync.dryRun) {
    const extras = [
      epStatus != null ? ` ep_status=${epStatus}` : '',
      volStatus != null ? ` vol_status=${volStatus}` : '',
    ].join('');
    consola.info(
      `[dry-run] 计划写入 subject/${subjectId}: type=${status.type} rate=${rate} comment=${JSON.stringify(comment)}${extras}（${label}）`,
    );
    return 'written';
  }

  const ok = await upsertBangumiCollection(subjectId, {
    type: status.type,
    rate,
    comment,
    ...(config.sync.mapPrivate
      ? { private: mapVisibilityToPrivate(mark.visibility) }
      : {}),
    ...(epStatus != null ? { ep_status: epStatus } : {}),
    ...(volStatus != null ? { vol_status: volStatus } : {}),
  });
  if (!ok) {
    return 'failed';
  }

  // ── 分集拉满（complete 且 movie/tv；音乐/游戏无进度字段）──
  if (
    config.sync.progress &&
    mark.shelf_type === 'complete' &&
    (item.category === 'movie' || item.category === 'tv')
  ) {
    await fillEpisodeProgress(
      subjectId,
      item.category === 'movie',
      config.sync.includeSp,
    );
  }

  rememberState(ctx, item.uuid, fingerprint);
  return 'written';
}

function rememberState(ctx: SyncContext, uuid: string, fingerprint: string): void {
  if (ctx.config.sync.dryRun) {
    return;
  }
  ctx.state[uuid] = fingerprint;
  ctx.stateDirty = true;
}

// ─────────────────────────────────────────────────────────────────────────
// 三级匹配
// ─────────────────────────────────────────────────────────────────────────

/**
 * 外链 → 标题搜索 → 年份软过滤。
 * 全部失败返回 null（记 unresolved），不猜、不跨类型。
 */
async function resolveSubjectId(
  item: NeodbItem,
  ctx: SyncContext,
): Promise<number | null> {
  // 第一级：NeoDB 条目自带 Bangumi 外链时直接使用，最可靠。
  const linked = extractBangumiSubjectId(item.external_resources);
  if (linked != null) {
    return linked;
  }

  const types = neodbCategoryToBangumiSubjectTypes(item.category);
  if (!types.length) {
    return null;
  }

  const expectedYear = await resolveItemYear(item, ctx);

  // 第二级：按候选标题依次搜索；第三级：精确同名 + 年份过滤。
  for (const title of titleCandidates(item)) {
    const subjects = await searchBangumiSubjects(title, types);
    const exact = exactMatches(subjects, title);
    if (!exact.length) {
      continue;
    }
    // 年份优先用搜索结果自带字段；缺失时按需读完整条目补齐（懒加载）。
    const picked = await pickExactMatchByYear(
      exact,
      expectedYear,
      ctx.config.sync.yearTolerance,
      async (subject) => {
        const fromSearch = bangumiSubjectYear(subject);
        if (fromSearch != null) {
          return fromSearch;
        }
        const full = await getBangumiSubject(subject.id);
        return full.status === 'found' ? bangumiSubjectYear(full.value) : null;
      },
    );
    if (picked.status === 'matched') {
      return picked.subject.id;
    }
  }
  return null;
}

/** 条目年份：书架列表不含年份，缺时按 `api_url` 拉详情补齐并缓存。 */
async function resolveItemYear(
  item: NeodbItem,
  ctx: SyncContext,
): Promise<number | null> {
  const direct = neodbItemYear(item);
  if (direct != null) {
    return direct;
  }
  const cached = ctx.yearCache.get(item.uuid);
  if (cached !== undefined) {
    return cached;
  }
  const detail = await getNeodbItemDetail(item.api_url);
  const year = detail ? neodbItemYear(detail) : null;
  ctx.yearCache.set(item.uuid, year);
  return year;
}

// ─────────────────────────────────────────────────────────────────────────
// 分集拉满
// ─────────────────────────────────────────────────────────────────────────

/**
 * 把 complete 条目的分集推进到上限。
 * 以分集实际 type=2 为准：已看过的集不发请求，第二轮运行零请求（幂等）。
 * 电影只补第一个正片；无正片则仅收藏本身。
 */
async function fillEpisodeProgress(
  subjectId: number,
  isMovie: boolean,
  includeSp: boolean,
): Promise<void> {
  const episodesRes = await getBangumiEpisodes(subjectId);
  if (episodesRes.status !== 'found') {
    return;
  }
  const statesRes = await getBangumiEpisodeStates(subjectId);
  if (statesRes.status !== 'found') {
    return;
  }

  const plan = planEpisodeProgress(episodesRes.value, statesRes.value, {
    isMovie,
    includeSp,
    collected: true,
  });
  if (plan.reason === 'no-episodes') {
    consola.info(`分集进度：无正片，跳过 subject/${subjectId}`);
    return;
  }
  if (plan.missing.length === 0) {
    consola.info(
      `分集进度：无缺失集 subject/${subjectId} target=${plan.target.length}`,
    );
    return;
  }

  let added = 0;
  let failed = 0;
  for (const episodeId of plan.missing) {
    if (await markBangumiEpisodeWatched(subjectId, episodeId)) {
      added += 1;
    } else {
      failed += 1;
    }
  }
  consola.info(
    `分集进度: subject/${subjectId} kind=${isMovie ? 'movie' : 'tv'} ` +
      `target=${plan.target.length} added=${added} failed=${failed}`,
  );
}

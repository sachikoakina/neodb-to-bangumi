/**
 * 主链路：NeoDB 书架 → Bangumi 收藏。
 *
 * 流程：凭据探测 → 逐书架遍历（全量可续跑）→ 分类/增量闸门 → 匹配
 * （外链 → 标题 → 年份/媒体形态裁决）→ 目标认领 → 读收藏 → 按映射与保护
 * 规则 diff → 有变化才写 → 可选进度拉满。
 *
 * 契约：
 * - 目标读取失败（非 404）→ 该条 failed，绝不当作「未收藏」覆盖；
 * - 搜索失败 / 年份读取失败 → failed（可重跑），不伪装成 unresolved；
 * - 401/403 → 中止整条链路，不再继续写；
 * - 未匹配与歧义 → unresolved 并进待核对名单，不单独导致失败；
 * - 同一 Bangumi 目标被多条 NeoDB 标记命中时，只让最强认领者写入；
 * - dry-run 只输出计划，不代表已提交。
 */
import { consola } from 'consola';
import { neodbToken } from '../clients/neodb-http';
import {
  getNeodbItemDetail,
  verifyNeodbToken,
  walkShelfPages,
} from '../clients/neodb-shelf';
import { bangumiThrottle, bangumiToken } from '../clients/bangumi-http';
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
  bangumiPlatformMediaForm,
  bangumiSubjectYear,
  exactMatches,
  extractBangumiSubjectId,
  isYearFilterType,
  neodbCategoryToMediaForm,
  neodbItemYear,
  pickExactMatch,
  titleCandidates,
  type MediaForm,
} from '../rules/neodb-bangumi-matching';
import {
  isBangumiSupportedCategory,
  mapShelfType,
  mergeComment,
  mergeRating,
  neodbCategoryToBangumiSubjectTypes,
  planBangumiPrivate,
} from '../rules/neodb-bangumi-mapping';
import { planBookProgress, planEpisodeProgress } from '../rules/bangumi-progress';
import {
  shelfStatusRank,
  shouldSkipClaim,
  type TargetClaim,
} from '../rules/target-claim';
import {
  categoryAllowed,
  fingerprintMark,
  loadFullSyncCursor,
  loadSyncState,
  saveFullSyncCursor,
  saveSyncState,
  type FullSyncCursor,
  type SyncConfig,
  type SyncState,
} from '../sync-config';
import {
  createReport,
  loadUnmatched,
  pruneUnmatched,
  record,
  saveUnmatched,
  upsertUnmatched,
  type PathReport,
  type UnmatchedMap,
} from '../sync-report';
import type { BangumiSubject, NeodbItem, NeodbShelfMark, ShelfType } from '../types';

type ItemOutcome = 'written' | 'unchanged' | 'skipped' | 'unresolved' | 'failed';

type SyncContext = {
  config: SyncConfig;
  username: string;
  state: SyncState;
  stateDirty: boolean;
  yearCache: Map<string, number | null>;
  /** 完整条目缓存（仅成功解析的）；用于年份与平台，失败下轮重试。 */
  subjectCache: Map<number, BangumiSubject>;
  targetClaims: Map<number, TargetClaim>;
  unmatched: UnmatchedMap;
  aborted: boolean;
};

type MatchResult =
  | { kind: 'matched'; subjectId: number; via: TargetClaim['via'] }
  | {
      kind: 'unresolved';
      reason:
        'no-bangumi-match' | 'bangumi-all-rejected-by-year' | 'ambiguous-bangumi-match';
    }
  | {
      kind: 'failed';
      reason: 'bangumi-search-failed' | 'bangumi-year-fetch-failed';
      auth: boolean;
    };

type YearResolution = { kind: 'ok'; year: number | null } | { kind: 'failed' };

/** 认证中途失效：中止整轮，而不是把剩余条目录成 failed。 */
class AuthAbortError extends Error {}

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
    subjectCache: new Map(),
    targetClaims: new Map(),
    unmatched,
    aborted: false,
  };

  // 全量游标：只有正式的全量运行读写它；dry-run 不推进。
  const cursorPath =
    config.sync.fullSync && !config.sync.dryRun ? config.sync.fullSyncCursorFile : '';
  const cursor: FullSyncCursor = cursorPath ? loadFullSyncCursor(cursorPath) : {};

  consola.info(`Bangumi 账号: ${me.nickname || me.username}`);

  // 配额只统计真正进入处理流程的条目：增量跳过不消耗预算。否则定时运行每天都会在
  // 前 maxItems 条已同步条目上原地打转，永远走不到新增条目。
  let budgetUsed = 0;

  for (const shelfType of config.sync.shelfTypes) {
    if (ctx.aborted) break;
    consola.info(`开始遍历书架: ${shelfType}`);
    const startPage = cursorPath ? (cursor[shelfType] ?? 1) : 1;
    if (startPage > 1) {
      consola.info(`书架 ${shelfType} 从第 ${startPage} 页续跑。`);
    }

    const result = await walkShelfPages(
      shelfType,
      config.sync.fullSync ? Number.MAX_SAFE_INTEGER : config.neodb.maxPages,
      async (marks) => {
        // 页内先处理强状态：两个标记争同一目标时，胜者先写、弱者被跳过，
        // 而不是弱者先写、随后又被覆盖。
        const ordered = [...marks].sort(
          (a, b) =>
            shelfStatusRank(b.shelf_type) - shelfStatusRank(a.shelf_type) ||
            a.item.uuid.localeCompare(b.item.uuid),
        );

        for (const mark of ordered) {
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

          let outcome: ItemOutcome;
          try {
            outcome = await processMark(mark, ctx);
          } catch (error) {
            if (error instanceof AuthAbortError) {
              ctx.aborted = true;
              return false;
            }
            throw error;
          } finally {
            // 每条目结束后统一节流：一次处理会扇出搜索、读收藏、分集等多个请求。
            await bangumiThrottle();
          }
          record(report, outcome);
        }
        return true;
      },
      {
        startPage,
        onPage: async ({ page, nextPage, done }) => {
          if (!cursorPath) return;
          if (done) {
            delete cursor[shelfType];
          } else {
            cursor[shelfType] = nextPage;
          }
          saveFullSyncCursor(cursorPath, cursor);
          if (!done) {
            consola.info(`书架 ${shelfType} 第 ${page} 页完成，游标指向 ${nextPage}。`);
          }
        },
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
    // 清理必须发生在所有 upsert 之后：否则会把本轮刚刷新过 lastSeenAt 的条目误删。
    const pruned = pruneUnmatched(unmatched, config.sync.reviewStateMaxAgeDays);
    if (pruned.removed > 0) {
      unmatched.clear();
      for (const [key, value] of pruned.entries) {
        unmatched.set(key, value);
      }
      consola.info(
        `待核对名单清理：移除 ${pruned.removed} 条（超过 ${config.sync.reviewStateMaxAgeDays} 天未出现）`,
      );
    }
    saveUnmatched(config.sync.unmatchedLog, unmatched);
  }
  return {
    aborted: ctx.aborted ? 'bangumi-auth' : false,
    report,
    unmatched,
    truncatedShelves,
  };
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

  // ── 匹配 ──
  const match = await resolveMatch(item, ctx);
  if (match.kind === 'failed') {
    if (match.auth) {
      throw new AuthAbortError(match.reason);
    }
    consola.warn(`匹配失败，记 failed（下轮可重试）: ${match.reason} ${label}`);
    return 'failed';
  }
  if (match.kind === 'unresolved') {
    recordUnmatched(ctx, mark, match.reason, label);
    consola.info(`未匹配 Bangumi 条目（${match.reason}），记入待核对: ${label}`);
    return 'unresolved';
  }

  const subjectId = match.subjectId;

  // ── 目标认领：同一 subject 只让最强标记写入 ──
  const claim: TargetClaim = {
    subjectId,
    neodbUuid: item.uuid,
    shelfType: String(mark.shelf_type),
    via: match.via,
  };
  const incumbent = ctx.targetClaims.get(subjectId);
  if (incumbent && shouldSkipClaim(incumbent, claim)) {
    upsertUnmatched(ctx.unmatched, item.uuid, {
      reason: 'duplicate-target',
      title: label,
      itemUrl: item.url,
      category: item.category,
      shelf: String(mark.shelf_type),
      neodbUuid: item.uuid,
    });
    consola.info(
      `重复目标，保留更强认领: subject/${subjectId} ` +
        `kept=${incumbent.neodbUuid}(${incumbent.via},${incumbent.shelfType}) ` +
        `skipped=${item.uuid}(${claim.via},${claim.shelfType})`,
    );
    return 'skipped';
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

  // 只有真正进入写入判定的标记才占位。
  ctx.targetClaims.set(subjectId, claim);

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
  const privatePlan = planBangumiPrivate({
    mode: config.sync.bangumiPrivateMode,
    targetPrivate: config.sync.bangumiPrivate,
    sourceVisibility: mark.visibility,
    existingPrivate: existing?.private,
  });
  if (privatePlan.reason === 'source-missing') {
    consola.warn(
      `NeoDB 标记缺少 visibility，隐私取目标现值: subject/${subjectId} private=${privatePlan.private}`,
    );
  }

  const statusDiffers = (existing?.type ?? 0) !== status.type;
  const rateDiffers = rate !== (existing?.rate ?? 0);
  const commentDiffers = comment !== (existing?.comment ?? '');
  const privateDiffers = existing != null && privatePlan.private !== existing.private;
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

  const reasons = [
    statusDiffers ? 'status' : null,
    rateDiffers ? 'rating' : null,
    commentDiffers ? 'comment' : null,
    privateDiffers ? 'private' : null,
    epStatus != null || volStatus != null ? 'progress' : null,
  ].filter((reason): reason is string => reason != null);

  if (config.sync.dryRun) {
    const extras = [
      epStatus != null ? ` ep_status=${epStatus}` : '',
      volStatus != null ? ` vol_status=${volStatus}` : '',
    ].join('');
    consola.info(
      `[dry-run] 计划写入 subject/${subjectId}: reasons=${reasons.join('+')} ` +
        `type=${existing?.type ?? 'none'}→${status.type} ` +
        `rate=${existing?.rate ?? 0}→${rate} ` +
        `comment=${JSON.stringify(existing?.comment ?? '')}→${JSON.stringify(comment)} ` +
        `private=${existing?.private ?? 'none'}→${privatePlan.private}${extras}（${label}）`,
    );
    return 'written';
  }

  const ok = await upsertBangumiCollection(subjectId, {
    type: status.type,
    rate,
    comment,
    private: privatePlan.private,
    ...(epStatus != null ? { ep_status: epStatus } : {}),
    ...(volStatus != null ? { vol_status: volStatus } : {}),
  });
  if (!ok) {
    return 'failed';
  }

  consola.info(
    `写入 Bangumi: subject/${subjectId} reasons=${reasons.join('+')} ` +
      `type=${status.type} rate=${rate} private=${privatePlan.private}` +
      `${epStatus != null ? ` ep_status=${epStatus}` : ''}` +
      `${volStatus != null ? ` vol_status=${volStatus}` : ''}（${label}）`,
  );

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
      config.sync.includeOpEd,
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

function recordUnmatched(
  ctx: SyncContext,
  mark: NeodbShelfMark,
  reason: string,
  label: string,
): void {
  upsertUnmatched(ctx.unmatched, mark.item.uuid, {
    reason,
    title: label,
    itemUrl: mark.item.url,
    category: String(mark.item.category),
    shelf: String(mark.shelf_type),
    neodbUuid: mark.item.uuid,
  });
}

// ─────────────────────────────────────────────────────────────────────────
// 匹配
// ─────────────────────────────────────────────────────────────────────────

/**
 * 外链 → 标题搜索 → 年份/媒体形态裁决。
 *
 * 与旧实现的区别：
 * - 搜索失败不再等于「没有结果」，而是 failed（可重跑）；
 * - 年份读取失败同样记 failed，而不是退化成无年份匹配；
 * - 多候选不再取第一个，证据不足时记 ambiguous 而不是猜。
 */
async function resolveMatch(item: NeodbItem, ctx: SyncContext): Promise<MatchResult> {
  // 第一级：NeoDB 条目自带 Bangumi 外链时直接使用，最可靠。
  const linked = extractBangumiSubjectId(item.external_resources);
  if (linked != null) {
    return { kind: 'matched', subjectId: linked, via: 'link' };
  }

  const types = neodbCategoryToBangumiSubjectTypes(item.category);
  if (!types.length) {
    return { kind: 'unresolved', reason: 'no-bangumi-match' };
  }

  const yearRes = await resolveItemYear(item, ctx);
  if (yearRes.kind === 'failed') {
    consola.warn(
      `NeoDB 条目年份读取失败，本轮不做无年份匹配: ${item.display_title || item.title}`,
    );
    return { kind: 'failed', reason: 'bangumi-year-fetch-failed', auth: false };
  }

  const mediaForm = neodbCategoryToMediaForm(item.category);
  let sawExact = false;

  // 第二级：按候选标题依次搜索；第三级：精确同名 + 证据裁决。
  for (const title of titleCandidates(item)) {
    const search = await searchBangumiSubjects(title, types);
    if (search.status !== 'found') {
      // 搜索只会返回 found/error；absent 分支防御性归入可重跑失败。
      return {
        kind: 'failed',
        reason: 'bangumi-search-failed',
        auth: search.status === 'error' && search.scope === 'auth',
      };
    }

    const exact = exactMatches(search.value, title);
    if (!exact.length) {
      continue;
    }
    sawExact = true;

    const picked = await pickExactMatch(
      exact,
      yearRes.year,
      ctx.config.sync.yearTolerance,
      {
        mediaForm,
        resolveEvidence: (subject) => resolveCandidateEvidence(subject, ctx),
      },
    );

    if (picked.status === 'matched') {
      consola.info(
        `Bangumi 匹配: uuid=${item.uuid} via=title title="${title}" ` +
          `year=${yearRes.year ?? 'missing'} media=${mediaForm ?? 'unknown'} ` +
          `candidates=${exact.length} chosen=${picked.subject.id}`,
      );
      return { kind: 'matched', subjectId: picked.subject.id, via: 'title' };
    }
    if (picked.status === 'ambiguous') {
      consola.warn(
        `同名候选无法唯一裁决: uuid=${item.uuid} title="${title}" ` +
          `year=${yearRes.year ?? 'missing'} media=${mediaForm ?? 'unknown'} ` +
          `candidates=${picked.candidates.map((c) => c.id).join(',')}`,
      );
      return { kind: 'unresolved', reason: 'ambiguous-bangumi-match' };
    }
  }

  return {
    kind: 'unresolved',
    reason: sawExact ? 'bangumi-all-rejected-by-year' : 'no-bangumi-match',
  };
}

/**
 * 候选证据：年份与媒体形态。只有动画（2）/真人（6）参与，其余类型直接返回
 * 不可判定，避免为书籍/音乐/游戏白读完整条目。
 */
async function resolveCandidateEvidence(
  subject: BangumiSubject,
  ctx: SyncContext,
): Promise<{ year: number | null; mediaForm: MediaForm | null }> {
  if (!isYearFilterType(subject.type)) {
    return { year: null, mediaForm: null };
  }
  const full = await getFullSubject(subject.id, ctx);
  return {
    year: bangumiSubjectYear(subject) ?? (full ? bangumiSubjectYear(full) : null),
    mediaForm: bangumiPlatformMediaForm(full?.platform),
  };
}

/** 完整条目缓存：只缓存成功解析的，失败下轮重试。 */
async function getFullSubject(
  subjectId: number,
  ctx: SyncContext,
): Promise<BangumiSubject | null> {
  const cached = ctx.subjectCache.get(subjectId);
  if (cached) {
    return cached;
  }
  const result = await getBangumiSubject(subjectId);
  if (result.status !== 'found') {
    return null;
  }
  ctx.subjectCache.set(subjectId, result.value);
  return result.value;
}

/**
 * 条目年份：书架列表不含年份，缺时按 `api_url` 拉详情补齐并缓存。
 * 读取失败返回 failed 且不缓存 —— 不能把一次网络故障固化成「没有年份」。
 */
async function resolveItemYear(
  item: NeodbItem,
  ctx: SyncContext,
): Promise<YearResolution> {
  const direct = neodbItemYear(item);
  if (direct != null) {
    return { kind: 'ok', year: direct };
  }
  const cached = ctx.yearCache.get(item.uuid);
  if (cached !== undefined) {
    return { kind: 'ok', year: cached };
  }
  const detail = await getNeodbItemDetail(item.api_url);
  if (detail === null) {
    return { kind: 'failed' };
  }
  const year = neodbItemYear(detail);
  ctx.yearCache.set(item.uuid, year);
  return { kind: 'ok', year };
}

// ─────────────────────────────────────────────────────────────────────────
// 分集拉满
// ─────────────────────────────────────────────────────────────────────────

/**
 * 把 complete 条目的分集推进到上限。
 * 以分集实际 type=2 为准：已看过的集不发请求，第二轮运行零请求（幂等）。
 * 电影只补第一个正片；无正片则仅收藏本身。OP/ED 需显式开启且电影永不处理。
 */
async function fillEpisodeProgress(
  subjectId: number,
  isMovie: boolean,
  includeSp: boolean,
  includeOpEd: boolean,
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
    includeOpEd,
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
      `target=${plan.target.length} missing=${plan.missing.length} ` +
      `added=${added} failed=${failed}`,
  );
}

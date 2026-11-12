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
 * - 401/403 → 中止整条链路，不再继续写（读与写同一处置）；
 * - 写入 404 → unresolved + 待核对：服务端拒绝为该目标建收藏，重试无意义；
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
  addItemTime,
  metricsSnapshot,
  resetMetrics,
  sleepCount,
  timeStage,
  type RunMetricsSnapshot,
} from '../metrics';
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
import { absoluteNeodbUrl, displayName } from '../rules/neodb-display';
import { decideWriteOutcome, type ProgressSignal } from '../rules/write-decision';
import {
  shelfStatusRank,
  shouldSkipClaim,
  type TargetClaim,
} from '../rules/target-claim';
import { isUpToDate, progressApplicable } from '../rules/progress-gate';
import { timeBudgetExhausted, mergeStopReason, type StopReason } from '../rules/budget';
import {
  categoryAllowed,
  createSyncState,
  fingerprintMark,
  loadFullSyncCursor,
  loadSyncStateWithStatus,
  saveFullSyncCursor,
  saveSyncState,
  type FullSyncCursor,
  type SyncConfig,
  type SyncState,
} from '../sync-config';
import {
  createReport,
  createUnmatchedEntry,
  dryRunUnmatchedPath,
  loadUnmatched,
  record,
  saveUnmatched,
  type MatchAuditEntry,
  type PathReport,
  type RemovedEntry,
  type UnmatchedEntry,
  type UnmatchedKind,
  type UnmatchedMap,
} from '../sync-report';
import { mergeRounds } from '../rules/review-rounds';
import type {
  BangumiSubject,
  NeodbItem,
  NeodbShelfMark,
  ReadResult,
  ShelfType,
  SyncStateDiscardReason,
} from '../types';

type ItemOutcome = 'written' | 'unchanged' | 'skipped' | 'unresolved' | 'failed';

/** 匹配证据留痕：写入匹配审计，错配可离线复核。 */
type MatchEvidenceInfo = {
  sourceYear: number | null;
  sourceMediaForm: MediaForm | null;
  candidateYear: number | null;
  candidateMediaForm: MediaForm | null;
  /** 参与裁决的精确同名候选 id（含未命中者）。 */
  candidateIds: number[] | null;
  /** strict 模式下因证据不足被持留。 */
  strictHold: boolean;
};

type SyncContext = {
  config: SyncConfig;
  username: string;
  state: SyncState;
  stateDirty: boolean;
  yearCache: Map<string, number | null>;
  /** 完整条目缓存（仅成功解析的）；用于年份与平台，失败下轮重试。 */
  subjectCache: Map<number, BangumiSubject>;
  targetClaims: Map<number, TargetClaim>;
  unmatched: UnmatchedEntry[];
  aborted: boolean;
  /** 本轮提前停止的原因：条目配额或时间预算；未触发为 null。 */
  stopReason: StopReason;
  /** 匹配审计：按处理顺序累积，运行结束统一落盘（含 dry-run）。 */
  matchAudit: MatchAuditEntry[];
  /** 本轮真正检查过、且仍未导入的条目（按 uuid 索引）。 */
  observed: UnmatchedMap;
  /** 本轮因导入成功而移出的 uuid。 */
  importedUuids: Set<string>;
  /** 本轮完整遍历完毕的书架：只有它们能判定「未再出现」。 */
  coveredShelves: Set<string>;
};

type MatchResult =
  | {
      kind: 'matched';
      subjectId: number;
      via: TargetClaim['via'];
      /** 命中条目名；link 直连不额外发请求，为 null。 */
      subjectName: string | null;
      evidence: MatchEvidenceInfo | null;
    }
  | {
      kind: 'unresolved';
      reason:
        | 'no-bangumi-match'
        | 'bangumi-all-rejected-by-year'
        | 'ambiguous-bangumi-match'
        | 'ambiguous-year-missing';
      evidence: MatchEvidenceInfo | null;
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
  /** 合并后的全量名单（含仍在观察期的条目）。 */
  unmatched: UnmatchedEntry[];
  /** 名单正文：已越过观察窗。 */
  unmatchedLive: UnmatchedEntry[];
  /** 本轮首次越过观察窗。 */
  unmatchedAdded: UnmatchedEntry[];
  /** 本轮移出名单的条目与原因。 */
  unmatchedRemoved: RemovedEntry[];
  /** 仍在观察窗内。 */
  unmatchedObserving: UnmatchedEntry[];
  /** 本轮没进入扫描集合、因此冻结的条目。 */
  unmatchedFrozen: UnmatchedEntry[];
  truncatedShelves: ShelfType[];
  matchAudit: MatchAuditEntry[];
  /** 本轮耗时与请求等待的观测快照；只用于诊断，不参与任何写入判定。 */
  metrics: RunMetricsSnapshot;
  /** 提前停止的原因（条目配额 / 时间预算）；未触发为 null。 */
  stopReason: StopReason;
  /** 非 null 表示缓存状态被丢弃、本轮按空状态运行；用于在摘要里说明。 */
  stateReset: SyncStateDiscardReason | null;
  /**
   * 本轮真正进入处理流程的条数；常规运行受 `SYNC_MAX_ITEMS` 限制。
   * 配额按书架独立，因此理论上限是 `书架数 × SYNC_MAX_ITEMS`。
   */
  quotaUsed: number;
  /** 本轮因增量指纹命中而整条跳过的条数（不消耗配额、不产生条目日志）。 */
  incrementalSkipped: number;
  /** 因触顶 `SYNC_MAX_ITEMS` 而提前结束的书架（其余书架仍已执行）。 */
  cappedShelves: ShelfType[];
};

export default async function runNeodbToBangumi(
  config: SyncConfig,
): Promise<SyncRunResult> {
  // 观测累加器是模块级的：每轮开始清零，避免同进程多次运行（或测试）互相污染。
  resetMetrics();
  const report = createReport();
  const unmatched = loadUnmatched(config.sync.unmatchedLog);
  const truncatedShelves: ShelfType[] = [];

  // ── 凭据探测：认证失败中止链路，不带病运行 ──
  if (!neodbToken || !(await verifyNeodbToken())) {
    consola.error('NeoDB 凭据不可用，链路中止。');
    return {
      aborted: 'neodb-auth',
      report,
      unmatched,
      unmatchedLive: [],
      unmatchedAdded: [],
      unmatchedRemoved: [],
      unmatchedObserving: [],
      unmatchedFrozen: [],
      truncatedShelves,
      matchAudit: [],
      metrics: metricsSnapshot(),
      stopReason: null,
      stateReset: null,
      quotaUsed: 0,
      cappedShelves: [],
      incrementalSkipped: 0,
    };
  }
  if (!bangumiToken) {
    consola.error('BANGUMI_ACCESS_TOKEN 未设置，链路中止。');
    return {
      aborted: 'bangumi-auth',
      report,
      unmatched,
      unmatchedLive: [],
      unmatchedAdded: [],
      unmatchedRemoved: [],
      unmatchedObserving: [],
      unmatchedFrozen: [],
      truncatedShelves,
      matchAudit: [],
      metrics: metricsSnapshot(),
      stopReason: null,
      stateReset: null,
      quotaUsed: 0,
      cappedShelves: [],
      incrementalSkipped: 0,
    };
  }
  const me = await getBangumiMe();
  if (!me) {
    consola.error('无法确认 Bangumi 账号身份，链路中止。');
    return {
      aborted: 'bangumi-auth',
      report,
      unmatched,
      unmatchedLive: [],
      unmatchedAdded: [],
      unmatchedRemoved: [],
      unmatchedObserving: [],
      unmatchedFrozen: [],
      truncatedShelves,
      matchAudit: [],
      metrics: metricsSnapshot(),
      stopReason: null,
      stateReset: null,
      quotaUsed: 0,
      cappedShelves: [],
      incrementalSkipped: 0,
    };
  }

  const stateLoad =
    config.sync.incremental && !config.sync.fullSync
      ? loadSyncStateWithStatus(config.sync.stateFile)
      : { state: createSyncState(), discarded: null };
  const state: SyncState = stateLoad.state;
  if (stateLoad.discarded) {
    // 丢弃是设计内的，但必须显式说明：否则读者会把「多扫一轮」误读成增量正常。
    consola.warn(
      `本轮按空状态运行（${stateLoad.discarded}）：缓存里的增量状态已被丢弃，` +
        '已同步条目会重算；写入幂等，代价是多扫一轮。',
    );
  }
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
    stopReason: null,
    matchAudit: [],
    observed: new Map(),
    importedUuids: new Set(),
    coveredShelves: new Set(),
  };

  // 全量游标：只有正式的全量运行读写它；dry-run 不推进。
  const cursorPath =
    config.sync.fullSync && !config.sync.dryRun ? config.sync.fullSyncCursorFile : '';
  const cursor: FullSyncCursor = cursorPath ? loadFullSyncCursor(cursorPath) : {};

  // 刻意不打印账号身份：昵称是跨平台身份锚点，进日志就能反查到该账号的全部
  // 公开收藏与评论。凭据探测已在前面完成，这里没有需要回显的信息。

  // 配额按书架独立：每个书架从零开始，4 个书架合计最多 `4 × SYNC_MAX_ITEMS`。
  // 这样前一个书架吃满配额不会让后面的书架空转（旧实现是整轮共享一个计数器）。
  let quotaUsed = 0;
  // 增量指纹命中而整条跳过的条数。它计入 scanned/skipped，但不消耗配额、也不
  // 产生任何条目日志；单独计数才能让汇总行把「扫描」与「配额消耗」分开说清。
  let incrementalSkipped = 0;
  // 触顶的书架：摘要据此说明「哪些书架被截断」，而不是笼统说「配额用尽」。
  const cappedShelves: ShelfType[] = [];
  // 时间预算从遍历开始计时（不含凭据探测）；全量运行不使用它。
  const walkStartedAt = Date.now();

  for (const shelfType of config.sync.shelfTypes) {
    if (ctx.aborted) break;
    consola.info(`开始遍历书架: ${shelfType}`);
    const startPage = cursorPath ? (cursor[shelfType] ?? 1) : 1;
    if (startPage > 1) {
      consola.info(`书架 ${shelfType} 从第 ${startPage} 页续跑。`);
    }

    // 每书架独立的配额计数器（对齐 Audiovisual-Transporter 的 shelf×category 预算）。
    let shelfQuotaUsed = 0;
    // 主动停止（配额 / 时间预算 / 认证中止）时 walkShelfPages 仍返回 truncated=false，
    // 因此必须自己记账：这类书架没有走完，不能参与「未再出现」的判定。
    let stoppedEarly = false;

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
          // 判定交给纯函数：除指纹外还要看「进度是否已拉满」——否则打开
          // SYNC_PROGRESS 后，历史上已记指纹的条目永远轮不到补分集。
          const fingerprint = fingerprintMark(mark);
          if (
            config.sync.incremental &&
            !config.sync.fullSync &&
            isUpToDate({
              mark,
              fingerprint,
              marks: ctx.state.marks,
              progress: ctx.state.progress,
              progressEnabled: config.sync.progress,
            })
          ) {
            record(report, 'skipped');
            report.scanned += 1;
            incrementalSkipped += 1;
            continue;
          }
          if (!config.sync.fullSync) {
            // 双上限、先到者停：条目轻时按条数，条目重时按时间。
            if (shelfQuotaUsed >= config.sync.maxItems) {
              // 只结束当前书架：后面的书架仍有自己的配额，必须继续跑。
              ctx.stopReason = mergeStopReason(ctx.stopReason, 'max-items');
              if (!cappedShelves.includes(shelfType)) cappedShelves.push(shelfType);
              consola.warn(
                `书架 ${shelfType} 达到 SYNC_MAX_ITEMS（${config.sync.maxItems}），` +
                  '结束本书架；其余书架继续。',
              );
              stoppedEarly = true;
              return false;
            }
            if (
              timeBudgetExhausted(Date.now() - walkStartedAt, config.sync.timeBudgetMs)
            ) {
              ctx.stopReason = mergeStopReason(ctx.stopReason, 'time-budget');
              consola.info(
                `时间预算用尽（${config.sync.timeBudgetMs}ms），本轮主动收尾；` +
                  `已处理条目的状态会正常落盘。`,
              );
              stoppedEarly = true;
              return false;
            }
          }
          report.scanned += 1;
          shelfQuotaUsed += 1;
          quotaUsed += 1;

          // 单条未预期异常不能葬送整轮：认证失败才中止，其余记 failed 后继续，
          // 保证审计 / 报告 / 摘要仍能落盘。
          const itemStartedAt = performance.now();
          const sleepsBefore = sleepCount('bangumi');
          let outcome: ItemOutcome = 'failed';
          try {
            outcome = await processMark(mark, ctx);
          } catch (error) {
            if (error instanceof AuthAbortError) {
              ctx.aborted = true;
              stoppedEarly = true;
              return false;
            }
            const detail = error instanceof Error ? error.message : String(error);
            ctx.matchAudit.push({
              ...createAuditEntry(mark),
              outcome: 'failed',
              reason: 'item-threw',
              error: truncateError(detail),
            });
            observeUnmatched(ctx, mark, 'failed', 'item-threw', displayName(mark.item));
            consola.error(
              `条目处理异常，继续下一条: ${displayName(mark.item)} — ${absoluteNeodbUrl(mark.item.url, ctx.config.neodb.baseUrl)}`,
              detail,
            );
          } finally {
            // 每条目结束后统一节流：一次处理会扇出搜索、读收藏、分集等多个请求。
            // 但分集路径已经在每个请求前睡过（列表/状态/逐集 PUT），此时再睡一次
            // 是纯重复计费，故只在「本条没有发生过任何 Bangumi 等待」时补一次。
            if (sleepCount('bangumi') === sleepsBefore) {
              await bangumiThrottle();
            }
          }
          addItemTime(performance.now() - itemStartedAt);
          record(report, outcome);
          // 已导入的条目当轮即移出名单：它不再是缺口，不该再等两轮缺席。
          // dry-run 的 written 只是计划，不能据此改写正式名单的视角。
          if (
            !config.sync.dryRun &&
            (outcome === 'written' || outcome === 'unchanged')
          ) {
            ctx.importedUuids.add(mark.item.uuid);
          }
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
      // 截断比配额触顶更严重：链路根本不知道自己漏了什么。原因按严重度合并，
      // 摘要因此不会把一次网络问题说成「调大 SYNC_MAX_ITEMS 就好」。
      ctx.stopReason = mergeStopReason(ctx.stopReason, 'partial-read');
    }
    // 覆盖判定：从第一页走到底、且没被配额 / 时间预算 / 认证中止打断，才算走完。
    // 只有走完的书架才允许把「没再上报」记成缺席。
    if (startPage === 1 && !result.truncated && !stoppedEarly) {
      ctx.coveredShelves.add(shelfType);
    }
    // 每趟写一次状态：中断后最多重走一个书架的增量比较。
    if (ctx.stateDirty && !config.sync.dryRun) {
      saveSyncState(config.sync.stateFile, state);
      ctx.stateDirty = false;
    }
  }

  const merged = mergeRounds({
    previous: unmatched,
    observed: [...ctx.observed.values()],
    coveredShelves: ctx.coveredShelves,
    importedUuids: ctx.importedUuids,
    now: new Date().toISOString(),
  });

  if (!config.sync.dryRun) {
    saveUnmatched(config.sync.unmatchedLog, merged.entries);
  } else {
    // dry-run 同样产出名单：写派生文件，不污染正式文件。
    const dryRunPath = dryRunUnmatchedPath(config.sync.unmatchedLog);
    saveUnmatched(dryRunPath, merged.entries);
    consola.info(`dry-run 待核对名单（本轮视角）已写入: ${dryRunPath}`);
  }
  if (merged.removed.length) {
    consola.info(
      `待核对名单移除 ${merged.removed.length} 条：` +
        merged.removed.map((item) => `${item.entry.title}（${item.cause}）`).join('、'),
    );
  }

  return {
    aborted: ctx.aborted ? 'bangumi-auth' : false,
    report,
    unmatched: merged.entries,
    unmatchedLive: merged.live,
    unmatchedAdded: merged.added,
    unmatchedRemoved: merged.removed,
    unmatchedObserving: merged.observing,
    unmatchedFrozen: merged.frozen,
    truncatedShelves,
    matchAudit: ctx.matchAudit,
    metrics: metricsSnapshot(),
    stateReset: stateLoad.discarded,
    stopReason: ctx.stopReason,
    quotaUsed,
    incrementalSkipped,
    cappedShelves,
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
  const label = displayName(item);
  const fingerprint = fingerprintMark(mark);

  // 匹配审计：每条处理的条目记录匹配对象、证据与结局，运行结束统一落盘。
  const audit = createAuditEntry(mark);
  const finish = (
    outcome: ItemOutcome,
    reason: string | null = null,
    error: string | null = null,
  ): ItemOutcome => {
    ctx.matchAudit.push({ ...audit, outcome, reason, error });
    return outcome;
  };

  // 分类白名单（三态，写错配置时已在解析期失败在关闭一侧）。
  if (!categoryAllowed(config.sync.categories, item.category)) {
    return finish('skipped', 'category-not-allowed');
  }

  // Bangumi 不支持该分类（podcast / performance）。
  if (!isBangumiSupportedCategory(item.category)) {
    consola.info(`Bangumi 无对应分类，跳过: ${item.category} ${label}`);
    return finish('skipped', 'unsupported-category');
  }

  // ── 匹配 ──
  const match = await timeStage('match', () => resolveMatch(item, ctx));
  if (match.kind === 'failed') {
    if (match.auth) {
      throw new AuthAbortError(match.reason);
    }
    consola.warn(
      `匹配失败，记 failed（下轮可重试）: uuid=${item.uuid} ${match.reason} ${label}`,
    );
    observeUnmatched(ctx, mark, 'failed', match.reason, label);
    return finish('failed', match.reason);
  }
  if (match.kind === 'unresolved') {
    observeUnmatched(ctx, mark, 'unresolved', match.reason, label);
    consola.info(
      `未匹配 Bangumi 条目（${match.reason}），记入待核对: uuid=${item.uuid} ${label}`,
    );
    return finish('unresolved', match.reason);
  }

  // 命中：把匹配方式、证据与候选清单带入审计。
  audit.via = match.via;
  audit.subjectId = match.subjectId;
  audit.subjectName = match.subjectName;
  if (match.evidence) {
    audit.sourceYear = match.evidence.sourceYear;
    audit.sourceMediaForm = match.evidence.sourceMediaForm;
    audit.candidateYear = match.evidence.candidateYear;
    audit.candidateMediaForm = match.evidence.candidateMediaForm;
    audit.candidates = match.evidence.candidateIds;
    audit.strictHold = match.evidence.strictHold;
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
    // 让位给更强认领者：本条目下轮仍会重新裁决。
    observeUnmatched(ctx, mark, 'skipped', 'duplicate-target', label, subjectId);
    consola.info(
      `重复目标，保留更强认领: subject/${subjectId} ` +
        `kept=${incumbent.neodbUuid}(${incumbent.via},${incumbent.shelfType}) ` +
        `skipped=${item.uuid}(${claim.via},${claim.shelfType})`,
    );
    return finish('skipped', 'duplicate-target');
  }

  // ── 读取目标收藏：error 绝不当作 absent ──
  const existingRes = await timeStage('read', () =>
    getBangumiCollection(ctx.username, subjectId),
  );
  if (existingRes.status === 'error') {
    observeUnmatched(ctx, mark, 'failed', 'target-read-failed', label, subjectId);
    return finish('failed', 'target-read-failed', existingRes.message);
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
    return finish('skipped', 'unknown-shelf-type');
  }
  if (status.kind === 'skip-on-hold') {
    consola.info(`Bangumi 现有「搁置」，NeoDB 无法表达该状态，保留: ${label}`);
    return finish('skipped', 'hold-protected');
  }
  if (status.kind === 'no-downgrade') {
    // 守卫只固定状态字段：评分/短评/隐私仍按各自开关合并。整条跳过会让一次状态
    // 冲突连带丢弃新来源上的评分/短评修正。
    consola.info(
      `状态保护：Bangumi 已「看过」，保持状态；评分/短评/隐私照常合并: ${label}`,
    );
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

  // ── 书籍进度：源端已 complete，按总量拉满；随收藏 upsert 同一请求提交 ──
  let epStatus: number | undefined;
  let volStatus: number | undefined;
  if (
    config.sync.progress &&
    mark.shelf_type === 'complete' &&
    item.category === 'book'
  ) {
    const subjectRes = await timeStage('read', () =>
      readSubjectCached(subjectId, ctx.subjectCache),
    );
    if (subjectRes.status !== 'found') {
      observeUnmatched(ctx, mark, 'failed', 'subject-read-failed', label, subjectId);
      return finish(
        'failed',
        'subject-read-failed',
        subjectRes.status === 'error' ? subjectRes.message : 'subject 不存在',
      );
    }
    const plan = planBookProgress(
      existing ?? { ep_status: 0, vol_status: 0 },
      subjectRes.value,
    );
    if (!plan.skip) {
      epStatus = plan.epStatus;
      volStatus = plan.volStatus;
    }
  }

  const bookProgressPending = epStatus != null || volStatus != null;
  // 分集进度是独立信号：收藏字段完整不代表分集点满，因此不能挂在 differs 上。
  const episodesApplicable =
    config.sync.progress &&
    mark.shelf_type === 'complete' &&
    (item.category === 'movie' || item.category === 'tv');

  const reasons = [
    statusDiffers ? 'status' : null,
    rateDiffers ? 'rating' : null,
    commentDiffers ? 'comment' : null,
    privateDiffers ? 'private' : null,
    bookProgressPending ? 'progress' : null,
  ].filter((reason): reason is string => reason != null);

  if (config.sync.dryRun) {
    if (!differs && !bookProgressPending) {
      if (episodesApplicable) {
        consola.info(
          `[dry-run] 收藏字段无变化；分集完整性不在 dry-run 校验（正式运行才读取）: ${label}`,
        );
      }
      return finish('unchanged');
    }
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
    return finish('written', `plan:${reasons.join('+')}`);
  }

  // ── 收藏 upsert：只在字段有差异或书籍进度待写时发送 ──
  const needsCollectionWrite = differs || bookProgressPending;
  if (needsCollectionWrite) {
    const write = await timeStage('write', () =>
      upsertBangumiCollection(subjectId, {
        type: status.type,
        rate,
        comment,
        private: privatePlan.private,
        ...(epStatus != null ? { ep_status: epStatus } : {}),
        ...(volStatus != null ? { vol_status: volStatus } : {}),
      }),
    );
    if (!write.ok) {
      // 认证失效与读路径同一处置：中止整轮（退出码 2），不把剩余条目录成 failed。
      if (write.kind === 'auth') {
        throw new AuthAbortError('collection-write-auth');
      }
      // 404：服务端拒绝为该目标建收藏（条目合并 / 锁定 / 不可收藏）。重试无法
      // 自愈，因此转待核对留人处理，且**不**判 failed —— 否则一条坏数据会让
      // 每晚的定时任务固定变红，红灯彻底失去区分度。
      if (write.kind === 'not-found') {
        observeUnmatched(
          ctx,
          mark,
          'unresolved',
          'collection-not-found',
          label,
          subjectId,
        );
        consola.warn(
          `目标不可收藏，转待核对: subject/${subjectId} uuid=${item.uuid} ` +
            `${write.message}（${label}）`,
        );
        return finish(
          'unresolved',
          'collection-not-found',
          truncateError(write.message),
        );
      }
      observeUnmatched(
        ctx,
        mark,
        'failed',
        'collection-write-failed',
        label,
        subjectId,
      );
      return finish('failed', 'collection-write-failed', truncateError(write.message));
    }
    consola.info(
      `写入 Bangumi: https://bangumi.tv/subject/${subjectId} reasons=${reasons.join('+')} ` +
        `type=${status.type} rate=${rate} private=${privatePlan.private}` +
        `${epStatus != null ? ` ep_status=${epStatus}` : ''}` +
        `${volStatus != null ? ` vol_status=${volStatus}` : ''}（${label}）`,
    );
  } else if (episodesApplicable) {
    consola.info(`收藏字段无变化，仅检查分集: subject/${subjectId}（${label}）`);
  }

  // ── 分集拉满（complete 且 movie/tv；音乐/游戏无进度字段）──
  let progress: ProgressSignal = { kind: 'not-applicable' };
  if (episodesApplicable) {
    progress = toProgressSignal(
      await timeStage('episode', () =>
        fillEpisodeProgress(
          subjectId,
          item.category === 'movie',
          config.sync.includeSp,
          config.sync.includeOpEd,
          {},
          { maxEpisodes: config.sync.maxEpisodesPerItem },
        ),
      ),
    );
  }

  const decision = decideWriteOutcome({
    differs,
    bookProgress: bookProgressPending,
    progress,
  });

  if (decision.outcome === 'failed') {
    // 分集失败必须清掉指纹：指纹只覆盖收藏字段，留着会让下一轮增量直接跳过，
    // 把「没点满的分集」永久锁死。
    forgetState(ctx, item.uuid);
    const message = progress.kind === 'failed' ? progress.message : null;
    consola.error(
      `写入未完成: subject/${subjectId} reason=${decision.reason ?? 'unknown'}` +
        `${message ? ` ${message}` : ''}（${label}）`,
    );
    observeUnmatched(
      ctx,
      mark,
      'failed',
      decision.reason ?? 'collection-write-failed',
      label,
      subjectId,
    );
    return finish('failed', decision.reason, message);
  }

  const progressPartial = progress.kind === 'written' && progress.partial === true;
  rememberState(ctx, item.uuid, fingerprint, subjectId);
  // 进度适用、本轮没失败、也没被上限截断 → 记为已拉满；否则保持 pending 下一轮继续。
  if (!progressPartial && progressApplicable(mark, config.sync.progress)) {
    markProgressDone(ctx, item.uuid);
  }
  if (progressPartial) {
    consola.info(
      `分集未拉满，保留 pending 供下一轮继续: subject/${subjectId} ` +
        `remaining=${progress.kind === 'written' ? (progress.remaining ?? '?') : '?'}（${label}）`,
    );
  }
  return finish(
    decision.outcome,
    decision.outcome === 'written'
      ? progressPartial
        ? 'progress-partial'
        : (decision.reason ?? (reasons.join('+') || 'progress'))
      : null,
  );
}

function rememberState(
  ctx: SyncContext,
  uuid: string,
  fingerprint: string,
  subjectId: number,
): void {
  if (ctx.config.sync.dryRun) {
    return;
  }
  ctx.state.marks[uuid] = fingerprint;
  // 只作诊断留痕（清理错配时对照），不参与匹配：复用旧目标会让一次错配被永久固化。
  ctx.state.targets[uuid] = subjectId;
  ctx.stateDirty = true;
}

/** 标记该条目的进度已拉满，允许之后被增量跳过。 */
function markProgressDone(ctx: SyncContext, uuid: string): void {
  if (ctx.config.sync.dryRun) {
    return;
  }
  ctx.state.progress[uuid] = 'done';
  ctx.stateDirty = true;
}

/**
 * 清掉某条目的增量记录，让下一轮重新处理。
 *
 * 指纹只覆盖收藏字段（状态/评分/短评/隐私），不含分集；若留着旧指纹，
 * 下一轮会把这条当成「已同步」直接跳过，失败的分集永远补不上。
 * `progress` 同样要清，否则「已 done」的旧标记会让失败的进度被跳过。
 */
function forgetState(ctx: SyncContext, uuid: string): void {
  if (ctx.config.sync.dryRun) {
    return;
  }
  let dirty = false;
  if (uuid in ctx.state.marks) {
    delete ctx.state.marks[uuid];
    dirty = true;
  }
  if (uuid in ctx.state.progress) {
    delete ctx.state.progress[uuid];
    dirty = true;
  }
  if (dirty) {
    ctx.stateDirty = true;
  }
}

/** 审计条目工厂：失败路径（异常隔离）也要能产出同样形状的记录。 */
function createAuditEntry(mark: NeodbShelfMark): MatchAuditEntry {
  const item = mark.item;
  return {
    uuid: item.uuid,
    label: displayName(item),
    category: String(item.category),
    shelf: String(mark.shelf_type),
    via: null,
    subjectId: null,
    subjectName: null,
    sourceYear: null,
    sourceMediaForm: null,
    candidateYear: null,
    candidateMediaForm: null,
    candidates: null,
    strictHold: false,
    outcome: 'skipped',
    reason: null,
    error: null,
  };
}

/** 审计里的错误文本只留首行与有限长度，避免把整包响应塞进产物。 */
function truncateError(message: string): string {
  const firstLine = message.split('\n')[0] ?? '';
  return firstLine.length > 200 ? `${firstLine.slice(0, 200)}…` : firstLine;
}

/** 分集执行结果 → 三路信号之一。 */
function toProgressSignal(result: EpisodeProgressResult): ProgressSignal {
  switch (result.kind) {
    case 'written':
      return {
        kind: 'written',
        added: result.added,
        ...(result.partial ? { partial: true } : {}),
        ...(result.remaining != null ? { remaining: result.remaining } : {}),
      };
    case 'unchanged':
      return { kind: 'unchanged' };
    case 'not-applicable':
      return { kind: 'not-applicable' };
    case 'failed':
      return { kind: 'failed', reason: result.reason, message: result.message };
  }
}

/**
 * 记录一条「本轮检查过、但没导入成功」的条目。
 *
 * 只写本轮观察集；是否进名单、是否算缺席、是否移出，全部交给结尾的
 * `mergeRounds` 一次判定 —— 遍历过程中就地改名单会把「没检查」和
 * 「检查了没出现」混成同一种事实。
 */
function observeUnmatched(
  ctx: SyncContext,
  mark: NeodbShelfMark,
  kind: UnmatchedKind,
  reason: string,
  label: string,
  subjectId?: number,
): void {
  ctx.observed.set(
    mark.item.uuid,
    createUnmatchedEntry({
      kind,
      reason,
      title: label,
      itemUrl: absoluteNeodbUrl(mark.item.url, ctx.config.neodb.baseUrl),
      category: String(mark.item.category),
      shelf: String(mark.shelf_type),
      neodbUuid: mark.item.uuid,
      ...(subjectId != null ? { subjectId } : {}),
      now: new Date().toISOString(),
    }),
  );
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
 * - 多候选不再取第一个，证据不足时记 ambiguous 而不是猜；
 * - strict 下唯一候选证据不足同样持留（insufficient-evidence）；
 * - 匹配证据随结果返回，供匹配审计留痕。
 */
async function resolveMatch(item: NeodbItem, ctx: SyncContext): Promise<MatchResult> {
  // 第一级：NeoDB 条目自带 Bangumi 外链时直接使用，最可靠。
  const linked = extractBangumiSubjectId(item.external_resources);
  if (linked != null) {
    return {
      kind: 'matched',
      subjectId: linked,
      via: 'link',
      subjectName: null,
      evidence: null,
    };
  }

  const types = neodbCategoryToBangumiSubjectTypes(item.category);
  if (!types.length) {
    return { kind: 'unresolved', reason: 'no-bangumi-match', evidence: null };
  }

  const mediaForm = neodbCategoryToMediaForm(item.category);
  let sawExact = false;
  let lastExactIds: number[] | null = null;
  // 年份是**裁决输入**，不是匹配的前置条件：只有出现精确同名候选时才需要它。
  // 搜不到候选时年份对结论毫无影响，提前读取等于白付一次 NeoDB 详情请求，
  // 而这类条目恰恰每轮都会重来。
  let sourceYear: number | null = null;
  let yearResolved = false;

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
    lastExactIds = exact.map((s) => s.id);

    if (!yearResolved) {
      const yearRes = await resolveItemYear(item, ctx);
      if (yearRes.kind === 'failed') {
        consola.warn(
          `NeoDB 条目年份读取失败，本轮不做无年份匹配: ${displayName(item)}`,
        );
        return { kind: 'failed', reason: 'bangumi-year-fetch-failed', auth: false };
      }
      sourceYear = yearRes.year;
      yearResolved = true;
    }

    const picked = await pickExactMatch(
      exact,
      sourceYear,
      ctx.config.sync.yearTolerance,
      {
        mediaForm,
        strict: ctx.config.sync.matchStrict,
        bookTolerance: ctx.config.sync.bookYearTolerance,
        resolveEvidence: (subject) => resolveCandidateEvidence(subject, ctx),
      },
    );

    if (picked.status === 'matched') {
      // 挑选过程中已读过证据（有缓存），这里复取一次用于审计留痕。
      const evidence = await resolveCandidateEvidence(picked.subject, ctx);
      consola.info(
        `Bangumi 匹配: uuid=${item.uuid} via=title title="${title}" ` +
          `year=${sourceYear ?? 'missing'} media=${mediaForm ?? 'unknown'} ` +
          `candidates=${exact.length} chosen=${picked.subject.id}`,
      );
      return {
        kind: 'matched',
        subjectId: picked.subject.id,
        via: 'title',
        subjectName: picked.subject.name_cn || picked.subject.name,
        evidence: {
          sourceYear,
          sourceMediaForm: mediaForm,
          candidateYear: evidence.year,
          candidateMediaForm: evidence.mediaForm,
          candidateIds: lastExactIds,
          strictHold: false,
        },
      };
    }
    if (picked.status === 'ambiguous') {
      consola.warn(
        `同名候选无法唯一裁决: uuid=${item.uuid} title="${title}" ` +
          `year=${sourceYear ?? 'missing'} media=${mediaForm ?? 'unknown'} ` +
          `hold=${picked.hold ?? 'none'} ` +
          `candidates=${picked.candidates
            .map((c) => `${c.id}(${c.name_cn || c.name})`)
            .join(',')}`,
      );
      // 单候选歧义要取该候选证据留痕（有缓存，零额外请求）。
      const held =
        picked.candidates.length === 1
          ? await resolveCandidateEvidence(picked.candidates[0]!, ctx)
          : null;
      return {
        kind: 'unresolved',
        // 缺年份与证据不足是两种事实：前者是「没读到日期」，后者是「读到了但不足以定案」。
        reason:
          picked.hold === 'year-missing'
            ? 'ambiguous-year-missing'
            : 'ambiguous-bangumi-match',
        evidence: {
          sourceYear,
          sourceMediaForm: mediaForm,
          candidateYear: held?.year ?? null,
          candidateMediaForm: held?.mediaForm ?? null,
          candidateIds: picked.candidates.map((c) => c.id),
          strictHold: picked.hold === 'insufficient-evidence',
        },
      };
    }
  }

  return {
    kind: 'unresolved',
    reason: sawExact ? 'bangumi-all-rejected-by-year' : 'no-bangumi-match',
    evidence: sawExact
      ? {
          sourceYear,
          sourceMediaForm: mediaForm,
          candidateYear: null,
          candidateMediaForm: null,
          candidateIds: lastExactIds,
          strictHold: false,
        }
      : null,
  };
}

/**
 * 候选证据：年份与媒体形态。动画/真人/书籍/音乐/游戏都参与年份；
 * 媒体形态只对动画/真人平台可判定，其余类目自然为 null。
 */
async function resolveCandidateEvidence(
  subject: BangumiSubject,
  ctx: SyncContext,
): Promise<{ year: number | null; mediaForm: MediaForm | null }> {
  if (!isYearFilterType(subject.type)) {
    return { year: null, mediaForm: null };
  }
  // 搜索结果的体积只有 id/名称，年份与平台要回读完整条目；读不到就退回搜索结果里的年份。
  const full = await readSubjectCached(subject.id, ctx.subjectCache);
  const detail = full.status === 'found' ? full.value : null;
  return {
    year: bangumiSubjectYear(subject) ?? (detail ? bangumiSubjectYear(detail) : null),
    mediaForm: bangumiPlatformMediaForm(detail?.platform),
  };
}

/**
 * 带缓存的条目读取，**保留三态**。
 *
 * 调用方需要区分「读取失败」与「条目不存在」：失败会把错误信息带上去记 `failed`，
 * 而「不存在」是条目级问题。缓存只写成功结果，失败留给下一轮重试。
 *
 * `read` 可注入，便于离线断言「同一 subject 一轮只读一次」。
 */
export async function readSubjectCached(
  subjectId: number,
  cache: Map<number, BangumiSubject>,
  read: (id: number) => Promise<ReadResult<BangumiSubject>> = getBangumiSubject,
): Promise<ReadResult<BangumiSubject>> {
  const cached = cache.get(subjectId);
  if (cached) {
    return { status: 'found', value: cached };
  }
  const result = await read(subjectId);
  if (result.status === 'found') {
    cache.set(subjectId, result.value);
  }
  return result;
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

/** 分集进度失败原因：读取与写入分开，便于审计定位。 */
export type EpisodeProgressFailureReason =
  'episodes-read-failed' | 'episode-states-read-failed' | 'episode-write-failed';

export type EpisodeProgressResult =
  | {
      kind: 'written';
      added: number;
      failed: number;
      /** 受单条上限截断：本轮已写入部分，仍有待补。 */
      partial?: boolean;
      remaining?: number;
    }
  | { kind: 'unchanged' }
  | { kind: 'not-applicable'; reason: 'no-episodes' | 'not-collected' }
  | { kind: 'failed'; reason: EpisodeProgressFailureReason; message: string };

/** 分集写入选项：`maxEpisodes` 缺省或为 0 表示不限。 */
type EpisodeProgressOptions = {
  maxEpisodes?: number;
};

/** 可注入的读取/写入依赖，便于离线断言失败路径。 */
export type EpisodeProgressDeps = {
  getEpisodes: typeof getBangumiEpisodes;
  getStates: typeof getBangumiEpisodeStates;
  markWatched: typeof markBangumiEpisodeWatched;
};

const defaultEpisodeProgressDeps: EpisodeProgressDeps = {
  getEpisodes: getBangumiEpisodes,
  getStates: getBangumiEpisodeStates,
  markWatched: markBangumiEpisodeWatched,
};

/**
 * 把 complete 条目的分集推进到上限。
 * 以分集实际 type=2 为准：已看过的集不发请求，第二轮运行零请求（幂等）。
 * 电影只补第一个正片；无正片则仅收藏本身。OP/ED 需显式开启且电影永不处理。
 *
 * 返回值必须携带结果：收藏字段写入与分集写入是两件事。读取/写入失败不能
 * 静默吞掉（否则摘要显示成功、实际一集没点），也不能让条目被增量指纹锁死。
 * 认证类失败继续抛 {@link AuthAbortError}，由外层中止整轮。
 */
export async function fillEpisodeProgress(
  subjectId: number,
  isMovie: boolean,
  includeSp: boolean,
  includeOpEd: boolean,
  deps: Partial<EpisodeProgressDeps> = {},
  options: EpisodeProgressOptions = {},
): Promise<EpisodeProgressResult> {
  const { getEpisodes, getStates, markWatched } = {
    ...defaultEpisodeProgressDeps,
    ...deps,
  };

  const episodesRes = await getEpisodes(subjectId);
  if (episodesRes.status === 'error') {
    if (episodesRes.scope === 'auth') {
      throw new AuthAbortError(episodesRes.message);
    }
    return {
      kind: 'failed',
      reason: 'episodes-read-failed',
      message: episodesRes.message,
    };
  }
  if (episodesRes.status === 'absent') {
    return {
      kind: 'failed',
      reason: 'episodes-read-failed',
      message: `subject ${subjectId} 分集列表不可用`,
    };
  }

  const statesRes = await getStates(subjectId);
  if (statesRes.status === 'error') {
    if (statesRes.scope === 'auth') {
      throw new AuthAbortError(statesRes.message);
    }
    return {
      kind: 'failed',
      reason: 'episode-states-read-failed',
      message: statesRes.message,
    };
  }
  if (statesRes.status === 'absent') {
    return {
      kind: 'failed',
      reason: 'episode-states-read-failed',
      message: `subject ${subjectId} 分集状态不可用`,
    };
  }

  const plan = planEpisodeProgress(episodesRes.value, statesRes.value, {
    isMovie,
    includeSp,
    includeOpEd,
    collected: true,
  });
  if (plan.reason === 'not-collected') {
    return { kind: 'not-applicable', reason: 'not-collected' };
  }
  if (plan.reason === 'no-episodes') {
    consola.info(`分集进度：无正片，跳过 subject/${subjectId}`);
    return { kind: 'not-applicable', reason: 'no-episodes' };
  }
  if (plan.missing.length === 0) {
    consola.info(
      `分集进度：无缺失集 subject/${subjectId} target=${plan.target.length}`,
    );
    return { kind: 'unchanged' };
  }

  // 单条上限：长番不必在一轮里吃完预算，剩下的留给下一轮（进度仍记 pending）。
  const cap = Math.max(0, Math.floor(options.maxEpisodes ?? 0));
  const targets = cap > 0 ? plan.missing.slice(0, cap) : plan.missing;

  let added = 0;
  let failed = 0;
  for (const episodeId of targets) {
    if (await markWatched(subjectId, episodeId)) {
      added += 1;
    } else {
      // 首次失败即停止本条剩余集：继续打只会白付 `(n−k)·650ms`，
      // 且失败集下一轮天然重试（已成功的集不回滚）。
      failed += 1;
      break;
    }
  }
  const attempted = added + failed;
  const remaining = plan.missing.length - added;
  consola.info(
    `分集进度: subject/${subjectId} kind=${isMovie ? 'movie' : 'tv'} ` +
      `target=${plan.target.length} missing=${plan.missing.length} ` +
      `attempted=${attempted} added=${added} failed=${failed} remaining=${remaining}`,
  );

  if (failed > 0) {
    return {
      kind: 'failed',
      reason: 'episode-write-failed',
      message:
        `${failed}/${plan.missing.length} 集写入失败` +
        `（首次失败即停止，剩余 ${plan.missing.length - attempted} 集未尝试）`,
    };
  }
  if (remaining > 0) {
    return { kind: 'written', added, failed: 0, partial: true, remaining };
  }
  return { kind: 'written', added, failed };
}

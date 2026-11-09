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
import { decideWriteOutcome, type ProgressSignal } from '../rules/write-decision';
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
  dryRunUnmatchedPath,
  loadUnmatched,
  pruneUnmatched,
  record,
  saveUnmatched,
  upsertUnmatched,
  type MatchAuditEntry,
  type PathReport,
  type UnmatchedMap,
} from '../sync-report';
import type { BangumiSubject, NeodbItem, NeodbShelfMark, ShelfType } from '../types';

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
  unmatched: UnmatchedMap;
  aborted: boolean;
  /** 匹配审计：按处理顺序累积，运行结束统一落盘（含 dry-run）。 */
  matchAudit: MatchAuditEntry[];
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
        'no-bangumi-match' | 'bangumi-all-rejected-by-year' | 'ambiguous-bangumi-match';
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
  unmatched: UnmatchedMap;
  truncatedShelves: ShelfType[];
  matchAudit: MatchAuditEntry[];
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
    return {
      aborted: 'neodb-auth',
      report,
      unmatched,
      truncatedShelves,
      matchAudit: [],
    };
  }
  if (!bangumiToken) {
    consola.error('BANGUMI_ACCESS_TOKEN 未设置，链路中止。');
    return {
      aborted: 'bangumi-auth',
      report,
      unmatched,
      truncatedShelves,
      matchAudit: [],
    };
  }
  const me = await getBangumiMe();
  if (!me) {
    consola.error('无法确认 Bangumi 账号身份，链路中止。');
    return {
      aborted: 'bangumi-auth',
      report,
      unmatched,
      truncatedShelves,
      matchAudit: [],
    };
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
    matchAudit: [],
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

          // 单条未预期异常不能葬送整轮：认证失败才中止，其余记 failed 后继续，
          // 保证审计 / 报告 / 摘要仍能落盘。
          let outcome: ItemOutcome = 'failed';
          try {
            outcome = await processMark(mark, ctx);
          } catch (error) {
            if (error instanceof AuthAbortError) {
              ctx.aborted = true;
              return false;
            }
            const detail = error instanceof Error ? error.message : String(error);
            ctx.matchAudit.push({
              ...createAuditEntry(mark),
              outcome: 'failed',
              reason: 'item-threw',
              error: truncateError(detail),
            });
            consola.error(
              `条目处理异常，继续下一条: ${mark.item.display_title || mark.item.title || mark.item.uuid} —`,
              detail,
            );
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
  } else {
    // dry-run 同样产出待核对名单：写派生文件，不老化、不污染正式文件。
    const dryRunPath = dryRunUnmatchedPath(config.sync.unmatchedLog);
    saveUnmatched(dryRunPath, unmatched);
    consola.info(`dry-run 待核对名单（本轮视角）已写入: ${dryRunPath}`);
  }
  return {
    aborted: ctx.aborted ? 'bangumi-auth' : false,
    report,
    unmatched,
    truncatedShelves,
    matchAudit: ctx.matchAudit,
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
  const match = await resolveMatch(item, ctx);
  if (match.kind === 'failed') {
    if (match.auth) {
      throw new AuthAbortError(match.reason);
    }
    consola.warn(
      `匹配失败，记 failed（下轮可重试）: uuid=${item.uuid} ${match.reason} ${label}`,
    );
    return finish('failed', match.reason);
  }
  if (match.kind === 'unresolved') {
    recordUnmatched(ctx, mark, match.reason, label);
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
    return finish('skipped', 'duplicate-target');
  }

  // ── 读取目标收藏：error 绝不当作 absent ──
  const existingRes = await getBangumiCollection(ctx.username, subjectId);
  if (existingRes.status === 'error') {
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
      return finish(
        'failed',
        'subject-read-failed',
        subjectRes.status === 'error' ? subjectRes.message : 'subject 不存在',
      );
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
    const ok = await upsertBangumiCollection(subjectId, {
      type: status.type,
      rate,
      comment,
      private: privatePlan.private,
      ...(epStatus != null ? { ep_status: epStatus } : {}),
      ...(volStatus != null ? { vol_status: volStatus } : {}),
    });
    if (!ok) {
      return finish('failed', 'collection-write-failed');
    }
    consola.info(
      `写入 Bangumi: subject/${subjectId} reasons=${reasons.join('+')} ` +
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
      await fillEpisodeProgress(
        subjectId,
        item.category === 'movie',
        config.sync.includeSp,
        config.sync.includeOpEd,
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
    return finish('failed', decision.reason, message);
  }

  rememberState(ctx, item.uuid, fingerprint);
  return finish(
    decision.outcome,
    decision.outcome === 'written'
      ? (decision.reason ?? (reasons.join('+') || 'progress'))
      : null,
  );
}

function rememberState(ctx: SyncContext, uuid: string, fingerprint: string): void {
  if (ctx.config.sync.dryRun) {
    return;
  }
  ctx.state[uuid] = fingerprint;
  ctx.stateDirty = true;
}

/**
 * 清掉某条目的增量指纹，让下一轮重新处理。
 *
 * 只在分集失败时使用：指纹只覆盖收藏字段（状态/评分/短评/隐私），不含分集；
 * 若留着旧指纹，下一轮会把这条当成「已同步」直接跳过，失败的分集永远补不上。
 */
function forgetState(ctx: SyncContext, uuid: string): void {
  if (ctx.config.sync.dryRun) {
    return;
  }
  if (!(uuid in ctx.state)) {
    return;
  }
  delete ctx.state[uuid];
  ctx.stateDirty = true;
}

/** 审计条目工厂：失败路径（异常隔离）也要能产出同样形状的记录。 */
function createAuditEntry(mark: NeodbShelfMark): MatchAuditEntry {
  const item = mark.item;
  return {
    uuid: item.uuid,
    label: item.display_title || item.title || item.uuid,
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
      return { kind: 'written', added: result.added };
    case 'unchanged':
      return { kind: 'unchanged' };
    case 'not-applicable':
      return { kind: 'not-applicable' };
    case 'failed':
      return { kind: 'failed', reason: result.reason, message: result.message };
  }
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

  const yearRes = await resolveItemYear(item, ctx);
  if (yearRes.kind === 'failed') {
    consola.warn(
      `NeoDB 条目年份读取失败，本轮不做无年份匹配: ${item.display_title || item.title}`,
    );
    return { kind: 'failed', reason: 'bangumi-year-fetch-failed', auth: false };
  }

  const mediaForm = neodbCategoryToMediaForm(item.category);
  let sawExact = false;
  let lastExactIds: number[] | null = null;

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

    const picked = await pickExactMatch(
      exact,
      yearRes.year,
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
          `year=${yearRes.year ?? 'missing'} media=${mediaForm ?? 'unknown'} ` +
          `candidates=${exact.length} chosen=${picked.subject.id}`,
      );
      return {
        kind: 'matched',
        subjectId: picked.subject.id,
        via: 'title',
        subjectName: picked.subject.name_cn || picked.subject.name,
        evidence: {
          sourceYear: yearRes.year,
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
          `year=${yearRes.year ?? 'missing'} media=${mediaForm ?? 'unknown'} ` +
          `candidates=${picked.candidates
            .map((c) => `${c.id}(${c.name_cn || c.name})`)
            .join(',')}`,
      );
      // 单候选歧义 = strict 证据持留；取该候选证据留痕（有缓存，零额外请求）。
      const held =
        picked.candidates.length === 1
          ? await resolveCandidateEvidence(picked.candidates[0]!, ctx)
          : null;
      return {
        kind: 'unresolved',
        reason: 'ambiguous-bangumi-match',
        evidence: {
          sourceYear: yearRes.year,
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
          sourceYear: yearRes.year,
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

/** 分集进度失败原因：读取与写入分开，便于审计定位。 */
export type EpisodeProgressFailureReason =
  'episodes-read-failed' | 'episode-states-read-failed' | 'episode-write-failed';

export type EpisodeProgressResult =
  | { kind: 'written'; added: number; failed: number }
  | { kind: 'unchanged' }
  | { kind: 'not-applicable'; reason: 'no-episodes' | 'not-collected' }
  | { kind: 'failed'; reason: EpisodeProgressFailureReason; message: string };

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

  let added = 0;
  let failed = 0;
  for (const episodeId of plan.missing) {
    if (await markWatched(subjectId, episodeId)) {
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

  if (failed > 0) {
    // 已成功的集不回滚：下一轮 planEpisodeProgress 的 missing 只剩失败集，天然重试。
    return {
      kind: 'failed',
      reason: 'episode-write-failed',
      message: `${failed}/${plan.missing.length} 集写入失败`,
    };
  }
  return { kind: 'written', added, failed };
}

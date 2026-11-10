/**
 * 运行汇总行 —— 把「扫描」与「配额消耗」两个口径分开呈现。
 *
 * 背景：`report.scanned` 包含**增量指纹跳过**与其它整条跳过，而 `SYNC_MAX_ITEMS`
 * 限制的是真正进入 `processMark` 的条数，且**按书架独立计算**。两者同名不同义，
 * 直接打印 `scanned` 会让「每书架上限 50 却显示 162」看起来像配额失效。
 *
 * 这里只负责措辞，不参与任何判定。纯函数、无 IO。
 */

export type ScanSummaryInput = {
  /** 本轮遍历到的标记总数（含增量跳过与整条跳过）。 */
  scanned: number;
  /** 真正进入处理流程的条数（所有书架之和）。 */
  quotaUsed: number;
  /** 因增量指纹命中而整条跳过的条数：不消耗配额、也不产生条目日志。 */
  incrementalSkipped: number;
  /** 触发过 `SYNC_MAX_ITEMS` 的书架；用于说明「每书架独立」的实际含义。 */
  cappedShelves: readonly string[];
  written: number;
  unchanged: number;
  skipped: number;
  unresolved: number;
  failed: number;
  /** 全量运行不受 `SYNC_MAX_ITEMS` 限制，措辞需避免「配额」歧义。 */
  fullSync: boolean;
};

/** 计数部分：`写入 0｜无变化 34｜…`，与既有格式保持一致。 */
function formatCounts(input: ScanSummaryInput): string {
  return (
    `写入 ${input.written}｜无变化 ${input.unchanged}｜跳过 ${input.skipped}｜` +
    `未匹配 ${input.unresolved}｜失败 ${input.failed}`
  );
}

/**
 * 汇总行。全量运行不写「配额消耗」，因为该轮压根不受配额约束；
 * 增量跳过为 0 时省略该子句，避免给每一行都加无用括号。
 *
 * 配额口径是**每书架**独立，因此写明「各书架配额」而不是暗示整轮共享。
 */
export function formatScanSummary(input: ScanSummaryInput): string {
  const counts = formatCounts(input);
  if (input.fullSync) {
    return `扫描 ${input.scanned}（全量运行，无配额限制）：${counts}`;
  }
  const parts = [`各书架配额消耗合计 ${input.quotaUsed}`];
  if (input.cappedShelves.length > 0) {
    parts.push(`触顶书架 ${input.cappedShelves.join('/')}`);
  }
  if (input.incrementalSkipped > 0) {
    parts.push(`增量跳过 ${input.incrementalSkipped}`);
  }
  return `扫描 ${input.scanned}（${parts.join('，')}）：${counts}`;
}

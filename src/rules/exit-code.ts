/**
 * 退出码分级 —— 把「运行故障」与「条目数据问题」分开。
 *
 * 历史行为是 `failed > 0 ? 1 : 0`：一条写不进去的条目就能让每晚的定时任务
 * 固定变红，红灯于是失去区分度（真故障混在数据缺口里看不出来）。这里按
 * 严重程度排序，先判运行级、再判条目级：
 *
 * - `2` 认证中止：凭据失效，后续所有写入都会失败，必须人工介入；
 * - `1` 运行级故障：报告恒等式被破坏，说明计数逻辑有 bug，不能发布假报告；
 * - `1` 条目级失败且显式开启严格模式（`SYNC_FAIL_ON_ITEM_ERRORS=1`）；
 * - `0` 其余：条目级失败仍然计数、仍然进摘要与注解，但不再阻断流水线。
 */
export type ExitCodeInput = {
  /** 凭据探测或中途认证失效导致整轮中止。 */
  aborted: boolean;
  /** `scanned = written + unchanged + skipped + unresolved + failed` 是否成立。 */
  invariantOk: boolean;
  /** 本轮 failed 条目数。 */
  failed: number;
  /** 严格模式：有条目失败即判红。 */
  failOnItemErrors: boolean;
};

export function decideExitCode(input: ExitCodeInput): 0 | 1 | 2 {
  if (input.aborted) return 2;
  if (!input.invariantOk) return 1;
  if (input.failed > 0 && input.failOnItemErrors) return 1;
  return 0;
}

/**
 * CLI 入口：加载配置 → 打印生效配置 → 执行迁移 → 写报告 → 决定退出码。
 *
 * 退出码（见 `rules/exit-code.ts`）：0 成功；1 报告恒等式破坏或（严格模式下）
 * 有 failed 条目；2 凭据/认证中止。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { consola } from 'consola';
import { decideExitCode } from './rules/exit-code';
import { describeSyncConfig, loadSyncConfig } from './sync-config';
import runNeodbToBangumi from './paths/neodb-to-bangumi';
import {
  assertReportInvariant,
  buildMatchAuditDocument,
  renderFailureAnnotations,
  renderSummaryMarkdown,
  saveMatchAudit,
} from './sync-report';

async function main(): Promise<void> {
  const config = loadSyncConfig();
  consola.info(describeSyncConfig(config));

  const startedAt = new Date().toISOString();
  const result = await runNeodbToBangumi(config);
  const finishedAt = new Date().toISOString();

  if (result.aborted) {
    consola.error(`链路中止（${result.aborted}），未继续写入。`);
    process.exitCode = decideExitCode({
      aborted: true,
      invariantOk: true,
      failed: result.report.failed,
      failOnItemErrors: config.sync.failOnItemErrors,
    });
    return;
  }

  // 匹配审计先于恒等式校验落盘：计数出错的轮次恰恰最需要审计留痕。
  // dry-run 同样产出——审计的价值正在于「写之前看清楚」。
  saveMatchAudit(
    config.sync.matchAuditFile,
    buildMatchAuditDocument(
      {
        startedAt,
        finishedAt,
        dryRun: config.sync.dryRun,
        fullSync: config.sync.fullSync,
        matchStrict: config.sync.matchStrict,
        yearTolerance: config.sync.yearTolerance,
      },
      result.matchAudit,
    ),
  );
  consola.info(
    `匹配审计已写入: ${config.sync.matchAuditFile}（${result.matchAudit.length} 条）`,
  );

  const invariantOk = assertReportInvariant(result.report);
  if (!invariantOk) {
    consola.error(
      '报告计数不满足 scanned = written + unchanged + skipped + unresolved + failed',
    );
    process.exitCode = decideExitCode({
      aborted: false,
      invariantOk,
      failed: result.report.failed,
      failOnItemErrors: config.sync.failOnItemErrors,
    });
    return;
  }

  const { report, truncatedShelves } = result;
  consola.info(
    `扫描 ${report.scanned}：写入 ${report.written}｜无变化 ${report.unchanged}｜` +
      `跳过 ${report.skipped}｜未匹配 ${report.unresolved}｜失败 ${report.failed}`,
  );
  if (result.stopReason === 'time-budget') {
    consola.warn('时间预算用尽，本轮提前收尾；已处理条目的状态已落盘。');
  } else if (result.stopReason === 'max-items') {
    consola.info('条目配额用尽，本轮正常收尾；下一轮从新增条目继续。');
  }
  if (truncatedShelves.length) {
    consola.warn(`以下书架未遍历完整: ${truncatedShelves.join(', ')}`);
  }

  // 需要人看的条目：真失败，加上「目标不可收藏」这类重试也不会自愈的缺口。
  const problemEntries = result.matchAudit.filter(
    (entry) => entry.outcome === 'failed' || entry.reason === 'collection-not-found',
  );

  const summary = renderSummaryMarkdown(report, {
    startedAt,
    finishedAt,
    dryRun: config.sync.dryRun,
    fullSync: config.sync.fullSync,
    shelves: config.sync.shelfTypes,
    truncatedShelves,
    unmatchedCount: result.unmatched.size,
    unmatchedEntries: [...result.unmatched.values()],
    unmatchedStats: result.unmatchedStats,
    unmatchedAdded: result.unmatchedAdded,
    neodbBaseUrl: config.neodb.baseUrl,
    runNow: new Date(finishedAt),
    metrics: result.metrics,
    stopReason: result.stopReason,
    stateReset: result.stateReset,
  });

  mkdirSync(dirname(config.sync.reportFile), { recursive: true });
  writeFileSync(
    config.sync.reportFile,
    JSON.stringify(
      {
        startedAt,
        finishedAt,
        report,
        stopReason: result.stopReason,
        metrics: result.metrics,
      },
      null,
      2,
    ),
    'utf8',
  );
  writeFileSync(config.sync.summaryFile, summary, 'utf8');
  consola.info(`报告已写入: ${config.sync.reportFile} / ${config.sync.summaryFile}`);

  // Actions 注解：把「哪一条、哪个 subject、为什么」直接摆在运行页面上。
  for (const line of renderFailureAnnotations(problemEntries)) {
    consola.log(line);
  }

  const exitCode = decideExitCode({
    aborted: false,
    invariantOk,
    failed: report.failed,
    failOnItemErrors: config.sync.failOnItemErrors,
  });
  if (report.failed > 0 && !config.sync.failOnItemErrors) {
    consola.warn(
      `本轮 ${report.failed} 条失败：已记入报告与摘要，但按 ` +
        'SYNC_FAIL_ON_ITEM_ERRORS=0 不判红；需要「有失败即红」时把它设为 1。',
    );
  }
  process.exitCode = exitCode;
}

main().catch((error) => {
  consola.error('运行异常: ', error);
  process.exitCode = 1;
});

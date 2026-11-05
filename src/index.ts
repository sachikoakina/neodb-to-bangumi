/**
 * CLI 入口：加载配置 → 打印生效配置 → 执行迁移 → 写报告 → 决定退出码。
 *
 * 退出码：0 成功；1 有 failed 条目或报告恒等式破坏；2 凭据/认证中止。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { consola } from 'consola';
import { describeSyncConfig, loadSyncConfig } from './sync-config';
import runNeodbToBangumi from './paths/neodb-to-bangumi';
import { assertReportInvariant, renderSummaryMarkdown } from './sync-report';

async function main(): Promise<void> {
  const config = loadSyncConfig();
  consola.info(describeSyncConfig(config));

  const startedAt = new Date().toISOString();
  const result = await runNeodbToBangumi(config);
  const finishedAt = new Date().toISOString();

  if (result.aborted) {
    consola.error(`链路中止（${result.aborted}），未继续写入。`);
    process.exitCode = 2;
    return;
  }

  if (!assertReportInvariant(result.report)) {
    consola.error(
      '报告计数不满足 scanned = written + unchanged + skipped + unresolved + failed',
    );
    process.exitCode = 1;
    return;
  }

  const { report, truncatedShelves } = result;
  consola.info(
    `扫描 ${report.scanned}：写入 ${report.written}｜无变化 ${report.unchanged}｜` +
      `跳过 ${report.skipped}｜未匹配 ${report.unresolved}｜失败 ${report.failed}`,
  );
  if (truncatedShelves.length) {
    consola.warn(`以下书架未遍历完整: ${truncatedShelves.join(', ')}`);
  }

  const summary = renderSummaryMarkdown(report, {
    startedAt,
    finishedAt,
    dryRun: config.sync.dryRun,
    fullSync: config.sync.fullSync,
    shelves: config.sync.shelfTypes,
    truncatedShelves,
    unmatchedCount: result.unmatched.size,
  });

  mkdirSync(dirname(config.sync.reportFile), { recursive: true });
  writeFileSync(
    config.sync.reportFile,
    JSON.stringify({ startedAt, finishedAt, report }, null, 2),
    'utf8',
  );
  writeFileSync(config.sync.summaryFile, summary, 'utf8');
  consola.info(`报告已写入: ${config.sync.reportFile} / ${config.sync.summaryFile}`);

  process.exitCode = report.failed > 0 ? 1 : 0;
}

main().catch((error) => {
  consola.error('运行异常: ', error);
  process.exitCode = 1;
});

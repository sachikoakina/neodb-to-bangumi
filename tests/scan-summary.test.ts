import { describe, expect, it } from 'vitest';
import { formatScanSummary, type ScanSummaryInput } from '../src/rules/scan-summary';

/** 本次线上运行的真实数字（logs_115943211975）：每书架上限 50。 */
function realRun(partial: Partial<ScanSummaryInput> = {}): ScanSummaryInput {
  return {
    scanned: 162,
    quotaUsed: 50,
    incrementalSkipped: 112,
    cappedShelves: ['complete'],
    written: 0,
    unchanged: 34,
    skipped: 115,
    unresolved: 13,
    failed: 0,
    fullSync: false,
    ...partial,
  };
}

describe('汇总行措辞', () => {
  it('常规运行同时给出扫描数、配额消耗合计与触顶书架', () => {
    expect(formatScanSummary(realRun())).toBe(
      '扫描 162（各书架配额消耗合计 50，触顶书架 complete，增量跳过 112）：' +
        '写入 0｜无变化 34｜跳过 115｜未匹配 13｜失败 0',
    );
  });

  it('配额是每书架独立的，因此措辞写「各书架配额消耗合计」而非整轮共享', () => {
    const line = formatScanSummary(realRun());
    expect(line).toContain('各书架配额消耗合计');
    expect(line).not.toContain('配额消耗 50，');
  });

  it('计数部分仍满足 scanned = 五项之和', () => {
    const input = realRun();
    expect(
      input.written + input.unchanged + input.skipped + input.unresolved + input.failed,
    ).toBe(input.scanned);
  });

  it('没有书架触顶时省略触顶子句', () => {
    const line = formatScanSummary(
      realRun({
        scanned: 20,
        quotaUsed: 20,
        incrementalSkipped: 0,
        cappedShelves: [],
        unchanged: 20,
        skipped: 0,
        unresolved: 0,
      }),
    );
    expect(line).toBe(
      '扫描 20（各书架配额消耗合计 20）：写入 0｜无变化 20｜跳过 0｜未匹配 0｜失败 0',
    );
    expect(line).not.toContain('触顶书架');
  });

  it('多个书架触顶时逐一列出', () => {
    const line = formatScanSummary(
      realRun({ cappedShelves: ['wishlist', 'complete'], incrementalSkipped: 0 }),
    );
    expect(line).toContain('触顶书架 wishlist/complete');
  });

  it('增量跳过为 0 时省略该子句', () => {
    const line = formatScanSummary(realRun({ incrementalSkipped: 0 }));
    expect(line).not.toContain('增量跳过');
    expect(line).toContain('触顶书架 complete');
  });

  it('全量运行不写「配额消耗」，避免与不受限的语义冲突', () => {
    const line = formatScanSummary(
      realRun({ fullSync: true, cappedShelves: [], incrementalSkipped: 0 }),
    );
    expect(line).toBe(
      '扫描 162（全量运行，无配额限制）：写入 0｜无变化 34｜跳过 115｜' +
        '未匹配 13｜失败 0',
    );
  });

  it('全量运行即使有增量跳过也不出现配额或触顶子句', () => {
    const line = formatScanSummary(
      realRun({ fullSync: true, cappedShelves: ['complete'] }),
    );
    expect(line).not.toContain('配额消耗');
    expect(line).not.toContain('触顶书架');
    expect(line).not.toContain('增量跳过');
    expect(line).toContain('全量运行，无配额限制');
  });

  it('零值边界仍然可读', () => {
    expect(
      formatScanSummary({
        scanned: 0,
        quotaUsed: 0,
        incrementalSkipped: 0,
        cappedShelves: [],
        written: 0,
        unchanged: 0,
        skipped: 0,
        unresolved: 0,
        failed: 0,
        fullSync: false,
      }),
    ).toBe(
      '扫描 0（各书架配额消耗合计 0）：写入 0｜无变化 0｜跳过 0｜未匹配 0｜失败 0',
    );
  });
});

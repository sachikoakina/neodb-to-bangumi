import { describe, expect, it } from 'vitest';
import { decideWriteOutcome, type ProgressSignal } from '../src/rules/write-decision';

const notApplicable: ProgressSignal = { kind: 'not-applicable' };
const unchangedProgress: ProgressSignal = { kind: 'unchanged' };
const writtenProgress: ProgressSignal = { kind: 'written', added: 3 };
const failedProgress: ProgressSignal = {
  kind: 'failed',
  reason: 'episode-read-failed',
  message: 'episodes 42 returned 500',
};

describe('写入判定', () => {
  it('字段与进度都没有变化 → unchanged', () => {
    expect(
      decideWriteOutcome({
        differs: false,
        bookProgress: false,
        progress: unchangedProgress,
      }),
    ).toEqual({ outcome: 'unchanged', reason: null, needsWrite: false });
  });

  it('收藏字段有差异 → 写入收藏，不因分集不适用而丢失', () => {
    expect(
      decideWriteOutcome({
        differs: true,
        bookProgress: false,
        progress: notApplicable,
      }),
    ).toEqual({ outcome: 'written', reason: null, needsWrite: true });
  });

  it('书籍进度有值 → 写入收藏（进度随同一请求提交）', () => {
    expect(
      decideWriteOutcome({
        differs: false,
        bookProgress: true,
        progress: notApplicable,
      }),
    ).toEqual({ outcome: 'written', reason: null, needsWrite: true });
  });

  it('只有分集进度产生写入 → written，且不触发收藏 upsert', () => {
    expect(
      decideWriteOutcome({
        differs: false,
        bookProgress: false,
        progress: writtenProgress,
      }),
    ).toEqual({ outcome: 'written', reason: 'progress', needsWrite: false });
  });

  it('字段差异与分集写入同时存在 → 原因留给字段，不重复标注 progress', () => {
    expect(
      decideWriteOutcome({
        differs: true,
        bookProgress: false,
        progress: writtenProgress,
      }),
    ).toEqual({ outcome: 'written', reason: null, needsWrite: true });
  });

  it('分集失败 → failed，但字段更新仍然提交', () => {
    expect(
      decideWriteOutcome({
        differs: true,
        bookProgress: false,
        progress: failedProgress,
      }),
    ).toEqual({ outcome: 'failed', reason: 'episode-read-failed', needsWrite: true });
  });

  it('分集失败且字段无差异 → failed，不发收藏 upsert', () => {
    expect(
      decideWriteOutcome({
        differs: false,
        bookProgress: false,
        progress: failedProgress,
      }),
    ).toEqual({ outcome: 'failed', reason: 'episode-read-failed', needsWrite: false });
  });

  it('分集未产生写入但有字段差异 → 仍按字段写入', () => {
    expect(
      decideWriteOutcome({
        differs: true,
        bookProgress: true,
        progress: unchangedProgress,
      }),
    ).toEqual({ outcome: 'written', reason: null, needsWrite: true });
  });
});

import { describe, expect, it } from 'vitest';
import {
  mergeRounds,
  MIN_ROUNDS,
  MISSES_BEFORE_REMOVAL,
} from '../src/rules/review-rounds';
import type { UnmatchedEntry, UnmatchedKind } from '../src/sync-report';

const NOW = '2026-11-09T16:06:16.000Z';

function entry(partial: Partial<UnmatchedEntry> = {}): UnmatchedEntry {
  return {
    source: 'neodb-bangumi',
    kind: 'unresolved',
    reason: 'no-bangumi-match',
    title: '海底两万里',
    itemUrl: 'https://neodb.social/book/1',
    category: 'book',
    shelf: 'progress',
    neodbUuid: 'uuid-1',
    firstSeenAt: '2026-11-01T00:00:00.000Z',
    lastSeenAt: '2026-11-01T00:00:00.000Z',
    seenRounds: 1,
    missedRounds: 0,
    ...partial,
  };
}

function observed(partial: Partial<UnmatchedEntry> = {}): UnmatchedEntry {
  return entry({ seenRounds: 1, missedRounds: 0, ...partial });
}

function merge(input: {
  previous?: UnmatchedEntry[];
  observed?: UnmatchedEntry[];
  covered?: string[];
  imported?: string[];
}) {
  return mergeRounds({
    previous: input.previous ?? [],
    observed: input.observed ?? [],
    coveredShelves: new Set(input.covered ?? []),
    importedUuids: new Set(input.imported ?? []),
    now: NOW,
  });
}

describe('观察窗', () => {
  it('unresolved / skipped 一轮即入名单，并计为新增', () => {
    const result = merge({ observed: [observed()] });
    expect(result.live).toHaveLength(1);
    expect(result.observing).toHaveLength(0);
    expect(result.added.map((item) => item.neodbUuid)).toEqual(['uuid-1']);
    expect(result.live[0]!.firstSeenAt).toBe(NOW);
  });

  it('failed 首轮只进观察中，第二轮才入名单并计为新增', () => {
    const first = merge({
      observed: [observed({ kind: 'failed', reason: 'collection-write-failed' })],
    });
    expect(first.live).toHaveLength(0);
    expect(first.observing).toHaveLength(1);
    expect(first.added).toHaveLength(0);

    const second = merge({
      previous: first.entries,
      observed: [observed({ kind: 'failed', reason: 'collection-write-failed' })],
    });
    expect(second.live).toHaveLength(1);
    expect(second.observing).toHaveLength(0);
    expect(second.added).toHaveLength(1);
    expect(second.live[0]!.seenRounds).toBe(MIN_ROUNDS.failed);
  });

  it('再次上报时 seenRounds 累加、missedRounds 归零、firstSeenAt 不变', () => {
    const result = merge({
      previous: [entry({ seenRounds: 3, missedRounds: 1 })],
      observed: [observed()],
      covered: ['progress'],
    });
    expect(result.live[0]).toMatchObject({
      seenRounds: 4,
      missedRounds: 0,
      firstSeenAt: '2026-11-01T00:00:00.000Z',
      lastSeenAt: NOW,
    });
  });
});

describe('缺席淘汰', () => {
  it('覆盖书架里未再上报：先记一次缺席，累计到上限才移除', () => {
    const first = merge({
      previous: [entry({ missedRounds: 0 })],
      covered: ['progress'],
    });
    expect(first.removed).toHaveLength(0);
    expect(first.entries[0]!.missedRounds).toBe(1);
    expect(first.frozen).toHaveLength(0);

    const second = merge({
      previous: first.entries,
      covered: ['progress'],
    });
    expect(second.removed).toHaveLength(1);
    expect(second.removed[0]!.cause).toBe('absent');
    expect(second.entries).toHaveLength(0);
    expect(MISSES_BEFORE_REMOVAL).toBe(2);
  });

  it('书架未被覆盖时冻结：不计缺席，且清零历史连击', () => {
    const result = merge({
      previous: [entry({ missedRounds: 1 })],
      covered: [],
    });
    expect(result.removed).toHaveLength(0);
    expect(result.entries[0]!.missedRounds).toBe(0);
    expect(result.frozen.map((item) => item.neodbUuid)).toEqual(['uuid-1']);
  });

  it('条目所在书架与覆盖书架不一致时同样冻结', () => {
    const result = merge({
      previous: [entry({ shelf: 'complete' })],
      covered: ['progress'],
    });
    expect(result.removed).toHaveLength(0);
    expect(result.frozen).toHaveLength(1);
  });
});

describe('导入即移除', () => {
  it('命中 imported 时不进名单，记为 imported 原因', () => {
    const result = merge({
      previous: [entry()],
      imported: ['uuid-1'],
      covered: ['progress'],
    });
    expect(result.entries).toHaveLength(0);
    expect(result.live).toHaveLength(0);
    expect(result.removed).toEqual([{ entry: entry(), cause: 'imported' }]);
  });

  it('导入优先于本轮上报（同一条目不会既上报又留下）', () => {
    const result = merge({
      previous: [entry()],
      observed: [observed()],
      imported: ['uuid-1'],
    });
    expect(result.entries).toHaveLength(0);
    expect(result.removed[0]!.cause).toBe('imported');
  });

  it('从未入过名单的新条目若被导入，不会凭空出现', () => {
    const result = merge({
      observed: [observed()],
      imported: ['uuid-1'],
    });
    expect(result.entries).toHaveLength(0);
  });
});

describe('计数口径', () => {
  it('观察中的条目不计入名单合计', () => {
    const result = merge({
      previous: [
        entry({ neodbUuid: 'a', seenRounds: 2 }),
        entry({ neodbUuid: 'b', kind: 'failed', reason: 'item-threw', seenRounds: 1 }),
      ],
    });
    expect(result.live.map((item) => item.neodbUuid)).toEqual(['a']);
    expect(result.observing.map((item) => item.neodbUuid)).toEqual(['b']);
  });

  it('kind 变化时按新 kind 的门槛重新判断，不计为新增', () => {
    const result = merge({
      previous: [
        entry({
          kind: 'failed' as UnmatchedKind,
          reason: 'item-threw',
          seenRounds: 3,
        }),
      ],
      observed: [observed({ kind: 'unresolved' })],
    });
    expect(result.live).toHaveLength(1);
    expect(result.added).toHaveLength(0);
  });
});

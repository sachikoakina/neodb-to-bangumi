import { describe, expect, it } from 'vitest';
import type { UnmatchedEntry, UnmatchedMap } from '../src/sync-report';
import {
  daysSince,
  formatShanghai,
  groupUnmatched,
  renderUnmatchedSection,
  stateOf,
  summarizeUnmatchedRun,
  type UnmatchedRunStats,
} from '../src/unmatched-report';

const NOW = new Date('2026-11-09T16:06:16Z');

function entry(partial: Partial<UnmatchedEntry> = {}): UnmatchedEntry {
  return {
    source: 'neodb-bangumi',
    reason: 'no-bangumi-match',
    title: '海底两万里',
    itemUrl: 'https://neodb.social/book/1',
    category: 'book',
    shelf: 'progress',
    neodbUuid: 'uuid-1',
    firstSeenAt: '2026-11-04T16:06:16Z',
    lastSeenAt: '2026-11-09T16:06:16Z',
    ...partial,
  };
}

function stats(partial: Partial<UnmatchedRunStats> = {}): UnmatchedRunStats {
  return { total: 1, added: 0, removed: 0, observed: 1, notScanned: 0, ...partial };
}

function render(
  entries: UnmatchedEntry[],
  meta: Partial<Parameters<typeof renderUnmatchedSection>[1]> = {},
): string {
  return renderUnmatchedSection(entries, {
    startedAt: '2026-11-09T15:58:24Z',
    now: NOW,
    stats: stats({ total: entries.length }),
    ...meta,
  }).join('\n');
}

describe('状态推导', () => {
  it('显式 state 优先于原因推导', () => {
    expect(stateOf(entry({ state: 'failed', reason: 'no-bangumi-match' }))).toBe(
      'failed',
    );
    expect(stateOf(entry({ state: 'skipped' }))).toBe('skipped');
  });

  it('旧条目没有 state 时按 reason 归类', () => {
    expect(stateOf(entry({ reason: 'duplicate-target' }))).toBe('skipped');
    expect(stateOf(entry({ reason: 'unmatched-backoff' }))).toBe('skipped');
    expect(stateOf(entry({ reason: 'collection-not-found' }))).toBe('unresolved');
    expect(stateOf(entry({ reason: 'collection-write-failed' }))).toBe('unresolved');
  });
});

describe('分组', () => {
  it('按「状态 → 分类 → 书架」固定顺序分组并计数', () => {
    const groups = groupUnmatched([
      entry({ reason: 'no-bangumi-match', category: 'book', shelf: 'wishlist' }),
      entry({ reason: 'ambiguous-bangumi-match', category: 'book', shelf: 'wishlist' }),
      entry({
        reason: 'duplicate-target',
        category: 'tv',
        shelf: 'complete',
        state: 'skipped',
      }),
      entry({
        reason: 'collection-write-failed',
        category: 'movie',
        shelf: 'complete',
        state: 'failed',
      }),
    ]);
    expect(groups).toHaveLength(1);
    const [group] = groups;
    expect(group!.link).toBe('NeoDB → Bangumi');
    expect(group!.count).toBe(4);
    expect(group!.states.map((state) => state.state)).toEqual([
      'unresolved',
      'skipped',
      'failed',
    ]);
    expect(group!.states.map((state) => state.count)).toEqual([2, 1, 1]);
    const unresolved = group!.states[0]!;
    expect(unresolved.categories[0]!.label).toBe('书籍');
    expect(unresolved.categories[0]!.shelves[0]!.label).toBe('想看');
    expect(unresolved.categories[0]!.shelves[0]!.entries).toHaveLength(2);
  });

  it('分类缺失归「未分类」，书架缺失归「未标注」', () => {
    const groups = groupUnmatched([entry({ category: undefined, shelf: undefined })]);
    const category = groups[0]!.states[0]!.categories[0]!;
    expect(category.label).toBe('未分类');
    expect(category.shelves[0]!.label).toBe('未标注');
  });

  it('组内按标题排序，同一份名单渲染结果稳定', () => {
    const a = entry({ title: 'B', neodbUuid: '2' });
    const b = entry({ title: 'A', neodbUuid: '1' });
    const first = render([a, b]);
    const second = render([b, a]);
    expect(first).toBe(second);
    expect(first.indexOf('A — ')).toBeLessThan(first.indexOf('B — '));
  });

  it('空名单返回空数组', () => {
    expect(groupUnmatched([])).toEqual([]);
  });
});

describe('条目行与时间', () => {
  it('统一格式：序号. 标题 — 链接 · 原因 · 已存在 N 天', () => {
    const md = render([entry()]);
    expect(md).toContain(
      ' 1. 海底两万里 — https://neodb.social/book/1 · no-bangumi-match · 已存在 5 天',
    );
  });

  it('已知目标时把 subject 挂在原因后', () => {
    const md = render([
      entry({ reason: 'duplicate-target', state: 'skipped', subjectId: 16260 }),
    ]);
    expect(md).toContain('duplicate-target(subject/16260)');
  });

  it('没有链接时降级而不是渲染空字符串', () => {
    const md = render([entry({ itemUrl: '' })]);
    expect(md).toContain('（无链接）');
  });

  it('历史名单里的相对 URL 由渲染层补成绝对地址', () => {
    const md = render([entry({ itemUrl: '/movie/3IFQp20nMweuIdKwGoDdtN' })]);
    expect(md).toContain(
      ' 1. 海底两万里 — https://neodb.social/movie/3IFQp20nMweuIdKwGoDdtN · ' +
        'no-bangumi-match · 已存在 5 天',
    );
  });

  it('相对 URL 按 meta.neodbBaseUrl 拼到自建实例', () => {
    const md = render([entry({ itemUrl: '/movie/abc' })], {
      neodbBaseUrl: 'https://neodb.example.org',
    });
    expect(md).toContain('https://neodb.example.org/movie/abc');
  });

  it('neodbBaseUrl 为空时回退官方域名，不拼出 undefined/movie', () => {
    const md = render([entry({ itemUrl: '/movie/abc' })], {
      neodbBaseUrl: '',
    });
    expect(md).toContain('https://neodb.social/movie/abc');
    expect(md).not.toContain('undefined');
  });

  it('首次出现时间非法时降级为「已存在天数未知」', () => {
    expect(daysSince('not-a-date', NOW)).toBeNull();
    const md = render([entry({ firstSeenAt: '' })]);
    expect(md).toContain('已存在天数未知');
  });

  it('首次出现晚于当前时刻按 0 天处理（时钟漂移不出现负数）', () => {
    expect(daysSince('2026-11-10T00:00:00Z', NOW)).toBe(0);
  });

  it('上海时间为 UTC+8，跨日时日期进位', () => {
    expect(formatShanghai('2026-11-09T12:21:41Z')).toBe('2026-11-09的20:21:41');
    expect(formatShanghai('2026-11-09T16:30:00Z')).toBe('2026-11-10的00:30:00');
    expect(formatShanghai('bad')).toBe('未知');
  });
});

describe('汇总段', () => {
  it('开头给出名单总数、UTC 与上海时间、新增/移除/观察中', () => {
    const md = render([entry(), entry({ neodbUuid: 'uuid-2' })], {
      stats: stats({ total: 688, added: 1, removed: 2, observed: 685, notScanned: 0 }),
    });
    expect(md).toContain('## 待核对名单（688 条）');
    expect(md).toContain(
      '本轮运行（UTC）：2026-11-09T15:58:24Z（上海时间为2026-11-09的23:58:24）',
    );
    expect(md).toContain('新增 1 · 移除 2 · 观察中 685 · 名单合计 688');
  });

  it('有未扫描条目时说明原因，没有则省略该段', () => {
    const withGap = render([entry()], { stats: stats({ total: 1, notScanned: 597 }) });
    expect(withGap).toContain(
      '本轮有 597 条不在扫描集合里（配额截断、分页上限或链路未运行），已保留、不计缺席。',
    );
    const withoutGap = render([entry()]);
    expect(withoutGap).not.toContain('不在扫描集合里');
  });

  it('书架未遍历完整时说明无法归属，没有则省略', () => {
    const withTruncation = render([entry()], {
      truncatedShelves: ['complete', 'wishlist'],
    });
    expect(withTruncation).toContain('另有 2 个书架未遍历完整（complete、wishlist）');
    expect(withTruncation).toContain('无法归属到具体条目');
    expect(render([entry()])).not.toContain('无法归属到具体条目');
  });

  it('本轮新增小节逐条列出', () => {
    const added = entry({ reason: 'collection-not-found', subjectId: 411170 });
    const md = render([entry(), added], {
      stats: stats({ total: 2, added: 1, observed: 1 }),
      addedEntries: [added],
    });
    expect(md).toContain('本轮新增（1）');
    expect(md).toContain(
      'unresolved 海底两万里 — https://neodb.social/book/1 · collection-not-found(subject/411170)（NeoDB → Bangumi）',
    );
  });

  it('本轮新增里的相对 URL 同样补成绝对地址', () => {
    const added = entry({
      reason: 'no-bangumi-match',
      itemUrl: '/movie/3IFQp20nMweuIdKwGoDdtN',
    });
    const md = render([added], {
      stats: stats({ total: 1, added: 1, observed: 0 }),
      addedEntries: [added],
    });
    expect(md).toContain(
      'unresolved 海底两万里 — https://neodb.social/movie/3IFQp20nMweuIdKwGoDdtN · no-bangumi-match',
    );
  });

  it('空名单只输出占位，不渲染分组标题', () => {
    const md = render([]);
    expect(md).toContain('## 待核对名单（0 条）');
    expect(md).toContain('本轮无待核对条目。');
    expect(md).not.toContain('### NeoDB → Bangumi');
  });
});

describe('本轮统计', () => {
  // 生产环境里 unmatched 的键就是 NeoDB uuid，seenUuids 用的也是同一个值。
  function mapOf(...entries: UnmatchedEntry[]): UnmatchedMap {
    const map: UnmatchedMap = new Map();
    for (const item of entries) map.set(item.neodbUuid ?? item.title, item);
    return map;
  }

  it('新增 = 运行前不在名单里的键，观察中 = 其余', () => {
    const { stats: result, added } = summarizeUnmatchedRun({
      unmatched: mapOf(entry(), entry({ title: '新条目', neodbUuid: 'uuid-2' })),
      initialKeys: new Set(['uuid-1']),
      seenUuids: new Set(['uuid-1']),
      removedBySuccess: 0,
      prunedRemoved: 0,
    });
    expect(result).toEqual({
      total: 2,
      added: 1,
      removed: 0,
      observed: 1,
      notScanned: 1,
    });
    expect(added.map((item) => item.title)).toEqual(['新条目']);
  });

  it('移除 = 成功导入 + 老化清理', () => {
    const { stats: result } = summarizeUnmatchedRun({
      unmatched: mapOf(entry()),
      initialKeys: new Set(['uuid-1']),
      seenUuids: new Set(['uuid-1']),
      removedBySuccess: 3,
      prunedRemoved: 2,
    });
    expect(result.removed).toBe(5);
    expect(result.notScanned).toBe(0);
  });
});

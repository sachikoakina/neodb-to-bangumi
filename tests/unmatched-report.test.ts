import { describe, expect, it } from 'vitest';
import type { RemovedEntry, UnmatchedEntry } from '../src/sync-report';
import {
  daysSince,
  formatShanghai,
  groupUnmatched,
  REMOVAL_LABELS,
  renderUnmatchedSection,
  type RenderUnmatchedMeta,
} from '../src/unmatched-report';

const NOW = new Date('2026-11-09T16:06:16Z');

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
    firstSeenAt: '2026-11-04T16:06:16Z',
    lastSeenAt: '2026-11-09T16:06:16Z',
    seenRounds: 1,
    missedRounds: 0,
    ...partial,
  };
}

function render(
  entries: UnmatchedEntry[],
  meta: Partial<RenderUnmatchedMeta> = {},
): string {
  return renderUnmatchedSection(entries, {
    startedAt: '2026-11-09T15:58:24Z',
    now: NOW,
    ...meta,
  }).join('\n');
}

describe('分组', () => {
  it('按「结局 → 分类 → 书架」固定顺序分组并计数', () => {
    const groups = groupUnmatched([
      entry({ subjectId: 1 }),
      entry({ reason: 'ambiguous-bangumi-match', neodbUuid: 'uuid-2' }),
      entry({ kind: 'skipped', reason: 'duplicate-target', neodbUuid: 'uuid-3' }),
      entry({ kind: 'failed', reason: 'collection-write-failed', neodbUuid: 'uuid-4' }),
    ]);
    expect(groups).toHaveLength(1);
    const [group] = groups;
    expect(group!.link).toBe('NeoDB → Bangumi');
    expect(group!.count).toBe(4);
    expect(group!.kinds.map((item) => item.kind)).toEqual([
      'unresolved',
      'skipped',
      'failed',
    ]);
    expect(group!.kinds.map((item) => item.count)).toEqual([2, 1, 1]);
    const unresolved = group!.kinds[0]!;
    expect(unresolved.categories[0]!.key).toBe('book');
    expect(unresolved.categories[0]!.label).toBe('书籍');
    expect(unresolved.categories[0]!.shelves[0]!.label).toBe('在看');
    expect(unresolved.categories[0]!.shelves[0]!.entries).toHaveLength(2);
  });

  it('分类缺失归「未分类」，书架原样输出未知值', () => {
    const groups = groupUnmatched([entry({ category: undefined, shelf: '' })]);
    const category = groups[0]!.kinds[0]!.categories[0]!;
    expect(category.label).toBe('未分类');
    expect(category.shelves[0]!.label).toBe('未标注');
  });

  it('组内按标题排序，同一份名单渲染结果稳定', () => {
    const a = entry({ title: 'B', neodbUuid: '2' });
    const b = entry({ title: 'A', neodbUuid: '1' });
    expect(render([a, b])).toBe(render([b, a]));
    const once = render([a, b]);
    expect(once.indexOf('A — ')).toBeLessThan(once.indexOf('B — '));
  });

  it('空名单返回空数组', () => {
    expect(groupUnmatched([])).toEqual([]);
  });
});

describe('折叠（Job Summary 的 details）', () => {
  it('书籍与音乐默认折叠，电影保持展开', () => {
    const book = render([entry({ category: 'book' })]);
    expect(book).toContain('<details>');
    expect(book).toContain('<summary><b>书籍（1）</b></summary>');
    expect(book).toContain('</details>');
    // 折叠时不再重复输出粗体标题，避免 summary 与正文各显示一次
    expect(book).not.toContain('**书籍（1）**');

    const music = render([entry({ category: 'music' })]);
    expect(music).toContain('<summary><b>音乐（1）</b></summary>');

    const movie = render([entry({ category: 'movie' })]);
    expect(movie).toContain('**电影（1）**');
    expect(movie).not.toContain('<details>');
  });

  it('多个折叠分类各自闭合，标签成对', () => {
    const md = render([
      entry({ category: 'book' }),
      entry({ category: 'music', neodbUuid: 'uuid-2', shelf: 'complete' }),
    ]);
    expect(md.match(/<details>/g)).toHaveLength(2);
    expect(md.match(/<\/details>/g)).toHaveLength(2);
  });

  it('summary 后有且只有一个空行（否则内部 Markdown 不渲染）', () => {
    const lines = renderUnmatchedSection([entry({ category: 'book' })], {
      startedAt: '2026-11-09T15:58:24Z',
      now: NOW,
    });
    const summaryAt = lines.findIndex((line) => line.includes('<summary>'));
    expect(summaryAt).toBeGreaterThan(-1);
    expect(lines[summaryAt + 1]).toBe('');
    expect(lines[summaryAt + 2]).not.toBe('');
  });
});

describe('条目行与时间', () => {
  it('统一格式：序号. 标题 — 链接 · 原因 · 已存在 N 天', () => {
    expect(render([entry()])).toContain(
      ' 1. 海底两万里 — https://neodb.social/book/1 · no-bangumi-match · 已存在 5 天',
    );
  });

  it('已知目标时把 subject 挂在原因后', () => {
    const md = render([
      entry({ kind: 'skipped', reason: 'duplicate-target', subjectId: 16260 }),
    ]);
    expect(md).toContain('duplicate-target(subject/16260)');
  });

  it('没有链接时降级而不是渲染空串', () => {
    expect(render([entry({ itemUrl: '' })])).toContain('（无链接）');
  });

  it('相对链接按 neodbBaseUrl 补全', () => {
    const md = render([entry({ itemUrl: '/movie/3IFQp20nMweuIdKwGoDdtN' })], {
      neodbBaseUrl: 'https://neodb.example.org',
    });
    expect(md).toContain('https://neodb.example.org/movie/3IFQp20nMweuIdKwGoDdtN');
  });

  it('首次出现时间非法时降级为「已存在天数未知」', () => {
    expect(daysSince('not-a-date', NOW)).toBeNull();
    expect(render([entry({ firstSeenAt: '' })])).toContain('已存在天数未知');
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
  it('开头给出名单合计、UTC 与上海时间、四个数字', () => {
    const md = render([entry(), entry({ neodbUuid: 'uuid-2', title: 'B' })], {
      added: [entry()],
      observing: [entry({ kind: 'failed', neodbUuid: 'uuid-3' })],
    });
    expect(md).toContain('## 待核对名单（2 条）');
    expect(md).toContain(
      '本轮运行（UTC）：2026-11-09T15:58:24Z（上海时间为2026-11-09的23:58:24）',
    );
    expect(md).toContain('新增 1 · 移除 0 · 观察中 1 · 名单合计 2');
  });

  it('冻结条目说明数量，没有则省略', () => {
    expect(
      render([entry()], { frozen: [entry(), entry({ neodbUuid: 'u2' })] }),
    ).toContain(
      '本轮有 2 条不在扫描集合里（配额截断、分页上限或链路未运行），已保留、不计缺席。',
    );
    expect(render([entry()])).not.toContain('不在扫描集合里');
  });

  it('书架未遍历完整时说明无法归属，没有则省略', () => {
    const truncated = render([entry()], { truncatedShelves: ['complete', 'wishlist'] });
    expect(truncated).toContain('另有 2 个书架未遍历完整（complete、wishlist）');
    expect(truncated).toContain('无法归属到具体条目');
    expect(render([entry()])).not.toContain('无法归属到具体条目');
  });

  it('本轮新增逐条列出', () => {
    const added = entry({ reason: 'collection-not-found', subjectId: 411170 });
    const md = render([entry(), added], { added: [added] });
    expect(md).toContain('**本轮新增（1）**');
    expect(md).toContain(
      '海底两万里 — https://neodb.social/book/1 · collection-not-found(subject/411170)（NeoDB → Bangumi）',
    );
  });

  it('本轮移除：删除线 + 原因，标题按原因自适应', () => {
    const removed: RemovedEntry[] = [
      { entry: entry({ title: '锦衣卫' }), cause: 'imported' },
    ];
    const mixed = render([], { removed });
    expect(mixed).toContain('**本轮移除（1）**');
    expect(mixed).toContain('~~锦衣卫~~ — https://neodb.social/book/1 · ');
    expect(mixed).toContain('· 已导入');

    const absentOnly = render([], {
      removed: [{ entry: entry({ title: '最游记' }), cause: 'absent' }],
    });
    expect(absentOnly).toContain('**本轮移除（1，连续两轮被扫描到且未再出现）**');
    expect(absentOnly).toContain(REMOVAL_LABELS.absent);
  });

  it('观察中单独成块', () => {
    const md = render([], {
      observing: [entry({ kind: 'failed', reason: 'collection-write-failed' })],
    });
    expect(md).toContain('**观察中（1，下一轮仍出现才入名单）**');
    expect(md).toContain('## 待核对名单（0 条）');
  });

  it('空名单只输出占位，不渲染分组标题', () => {
    const md = render([]);
    expect(md).toContain('## 待核对名单（0 条）');
    expect(md).toContain('本轮无待核对条目。');
    expect(md).not.toContain('### NeoDB → Bangumi');
  });
});

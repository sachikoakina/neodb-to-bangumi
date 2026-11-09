/**
 * 待核对清单渲染 —— 把名单按「链路 → 状态 → 分类 → 书架」四级分组逐条列出。
 *
 * 与 `rules/*` 同样的理由：排版属于纯函数，可以离线断言。摘要长什么样不应该
 * 只有跑完一次真实同步才知道。
 */
import type { UnmatchedEntry } from './sync-report';

/** 名单条目的三种状态。`skipped` 只用于「真的没导入」的跳过（如被更强认领者挤掉）。 */
export type UnmatchedState = 'unresolved' | 'skipped' | 'failed';

/** 本轮与名单有关的计数。 */
export type UnmatchedRunStats = {
  /** 名单合计。 */
  total: number;
  /** 本轮首次进入名单。 */
  added: number;
  /** 本轮移出：成功导入 + 老化清理。 */
  removed: number;
  /** 本轮之前就在名单里、仍未解决。 */
  observed: number;
  /** 名单里本轮没进入扫描集合（配额截断 / 分页上限 / 链路未运行）。 */
  notScanned: number;
};

export type UnmatchedShelfGroup = { label: string; entries: UnmatchedEntry[] };
export type UnmatchedCategoryGroup = {
  label: string;
  count: number;
  shelves: UnmatchedShelfGroup[];
};
export type UnmatchedStateGroup = {
  state: UnmatchedState;
  count: number;
  categories: UnmatchedCategoryGroup[];
};
export type UnmatchedLinkGroup = {
  link: string;
  count: number;
  states: UnmatchedStateGroup[];
};

export type RenderUnmatchedMeta = {
  /** 本轮开始时刻（ISO，UTC）。 */
  startedAt: string;
  /** 「已存在 N 天」的参照时刻。 */
  now: Date;
  stats: UnmatchedRunStats;
  /** 本轮首次进入名单的条目，用于「本轮新增」小节。 */
  addedEntries?: readonly UnmatchedEntry[];
  /** 未遍历完整的书架；为空时不渲染「无法归属」段。 */
  truncatedShelves?: readonly string[];
  /** 链路名；当前只有一条，留作扩展。 */
  link?: string;
};

export const CATEGORY_LABELS: Readonly<Record<string, string>> = {
  book: '书籍',
  movie: '电影',
  tv: '电视剧',
  music: '音乐',
  game: '游戏',
  podcast: '播客',
  performance: '舞台剧',
};

export const SHELF_LABELS: Readonly<Record<string, string>> = {
  wishlist: '想看',
  progress: '在看',
  complete: '看过',
  dropped: '搁置',
};

const UNKNOWN_CATEGORY = '未分类';
const UNKNOWN_SHELF = '未标注';
const DEFAULT_LINK = 'NeoDB → Bangumi';
const DAY_MS = 86_400_000;
const SHANGHAI_OFFSET_MS = 8 * 3_600_000;

/** 固定顺序：同一份名单每次渲染结果一致，Job Summary 才可 diff。 */
const STATE_ORDER: readonly UnmatchedState[] = ['unresolved', 'skipped', 'failed'];
const CATEGORY_ORDER: readonly string[] = [
  'book',
  'movie',
  'tv',
  'music',
  'game',
  'podcast',
  'performance',
];
const SHELF_ORDER: readonly string[] = ['wishlist', 'progress', 'complete', 'dropped'];

/**
 * 历史条目没有 `state` 字段：这些原因本质是「被规则跳过」，不是待补的缺口，
 * 按 skipped 归类；其余一律 unresolved。新增 reason 默认落 unresolved。
 */
const SKIPPED_REASONS: ReadonlySet<string> = new Set([
  'duplicate-target',
  'unmatched-backoff',
  'hold-protected',
  'unknown-shelf-type',
  'category-not-allowed',
  'unsupported-category',
]);

export function stateOf(entry: UnmatchedEntry): UnmatchedState {
  return entry.state ?? (SKIPPED_REASONS.has(entry.reason) ? 'skipped' : 'unresolved');
}

export function categoryLabel(category: string | undefined): string {
  if (!category) return UNKNOWN_CATEGORY;
  return CATEGORY_LABELS[category] ?? category;
}

export function shelfLabel(shelf: string | undefined): string {
  if (!shelf) return UNKNOWN_SHELF;
  return SHELF_LABELS[shelf] ?? shelf;
}

/** 首次出现至今的天数；时间非法返回 null（由渲染层降级成「未知」）。 */
export function daysSince(firstSeenAt: string, now: Date): number | null {
  const seen = Date.parse(firstSeenAt);
  if (!Number.isFinite(seen)) return null;
  const diff = now.getTime() - seen;
  return diff < 0 ? 0 : Math.floor(diff / DAY_MS);
}

/**
 * UTC+8 的上海时间。手工加偏移而不是 `toLocaleString`：runner 是 UTC、
 * 本机可能是 UTC+8，`Intl` 的结果取决于运行时 tzdata 与 locale，不可靠。
 */
export function formatShanghai(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '未知';
  const shifted = new Date(at.getTime() + SHANGHAI_OFFSET_MS);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-` +
    `${pad(shifted.getUTCDate())}的${pad(shifted.getUTCHours())}:` +
    `${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`
  );
}

function orderOf(order: readonly string[], value: string): number {
  const index = order.indexOf(value);
  return index === -1 ? order.length : index;
}

function compareEntries(a: UnmatchedEntry, b: UnmatchedEntry): number {
  const byTitle = a.title.localeCompare(b.title, 'zh');
  return byTitle !== 0 ? byTitle : (a.neodbUuid ?? '').localeCompare(b.neodbUuid ?? '');
}

/**
 * 四级分组。返回数组而不是单对象：当前只有一条链路，将来接第二条时
 * 渲染层不需要改。
 */
export function groupUnmatched(
  entries: readonly UnmatchedEntry[],
  link: string = DEFAULT_LINK,
): UnmatchedLinkGroup[] {
  const byState = new Map<UnmatchedState, Map<string, Map<string, UnmatchedEntry[]>>>();
  for (const entry of entries) {
    const state = stateOf(entry);
    const category = entry.category ?? '';
    const shelf = entry.shelf ?? '';
    const categories = byState.get(state) ?? new Map();
    byState.set(state, categories);
    const shelves = categories.get(category) ?? new Map();
    categories.set(category, shelves);
    const bucket = shelves.get(shelf) ?? [];
    shelves.set(shelf, bucket);
    bucket.push(entry);
  }

  const states: UnmatchedStateGroup[] = [...byState.entries()]
    .sort(([a], [b]) => orderOf(STATE_ORDER, a) - orderOf(STATE_ORDER, b))
    .map(([state, categories]) => {
      const categoryGroups: UnmatchedCategoryGroup[] = [...categories.entries()]
        .sort(([a], [b]) => orderOf(CATEGORY_ORDER, a) - orderOf(CATEGORY_ORDER, b))
        .map(([category, shelves]) => {
          const shelfGroups: UnmatchedShelfGroup[] = [...shelves.entries()]
            .sort(([a], [b]) => orderOf(SHELF_ORDER, a) - orderOf(SHELF_ORDER, b))
            .map(([shelf, bucket]) => ({
              label: shelfLabel(shelf),
              entries: [...bucket].sort(compareEntries),
            }));
          return {
            label: categoryLabel(category),
            count: shelfGroups.reduce((sum, group) => sum + group.entries.length, 0),
            shelves: shelfGroups,
          };
        });
      return {
        state,
        count: categoryGroups.reduce((sum, group) => sum + group.count, 0),
        categories: categoryGroups,
      };
    });

  if (!states.length) return [];
  return [
    {
      link,
      count: states.reduce((sum, group) => sum + group.count, 0),
      states,
    },
  ];
}

/** 本轮统计：新增用「运行前的名单键」做差，避免在每条 upsert 处记账。 */
export function summarizeUnmatchedRun(input: {
  unmatched: ReadonlyMap<string, UnmatchedEntry>;
  initialKeys: ReadonlySet<string>;
  seenUuids: ReadonlySet<string>;
  removedBySuccess: number;
  prunedRemoved: number;
}): { stats: UnmatchedRunStats; added: UnmatchedEntry[] } {
  const addedKeys = [...input.unmatched.keys()].filter(
    (key) => !input.initialKeys.has(key),
  );
  const notScanned = [...input.unmatched.keys()].filter(
    (key) => !input.seenUuids.has(key),
  ).length;
  const total = input.unmatched.size;
  const added = addedKeys
    .map((key) => input.unmatched.get(key))
    .filter((entry): entry is UnmatchedEntry => entry != null);
  return {
    stats: {
      total,
      added: added.length,
      removed: input.removedBySuccess + input.prunedRemoved,
      observed: total - added.length,
      notScanned,
    },
    added,
  };
}

export function zeroUnmatchedStats(): UnmatchedRunStats {
  return { total: 0, added: 0, removed: 0, observed: 0, notScanned: 0 };
}

function renderEntryLine(entry: UnmatchedEntry, index: number, now: Date): string {
  const reason =
    entry.subjectId == null
      ? entry.reason
      : `${entry.reason}(subject/${entry.subjectId})`;
  const days = daysSince(entry.firstSeenAt, now);
  const age = days == null ? '已存在天数未知' : `已存在 ${days} 天`;
  const url = entry.itemUrl || '（无链接）';
  return ` ${index}. ${entry.title} — ${url} · ${reason} · ${age}`;
}

/**
 * 渲染整段「待核对清单」。
 *
 * 输出只含**未导入**条目：成功写入的条目在运行期就被移出名单，这里不做二次过滤。
 */
export function renderUnmatchedSection(
  entries: readonly UnmatchedEntry[],
  meta: RenderUnmatchedMeta,
): string[] {
  const link = meta.link ?? DEFAULT_LINK;
  const { stats } = meta;
  const lines: string[] = [];
  lines.push(`## 待核对名单（${stats.total} 条）`);
  lines.push('');
  lines.push(
    `本轮运行（UTC）：${meta.startedAt}（上海时间为${formatShanghai(meta.startedAt)}）`,
  );
  lines.push('');
  lines.push(
    `新增 ${stats.added} · 移除 ${stats.removed} · 观察中 ${stats.observed} · ` +
      `名单合计 ${stats.total}`,
  );

  if (stats.notScanned > 0) {
    lines.push('');
    lines.push(
      `本轮有 ${stats.notScanned} 条不在扫描集合里（配额截断、分页上限或链路未运行），` +
        '已保留、不计缺席。',
    );
  }

  const truncated = meta.truncatedShelves ?? [];
  if (truncated.length) {
    lines.push('');
    lines.push(
      `另有 ${truncated.length} 个书架未遍历完整（${truncated.join('、')}）：` +
        '这些书架里尚未取到的条目无法归属到具体条目，已保留、不计缺席。',
    );
  }

  if (!entries.length) {
    lines.push('');
    lines.push('本轮无待核对条目。');
    return lines;
  }

  const added = meta.addedEntries ?? [];
  if (added.length) {
    lines.push('');
    lines.push(`本轮新增（${added.length}）`);
    lines.push('');
    for (const entry of added) {
      const reason =
        entry.subjectId == null
          ? entry.reason
          : `${entry.reason}(subject/${entry.subjectId})`;
      lines.push(
        `${stateOf(entry)} ${entry.title} — ${entry.itemUrl || '（无链接）'} · ${reason}（${link}）`,
      );
    }
  }

  for (const group of groupUnmatched(entries, link)) {
    lines.push('');
    lines.push(`### ${group.link}（${group.count}）`);
    for (const stateGroup of group.states) {
      lines.push('');
      lines.push(`#### ${stateGroup.state}（${stateGroup.count}）`);
      for (const category of stateGroup.categories) {
        lines.push('');
        lines.push(`**${category.label}（${category.count}）**`);
        for (const shelf of category.shelves) {
          lines.push(`${shelf.label}（${shelf.entries.length}）`);
          shelf.entries.forEach((entry, index) => {
            lines.push(renderEntryLine(entry, index + 1, meta.now));
          });
        }
      }
    }
  }

  return lines;
}

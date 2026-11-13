/**
 * 待核对清单渲染 —— 把名单按「链路 → 结局 → 分类 → 书架」四级分组逐条列出。
 *
 * 与 `rules/*` 同样的理由：排版属于纯函数，可以离线断言。摘要长什么样不应该
 * 只有跑完一次真实同步才知道。
 *
 * 差量块（本轮新增 / 本轮移除 / 观察中）在正文之前：它们说明「这一轮变了什么」，
 * 正文说明「现在还剩什么」。
 */
import { absoluteNeodbUrl, DEFAULT_NEODB_BASE_URL } from './rules/neodb-display';
import type { RemovedEntry, UnmatchedEntry, UnmatchedKind } from './sync-report';

export type UnmatchedShelfGroup = { label: string; entries: UnmatchedEntry[] };
export type UnmatchedCategoryGroup = {
  /** 原始分类键（book/movie/…），用于判断是否默认折叠。 */
  key: string;
  label: string;
  count: number;
  shelves: UnmatchedShelfGroup[];
};
export type UnmatchedKindGroup = {
  kind: UnmatchedKind;
  count: number;
  categories: UnmatchedCategoryGroup[];
};
export type UnmatchedLinkGroup = {
  link: string;
  count: number;
  kinds: UnmatchedKindGroup[];
};

export type RenderUnmatchedMeta = {
  /** 本轮开始时刻（ISO，UTC）。 */
  startedAt: string;
  /** 「已存在 N 天」的参照时刻。 */
  now: Date;
  /** 本轮首次越过观察窗的条目。 */
  added?: readonly UnmatchedEntry[];
  /** 本轮移出名单的条目与原因。 */
  removed?: readonly RemovedEntry[];
  /** 仍在观察窗内、尚未进入正文的条目。 */
  observing?: readonly UnmatchedEntry[];
  /** 本轮没进入扫描集合、因此冻结的条目。 */
  frozen?: readonly UnmatchedEntry[];
  /** 未遍历完整的书架；为空时不渲染「无法归属」段。 */
  truncatedShelves?: readonly string[];
  /** 链路名；当前只有一条，留作扩展。 */
  link?: string;
  /** NeoDB 实例地址，用于把名单里的站内相对链接补成绝对地址。 */
  neodbBaseUrl?: string;
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

/** 移除原因的用户可读说明。 */
export const REMOVAL_LABELS: Readonly<Record<RemovedEntry['cause'], string>> = {
  imported: '已导入',
  absent: '连续两轮未再出现',
};

const UNKNOWN_CATEGORY = '未分类';
const UNKNOWN_SHELF = '未标注';
const DEFAULT_LINK = 'NeoDB → Bangumi';
const DAY_MS = 86_400_000;
const SHANGHAI_OFFSET_MS = 8 * 3_600_000;

/** 固定顺序：同一份名单每次渲染结果一致，Job Summary 才可 diff。 */
const KIND_ORDER: readonly UnmatchedKind[] = ['unresolved', 'skipped', 'failed'];
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
 * 默认折叠的分类：条目多、单条价值低，是否展开交给读者。
 * 只影响 Job Summary 的排版（`<details>`），不改变任何数据。
 */
const COLLAPSED_CATEGORIES: ReadonlySet<string> = new Set([
  'book',
  'music',
  'game',
  'podcast',
  'performance',
]);

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
  return byTitle !== 0 ? byTitle : a.neodbUuid.localeCompare(b.neodbUuid);
}

/**
 * 四级分组。返回数组而不是单对象：当前只有一条链路，将来接第二条时
 * 渲染层不需要改。
 */
export function groupUnmatched(
  entries: readonly UnmatchedEntry[],
  link: string = DEFAULT_LINK,
): UnmatchedLinkGroup[] {
  const byKind = new Map<UnmatchedKind, Map<string, Map<string, UnmatchedEntry[]>>>();
  for (const entry of entries) {
    const category = entry.category ?? '';
    const categories = byKind.get(entry.kind) ?? new Map();
    byKind.set(entry.kind, categories);
    const shelves = categories.get(category) ?? new Map();
    categories.set(category, shelves);
    const bucket = shelves.get(entry.shelf) ?? [];
    shelves.set(entry.shelf, bucket);
    bucket.push(entry);
  }

  const kinds: UnmatchedKindGroup[] = [...byKind.entries()]
    .sort(([a], [b]) => orderOf(KIND_ORDER, a) - orderOf(KIND_ORDER, b))
    .map(([kind, categories]) => {
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
            key: category,
            label: categoryLabel(category),
            count: shelfGroups.reduce((sum, group) => sum + group.entries.length, 0),
            shelves: shelfGroups,
          };
        });
      return {
        kind,
        count: categoryGroups.reduce((sum, group) => sum + group.count, 0),
        categories: categoryGroups,
      };
    });

  if (!kinds.length) return [];
  return [
    {
      link,
      count: kinds.reduce((sum, group) => sum + group.count, 0),
      kinds,
    },
  ];
}

function entryUrl(entry: UnmatchedEntry, baseUrl: string): string {
  return absoluteNeodbUrl(entry.itemUrl, baseUrl) || '（无链接）';
}

function reasonText(entry: UnmatchedEntry): string {
  return entry.subjectId == null
    ? entry.reason
    : `${entry.reason}(subject/${entry.subjectId})`;
}

/**
 * 差量块的条目行：`名称 — 链接 · reason`。
 *
 * 移除的条目只有名字加删除线，链接保持可点 —— 「它真的匹配上了吗」正是移除
 * 会引出的那个问题。观察期条目没有序号：它们还不是待办。
 */
function diffLine(entry: UnmatchedEntry, baseUrl: string, strike = false): string {
  const name = strike ? `~~${entry.title}~~` : entry.title;
  return `${name} — ${entryUrl(entry, baseUrl)} · ${reasonText(entry)}`;
}

function renderEntryLine(
  entry: UnmatchedEntry,
  index: number,
  now: Date,
  baseUrl: string,
): string {
  const days = daysSince(entry.firstSeenAt, now);
  const age = days == null ? '已存在天数未知' : `已存在 ${days} 天`;
  return ` ${index}. ${entry.title} — ${entryUrl(entry, baseUrl)} · ${reasonText(entry)} · ${age}`;
}

/**
 * 渲染整段「待核对清单」。
 *
 * 正文只含越过观察窗的条目；观察期条目单独成块，避免读者把「刚出现一轮的失败」
 * 当成已确认的缺口。
 */
export function renderUnmatchedSection(
  entries: readonly UnmatchedEntry[],
  meta: RenderUnmatchedMeta,
): string[] {
  const link = meta.link ?? DEFAULT_LINK;
  const baseUrl = meta.neodbBaseUrl?.trim() || DEFAULT_NEODB_BASE_URL;
  const added = meta.added ?? [];
  const removed = meta.removed ?? [];
  const observing = meta.observing ?? [];
  const frozen = meta.frozen ?? [];
  const lines: string[] = [];

  lines.push(`## 待核对名单（${entries.length} 条）`);
  lines.push('');
  lines.push(
    `本轮运行（UTC）：${meta.startedAt}（上海时间为${formatShanghai(meta.startedAt)}）`,
  );
  lines.push('');
  lines.push(
    `新增 ${added.length} · 移除 ${removed.length} · 观察中 ${observing.length} · ` +
      `名单合计 ${entries.length}`,
  );

  if (frozen.length) {
    lines.push('');
    lines.push(
      `本轮有 ${frozen.length} 条不在扫描集合里（配额截断、分页上限或链路未运行），` +
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

  if (added.length) {
    lines.push('');
    lines.push(`**本轮新增（${added.length}）**`);
    lines.push('');
    for (const entry of added) {
      lines.push(`${diffLine(entry, baseUrl)}（${link}）`);
    }
  }

  if (removed.length) {
    const absentOnly = removed.every((item) => item.cause === 'absent');
    lines.push('');
    lines.push(
      absentOnly
        ? `**本轮移除（${removed.length}，连续两轮被扫描到且未再出现）**`
        : `**本轮移除（${removed.length}）**`,
    );
    lines.push('');
    for (const item of removed) {
      lines.push(
        `${diffLine(item.entry, baseUrl, true)} · ${REMOVAL_LABELS[item.cause]}`,
      );
    }
  }

  if (observing.length) {
    lines.push('');
    lines.push(`**观察中（${observing.length}，下一轮仍出现才入名单）**`);
    lines.push('');
    for (const entry of observing) {
      lines.push(diffLine(entry, baseUrl));
    }
  }

  if (!entries.length) {
    lines.push('');
    lines.push('本轮无待核对条目。');
    return lines;
  }

  for (const group of groupUnmatched(entries, link)) {
    lines.push('');
    lines.push(`### ${group.link}（${group.count}）`);
    for (const kindGroup of group.kinds) {
      lines.push('');
      lines.push(`#### ${kindGroup.kind}（${kindGroup.count}）`);
      for (const category of kindGroup.categories) {
        const collapsed = COLLAPSED_CATEGORIES.has(category.key) && category.count > 0;
        lines.push('');
        if (collapsed) {
          // `<summary>` 后必须空一行，否则内部 Markdown 会被当成纯文本。
          lines.push('<details>');
          lines.push(
            `<summary><b>${category.label}（${category.count}）</b></summary>`,
          );
          lines.push('');
        } else {
          lines.push(`**${category.label}（${category.count}）**`);
        }
        for (const shelf of category.shelves) {
          lines.push(`${shelf.label}（${shelf.entries.length}）`);
          shelf.entries.forEach((entry, index) => {
            lines.push(renderEntryLine(entry, index + 1, meta.now, baseUrl));
          });
        }
        if (collapsed) {
          lines.push('');
          lines.push('</details>');
        }
      }
    }
  }

  return lines;
}

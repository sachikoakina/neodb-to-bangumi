/**
 * NeoDB → Bangumi 匹配规则 —— 三级策略中的纯函数部分。
 *
 * 1. 外链直连：`external_resources` 里的 Bangumi subject id（最可靠）；
 * 2. 标题搜索 + 精确匹配：`display_title` → `title` → `localized_title[].text`
 *    依次作为关键词，候选 `name` / `name_cn` 规范化后必须完全相等；
 * 3. 年份软过滤：仅动画（2）/真人（6）参与，三态规则 ——
 *    源年份未知 → 过滤不运行；候选年份未知 → 该候选通过；双方都有 →
 *    |候选 − 源| <= 容差才保留。
 *
 * 不猜、不模糊匹配、不跨类型。全部失败 → unresolved，交给待核对名单。
 */
import type { BangumiSubject, NeodbItem } from '../types';

/** 规范化标题键：trim + 小写。 */
export function normalizeTitle(raw: string): string {
  return raw.trim().toLowerCase();
}

/** 从 NeoDB `external_resources` 提取 Bangumi subject id。 */
export function extractBangumiSubjectId(
  resources: { url?: string }[] | undefined,
): number | null {
  for (const resource of resources ?? []) {
    const match = resource.url?.match(/(?:bgm\.tv|bangumi\.tv)\/subject\/(\d+)/i);
    if (match?.[1]) {
      return Number(match[1]);
    }
  }
  return null;
}

/**
 * 标题候选，按优先级：`display_title` → `title` → `localized_title[].text`。
 * 去空、按规范化键去重，保证搜索次数有界且顺序稳定。
 */
export function titleCandidates(
  item: Pick<NeodbItem, 'display_title' | 'title' | 'localized_title'>,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [
    item.display_title,
    item.title,
    ...(item.localized_title ?? []).map((t) => t.text),
  ]) {
    const trimmed = raw?.trim();
    if (!trimmed) continue;
    const key = normalizeTitle(trimmed);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

/** 找出所有精确同名候选（`name` 或 `name_cn`），保持响应顺序。 */
export function exactMatches(
  subjects: BangumiSubject[],
  title: string,
): BangumiSubject[] {
  const normalized = normalizeTitle(title);
  if (!normalized) {
    return [];
  }
  return subjects.filter(
    (s) =>
      s.name?.trim().toLowerCase() === normalized ||
      s.name_cn?.trim().toLowerCase() === normalized,
  );
}

/** 从 `air_year` / `air_date` / `date` 三种写法解析四位年份。 */
function parseBangumiYear(raw: unknown): number | null {
  if (typeof raw === 'number') {
    return Number.isInteger(raw) && raw > 0 ? raw : null;
  }
  if (typeof raw !== 'string') {
    return null;
  }
  const match = raw.trim().match(/^(\d{4})/);
  return match ? Number(match[1]) : null;
}

/** Bangumi 条目可用于定年的年份；没有则 null。 */
export function bangumiSubjectYear(subject: BangumiSubject): number | null {
  return (
    parseBangumiYear(subject.air_year) ??
    parseBangumiYear(subject.air_date) ??
    parseBangumiYear(subject.date)
  );
}

/** NeoDB 条目的年份（书架列表不含，需条目详情补齐）。 */
export function neodbItemYear(
  item: Pick<NeodbItem, 'year' | 'pub_year'>,
): number | null {
  return item.year ?? item.pub_year ?? null;
}

/**
 * 只有动画（2）与真人（6）参与年份软过滤。
 * 书籍/音乐/游戏的发行年口径不同，年份对不上更可能是数据形态问题，
 * 而不是「不是同一部作品」的证据。
 */
export function isYearFilterType(type: BangumiSubject['type']): boolean {
  return type === 2 || type === 6;
}

export type YearPickResult =
  | { status: 'matched'; subject: BangumiSubject }
  | { status: 'rejected'; subject: BangumiSubject }
  | { status: 'no-candidate' };

/**
 * 在精确同名候选里选第一个通过年份软过滤的。
 *
 * 三态规则（刻意如此）：
 * - 源年份未知 → 过滤不运行（返回第一个候选）；
 * - 候选年份未知 → 该候选通过；缺数据不是反对证据；
 * - 双方都有 → |候选 − 源| <= 容差才保留。
 *
 * 被拒绝的候选只是被跳过：继续尝试下一个，全部被拒才 `no-candidate`。
 *
 * @param resolveYear 注入以便对缺日期的候选按需读完整条目；测试传普通函数。
 */
export async function pickExactMatchByYear(
  candidates: BangumiSubject[],
  expectedYear: number | null,
  tolerance: number,
  resolveYear: (
    subject: BangumiSubject,
  ) => Promise<number | null> | number | null = bangumiSubjectYear,
): Promise<YearPickResult> {
  if (!candidates.length) {
    return { status: 'no-candidate' };
  }
  // 没有源年份：不比较、不额外请求。
  if (expectedYear == null) {
    return { status: 'matched', subject: candidates[0]! };
  }

  const allowedDrift = Math.max(0, tolerance);
  for (const candidate of candidates) {
    // 防御：搜索已按类型过滤；即使调用方传混合列表，书/音乐/游戏也不参与年份规则。
    if (!isYearFilterType(candidate.type)) {
      return { status: 'matched', subject: candidate };
    }
    const year = await resolveYear(candidate);
    if (year == null) {
      return { status: 'matched', subject: candidate };
    }
    if (Math.abs(year - expectedYear) <= allowedDrift) {
      return { status: 'matched', subject: candidate };
    }
  }
  return { status: 'no-candidate' };
}

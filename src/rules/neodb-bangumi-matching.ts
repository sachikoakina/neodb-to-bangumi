/**
 * NeoDB → Bangumi 匹配规则 —— 三级策略中的纯函数部分。
 *
 * 1. 外链直连：`external_resources` 里的 Bangumi subject id（最可靠）；
 * 2. 标题搜索 + 精确匹配：`display_title` → `title` → `localized_title[].text`
 *    依次作为关键词，候选 `name` / `name_cn` 规范化后必须完全相等；
 * 3. 证据裁决：先按年份过滤，再按媒体形态拒绝明显冲突，最后按年份接近度
 *    打分；唯一最高分才命中，并列 → ambiguous（不猜）。
 *
 * 年份三态规则保持不变：源年份未知 → 不做年份过滤；候选年份未知 → 通过
 * （缺数据不是反对证据）；双方都有 → 差值在容差内才保留。
 *
 * 媒体形态只在双方都能判定时生效：NeoDB `category=movie/tv` 对比 Bangumi
 * `platform`（剧场版/电影 → movie；TV/Web/电视剧/动态漫画 → tv）。OVA 等
 * 无法判定的平台既不放行也不拒绝，交由年份与歧义规则处理。
 */
import type { BangumiSubject, NeodbItem } from '../types';

/** 粗粒度媒体形态；只表达电影与剧集两类可判定的形态。 */
export type MediaForm = 'movie' | 'tv';

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
 * 只有动画（2）与真人（6）参与年份过滤。
 * 书籍/音乐/游戏的发行年口径不同，年份对不上更可能是数据形态问题，
 * 而不是「不是同一部作品」的证据。
 */
export function isYearFilterType(type: BangumiSubject['type']): boolean {
  return type === 2 || type === 6;
}

/** NeoDB 分类 → 可判定的媒体形态；book/music/game 等返回 null。 */
export function neodbCategoryToMediaForm(
  category: string | undefined,
): MediaForm | null {
  if (category === 'movie') return 'movie';
  if (category === 'tv') return 'tv';
  return null;
}

/**
 * Bangumi 平台 → 媒体形态。刻意保守：
 * - `剧场版` / `电影` → movie；
 * - `TV` / `Web` / `电视剧` / `动态漫画` → tv；
 * - OVA / OAD / 未定 / 空值 → null（不可判定，不参与冲突判断）。
 */
export function bangumiPlatformMediaForm(
  platform: string | undefined,
): MediaForm | null {
  const value = platform?.trim();
  if (!value) return null;
  if (value === '剧场版' || value === '电影') return 'movie';
  if (value === 'TV' || value === 'Web' || value === '电视剧' || value === '动态漫画') {
    return 'tv';
  }
  if (/^tv$/i.test(value) || /^web$/i.test(value)) return 'tv';
  return null;
}

export type MatchEvidence = {
  year: number | null;
  mediaForm: MediaForm | null;
};

export type MatchPick =
  | { status: 'matched'; subject: BangumiSubject }
  | { status: 'ambiguous'; candidates: BangumiSubject[] }
  | { status: 'no-candidate' };

export type MatchPickOptions = {
  /** 源侧媒体形态；null/undefined 表示不可判定，不启用形态冲突过滤。 */
  mediaForm?: MediaForm | null;
  /** 由调用方注入证据读取（可能需要读完整条目），测试可传普通函数。 */
  resolveEvidence?: (subject: BangumiSubject) => Promise<MatchEvidence> | MatchEvidence;
};

/**
 * 从精确同名候选中选出唯一命中。
 *
 * 步骤：
 * 1. 逐候选取年份与媒体形态；
 * 2. 年份过滤（仅类型 2/6）：源未知不比较；候选未知通过；
 * 3. 媒体形态过滤：双方可判定且冲突才拒绝；
 * 4. 剩余一个 → 命中；多个 → 按年份距离取唯一最小者；
 *    距离并列或全部不可知 → ambiguous。
 *
 * 相比旧的 first-hit，这里**不再**返回第一个通过者：多个同样可信的
 * 候选意味着证据不足，写入任何一个都可能选错作品。
 */
export async function pickExactMatch(
  candidates: BangumiSubject[],
  expectedYear: number | null,
  tolerance: number,
  options: MatchPickOptions = {},
): Promise<MatchPick> {
  if (!candidates.length) {
    return { status: 'no-candidate' };
  }

  const resolveEvidence =
    options.resolveEvidence ??
    ((subject: BangumiSubject): MatchEvidence => ({
      year: bangumiSubjectYear(subject),
      mediaForm: bangumiPlatformMediaForm(subject.platform),
    }));

  const allowedDrift = Math.max(0, tolerance);
  const viable: Array<{ subject: BangumiSubject; distance: number | null }> = [];

  for (const candidate of candidates) {
    const evidence = await resolveEvidence(candidate);

    if (
      isYearFilterType(candidate.type) &&
      expectedYear != null &&
      evidence.year != null &&
      Math.abs(evidence.year - expectedYear) > allowedDrift
    ) {
      continue;
    }

    if (
      options.mediaForm != null &&
      evidence.mediaForm != null &&
      evidence.mediaForm !== options.mediaForm
    ) {
      continue;
    }

    const distance =
      isYearFilterType(candidate.type) && expectedYear != null && evidence.year != null
        ? Math.abs(evidence.year - expectedYear)
        : null;
    viable.push({ subject: candidate, distance });
  }

  if (!viable.length) {
    return { status: 'no-candidate' };
  }
  if (viable.length === 1) {
    return { status: 'matched', subject: viable[0]!.subject };
  }

  // 只有已知年份的候选参与「接近度」比较；全部不可知时视为并列。
  const known = viable.filter((entry) => entry.distance != null);
  if (known.length) {
    const bestDistance = Math.min(...known.map((entry) => entry.distance as number));
    const best = viable.filter((entry) => entry.distance === bestDistance);
    if (best.length === 1) {
      return { status: 'matched', subject: best[0]!.subject };
    }
    return {
      status: 'ambiguous',
      candidates: best.map((entry) => entry.subject),
    };
  }

  return {
    status: 'ambiguous',
    candidates: viable.map((entry) => entry.subject),
  };
}

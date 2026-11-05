/**
 * NeoDB → Bangumi 字段映射 —— 全部纯函数，可离线断言。
 *
 * 状态映射是 Bangumi → NeoDB（原项目链路④）的反向；评分同为 0–10 分制，
 * 直接透传，无需换算。
 */
import type { BangumiCollectionType, BangumiSubjectType } from '../types';

/** 评分合并策略：`bangumi_prefer` 保留目标非 0 分；`overwrite` 用 NeoDB 覆盖。 */
export type RatingMergeProfile = 'bangumi_prefer' | 'overwrite';

/** 短评合并策略：`bangumi_prefer` 只填空；`overwrite` 覆盖（含清空）。 */
export type CommentMergeProfile = 'bangumi_prefer' | 'overwrite';

/** 状态保护：`no-downgrade` 时现有「看过」不被想看/在看降级。 */
export type StatusGuard = 'off' | 'no-downgrade';

/**
 * NeoDB `shelf_type` → Bangumi 收藏 `type`。
 *
 * | NeoDB      | 含义   | Bangumi | 含义 |
 * | ---------- | ------ | ------- | ---- |
 * | wishlist   | 想看   | 1       | 想看 |
 * | progress   | 在看   | 3       | 在看 |
 * | complete   | 看完   | 2       | 看过 |
 * | dropped    | 放弃   | 5       | 抛弃 |
 *
 * NeoDB 没有「搁置」（4）的概念，无法表达该意图，因此目标为 4 时不覆盖。
 */
export const NEODB_SHELF_TO_BANGUMI_TYPE: Record<string, BangumiCollectionType> = {
  wishlist: 1,
  progress: 3,
  complete: 2,
  dropped: 5,
};

export type StatusMappingResult =
  | { kind: 'map'; type: BangumiCollectionType }
  | { kind: 'skip-on-hold' }
  | { kind: 'no-downgrade' }
  | { kind: 'unknown-shelf-type' };

/**
 * 把 NeoDB 书架状态映射为 Bangumi 收藏类型，并叠加保护规则：
 *
 * 1. 未知 shelf_type → `unknown-shelf-type`（失败在关闭一侧）；
 * 2. 目标已是搁置（4）→ `skip-on-hold`，NeoDB 无法表达搁置意图；
 * 3. `no-downgrade` 且目标为看过（2）、来源想看/在看 → `no-downgrade`；
 * 4. 其余正常映射。
 */
export function mapShelfType(
  shelfType: string,
  existingType: number,
  guard: StatusGuard,
): StatusMappingResult {
  const mapped = NEODB_SHELF_TO_BANGUMI_TYPE[shelfType];
  if (mapped == null) {
    return { kind: 'unknown-shelf-type' };
  }
  if (existingType === 4) {
    return { kind: 'skip-on-hold' };
  }
  if (
    guard === 'no-downgrade' &&
    existingType === 2 &&
    (mapped === 1 || mapped === 3)
  ) {
    return { kind: 'no-downgrade' };
  }
  return { kind: 'map', type: mapped };
}

/**
 * NeoDB 分类 → 可搜索的 Bangumi `subject_type` 列表。
 *
 * 电影/电视剧 → [2, 6]：Bangumi 上动画电影/番剧归 2，真人归 6，同一部
 * 「影视」两边都可能在。`podcast` / `performance` 返回空 —— 调用方据此跳过。
 */
export function neodbCategoryToBangumiSubjectTypes(
  category: string | undefined,
): BangumiSubjectType[] {
  switch (category) {
    case 'book':
      return [1];
    case 'movie':
    case 'tv':
      return [2, 6];
    case 'music':
      return [3];
    case 'game':
      return [4];
    default:
      return [];
  }
}

/** 该分类是否被 Bangumi 支持（用于白名单之外的兜底判断）。 */
export function isBangumiSupportedCategory(category: string | undefined): boolean {
  return neodbCategoryToBangumiSubjectTypes(category).length > 0;
}

/**
 * 评分合并：NeoDB `rating_grade` 与 Bangumi `rate` 同为 0–10，直接透传。
 *
 * - `bangumi_prefer`：目标已有非 0 分 → 保留；目标为 0 → 用源分填充；源无分不清空。
 * - `overwrite`：始终用源分（包括把目标改回 0）。
 */
export function mergeRating(
  sourceGrade: number | null | undefined,
  existingRate: number | null | undefined,
  profile: RatingMergeProfile,
): number {
  const source = sourceGrade ?? 0;
  if (profile === 'overwrite') {
    return source;
  }
  const existing = existingRate ?? 0;
  return existing > 0 ? existing : source;
}

/**
 * 短评合并：
 *
 * - `bangumi_prefer`：目标已有非空短评 → 保留；目标为空 → 用源短评；源为空不清空。
 * - `overwrite`：始终用源短评，空值也会清空。
 */
export function mergeComment(
  sourceComment: string | null | undefined,
  existingComment: string | null | undefined,
  profile: CommentMergeProfile,
): string {
  const source = sourceComment ?? '';
  if (profile === 'overwrite') {
    return source;
  }
  const existing = existingComment ?? '';
  return existing.trim() !== '' ? existing : source;
}

/**
 * 可见性映射（可选开启）：NeoDB `visibility=2`（私密）→ `private: true`，
 * 其余 → `false`。默认关闭，关闭时不写 `private` 字段、不参与 diff。
 */
export function mapVisibilityToPrivate(visibility: number | null | undefined): boolean {
  return visibility === 2;
}

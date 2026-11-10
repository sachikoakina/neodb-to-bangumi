/**
 * NeoDB 条目的展示归一 —— 名称与链接。
 *
 * 展示口径与匹配口径**刻意分开**：`titleCandidates` 的顺序服务于搜索命中率，
 * 这里只决定报告与日志里写什么。两者混用会让「改展示」变成「改匹配」。
 *
 * 纯函数、无 IO：报告长什么样应该能离线断言。
 */
import type { NeodbItem } from '../types';

/** 自建实例未配置时的兜底域名。 */
export const DEFAULT_NEODB_BASE_URL = 'https://neodb.social';

type DisplayableItem = Pick<
  NeodbItem,
  'display_title' | 'title' | 'uuid' | 'localized_title'
>;

/**
 * 展示名：NeoDB 的首个本地化名称优先。
 *
 * 顺序为「第一个 `zh*` 本地化名 → 第一个本地化名 → display_title → title → uuid」。
 * `display_title` 在部分条目上是英文原名（如 `14 Blades`），而中文名只存在于
 * `localized_title` 里，因此不能简单地信 display_title。
 */
export function displayName(item: DisplayableItem): string {
  const localized = (item.localized_title ?? [])
    .map((entry) => ({
      lang: (entry.lang ?? '').trim().toLowerCase(),
      text: (entry.text ?? '').trim(),
    }))
    .filter((entry) => entry.text !== '');
  const chinese = localized.find((entry) => entry.lang.startsWith('zh'));
  const preferred = chinese ?? localized[0];
  return (
    preferred?.text || item.display_title?.trim() || item.title?.trim() || item.uuid
  );
}

/**
 * 绝对地址：NeoDB 的 `url` 可能是站内相对路径（`/movie/xxx`）。
 *
 * 已是 `http(s)://` 的原样返回；相对路径按 baseUrl 拼全；空值返回空串，
 * 由调用方决定渲染成 `（无链接）`。baseUrl 缺省或为空时回退官方域名，
 * 避免拼出 `undefined/movie/...`。
 */
export function absoluteNeodbUrl(raw: string | undefined, baseUrl?: string): string {
  const value = (raw ?? '').trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  const base = (baseUrl?.trim() || DEFAULT_NEODB_BASE_URL).replace(/\/+$/, '');
  return `${base}/${value.replace(/^\/+/, '')}`;
}

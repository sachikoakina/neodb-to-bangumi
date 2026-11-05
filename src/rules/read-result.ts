/**
 * 读取失败的三态归一。
 *
 * 404 在「条目集合」语境（如收藏）意味着 absent —— 这是唯一允许据此新建的读法；
 * 在「条目本身」语境（如 subject）意味着条目不存在，是条目级失败。
 * 401/403 永远是 auth：认证失败应中止链路，而不是被当作空数据。
 */
export type ReadFailureKind = 'auth' | 'absent' | 'item';

export function classifyReadFailure(
  status: number | null,
  scope: 'collection' | 'item' = 'collection',
): ReadFailureKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return scope === 'item' ? 'item' : 'absent';
  return 'item';
}

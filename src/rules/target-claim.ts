/**
 * 同一 Bangumi 目标的认领裁决 —— 纯函数。
 *
 * NeoDB 上同一作品可能有多条目录条目（Bangumi 外链条目与其孪生条目），
 * 它们的标记可能映射到同一个 Bangumi subject。若两条都写，后写者会覆盖
 * 先写者，「看过」可能被「在看/想看」冲掉。这里用一份轮内认领表决定胜者：
 *
 * 1. 身份置信度：外链（link）> ISBN（isbn）> 标题匹配（title）；
 * 2. 状态强度：complete > progress / wishlist > dropped；
 * 3. 仍相同：较小 NeoDB uuid 胜出（保证同一轮内结果确定）。
 *
 * 认领表只在当前运行内有效，不跨轮持久化 —— 跨轮状态会让胜负随运行顺序
 * 翻转，造成反复写入。
 */
export type ClaimVia = 'link' | 'isbn' | 'title';

export type TargetClaim = {
  subjectId: number;
  neodbUuid: string;
  shelfType: string;
  via: ClaimVia;
};

/** 身份置信度：外链是用户自己的选择，高于 ISBN（版次身份），再高于标题搜索。 */
export const VIA_RANK: Record<ClaimVia, number> = {
  link: 3,
  isbn: 2,
  title: 1,
};

/**
 * 状态强度。NeoDB 的 progress 与 wishlist 视为同一档：
 * 二者都比 dropped 更接近「用户在意这部作品」。
 */
export function shelfStatusRank(shelfType: string): number {
  switch (shelfType) {
    case 'complete':
      return 3;
    case 'progress':
    case 'wishlist':
      return 2;
    case 'dropped':
      return 1;
    default:
      return 0;
  }
}

/** 认领排序键，便于测试与日志。 */
export function claimRank(claim: TargetClaim): [number, number] {
  return [VIA_RANK[claim.via], shelfStatusRank(claim.shelfType)];
}

/**
 * 已有认领者时，新认领者是否应当被跳过。
 *
 * 只有严格更强才替换：置信度更高，或置信度相同但状态更强；
 * 全部打平时取较小 uuid，因此 uuid 更大（或相等）的后来者被跳过。
 */
export function shouldSkipClaim(
  incumbent: TargetClaim,
  incoming: TargetClaim,
): boolean {
  const [incumbentVia, incumbentStatus] = claimRank(incumbent);
  const [incomingVia, incomingStatus] = claimRank(incoming);
  if (incomingVia !== incumbentVia) {
    return incomingVia < incumbentVia;
  }
  if (incomingStatus !== incumbentStatus) {
    return incomingStatus < incumbentStatus;
  }
  return incoming.neodbUuid >= incumbent.neodbUuid;
}

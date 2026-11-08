import { describe, expect, it } from 'vitest';
import { pickExactMatch } from '../src/rules/neodb-bangumi-matching';
import type { BangumiSubject } from '../src/types';

/**
 * 2026-11-06 全量迁移事故的六个错配种子（规则级最小复现）。
 *
 * 旧代码在「标题精确同名 + 年份弱过滤」下把这些 NeoDB 电影错配到了
 * 同名冷门 Bangumi 动画条目，写入「看过」并点亮分集。每个种子锁定
 * 一条错配路径的当前裁决，匹配规则改动必须先跑通本文件：
 *
 * - strict=0（旧行为，SYNC_MATCH_STRICT=0）：保留当时的语义，供对照；
 * - strict=1（新默认）：除形态冲突与年份超差外，证据不足一律持留。
 */
function bgm(partial: Partial<BangumiSubject>): BangumiSubject {
  return { id: 0, type: 2, name: 'seed', name_cn: '', ...partial };
}

async function verdict(
  candidates: BangumiSubject[],
  sourceYear: number | null,
  sourceForm: 'movie' | 'tv' | null,
): Promise<string> {
  const picked = await pickExactMatch(candidates, sourceYear, 1, {
    strict: true,
    mediaForm: sourceForm,
  });
  return picked.status;
}

describe('事故种子：2026-11-06 错配复现', () => {
  it('seed 2082《REC/甜蜜声优》：电影↔TV动画，形态冲突拦截（strict 前已由形态规则关闭）', async () => {
    // NeoDB 电影《REC》（2007，西班牙恐怖片）→ Bangumi 2006 年 10 话 TV 动画。
    // 日志证据：分集进度 kind=movie target=1（NeoDB 条目是电影，条目却是 TV 动画）。
    const candidates = [
      bgm({ id: 2082, name: 'REC', date: '2006-02-02', platform: 'TV' }),
    ];
    expect(await verdict(candidates, 2007, 'movie')).toBe('no-candidate');
    // strict=0 同样拒绝：形态冲突过滤（main 已有）独立于此开关。
    const loose = await pickExactMatch(candidates, 2007, 1, { mediaForm: 'movie' });
    expect(loose.status).toBe('no-candidate');
  });

  it('seed 646059《Identidad》：源年份缺失 + 候选证据双缺 → strict 持留', async () => {
    // NeoDB《致命ID/Identity》(2003) 的评论被同步到 2024 年秘鲁短片《Identidad》。
    // 源年份已知时（2003 vs 2024，Δ=21）新旧实现都拒绝。
    const dated = [bgm({ id: 646059, name: 'Identidad', date: '2024' })];
    expect(await verdict(dated, 2003, 'movie')).toBe('no-candidate');
    // 事故路径：NeoDB 年份补取失败 → 年份过滤整体跳过。strict=1 持留；strict=0 复现旧错配。
    expect(await verdict(dated, null, 'movie')).toBe('ambiguous');
    const loose = await pickExactMatch(dated, null, 1, { mediaForm: 'movie' });
    expect(loose.status).toBe('matched');
  });

  it('seed 407681《猫鼠游戏》：候选年份 "\\*" + 平台为空 → strict 持留', async () => {
    // NeoDB《Catch Me If You Can》(2002) → Bangumi 国产动画《猫鼠游戏》（年度"\*"）。
    // 候选年份未知按三态规则「通过」，是旧代码放行它的直接原因。
    const candidates = [bgm({ id: 407681, name: '猫鼠游戏' })];
    expect(await verdict(candidates, 2002, 'movie')).toBe('ambiguous');
    const loose = await pickExactMatch(candidates, 2002, 1, { mediaForm: 'movie' });
    expect(loose.status).toBe('matched');
  });

  it('seed 345819《笑傲江湖WEB》：未定档无分集候选 → strict 持留', async () => {
    // NeoDB 上的《笑傲江湖》影视条目 → 腾讯未定档 WEB 动画（无年份、无平台、无分集）。
    const candidates = [bgm({ id: 345819, name: '笑傲江湖' })];
    expect(await verdict(candidates, 2001, 'tv')).toBe('ambiguous');
    const loose = await pickExactMatch(candidates, 2001, 1, { mediaForm: 'tv' });
    expect(loose.status).toBe('matched');
  });

  it('seed 364872《Остров》：双方年份已知超差 → 拒绝（与 strict 无关）', async () => {
    // 同名电影 (2006) → 1973 苏联动画短片；Δ=33 远超容差，年份过滤直接拒绝。
    const candidates = [bgm({ id: 364872, name: 'Остров', date: '1973' })];
    expect(await verdict(candidates, 2006, 'movie')).toBe('no-candidate');
  });

  it('seed 639438《鳥》：源年份缺失 → strict 持留', async () => {
    // 同名条目 → 1985 古川タク 3 分钟短片；NeoDB 侧缺年份时旧代码即中。
    const candidates = [bgm({ id: 639438, name: '鳥', date: '1985' })];
    expect(await verdict(candidates, null, 'movie')).toBe('ambiguous');
    const loose = await pickExactMatch(candidates, null, 1, { mediaForm: 'movie' });
    expect(loose.status).toBe('matched');
  });
});

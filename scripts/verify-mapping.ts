/**
 * 离线断言状态/分类/字段映射表 —— 与 docs/mapping.md 逐行对应。
 */
import { consola } from 'consola';
import {
  isBangumiSupportedCategory,
  mapShelfType,
  mergeComment,
  mergeRating,
  neodbCategoryToBangumiSubjectTypes,
  planBangumiPrivate,
} from '../src/rules/neodb-bangumi-mapping';
import { planBookProgress, planEpisodeProgress } from '../src/rules/bangumi-progress';

let failures = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures += 1;
    consola.error(
      `FAIL ${name}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`,
    );
  }
}

// ── 状态映射主表 ──
check('wishlist→1', mapShelfType('wishlist', 0, 'off'), { kind: 'map', type: 1 });
check('progress→3', mapShelfType('progress', 0, 'off'), { kind: 'map', type: 3 });
check('complete→2', mapShelfType('complete', 0, 'off'), { kind: 'map', type: 2 });
check('dropped→5', mapShelfType('dropped', 0, 'off'), { kind: 'map', type: 5 });

// ── 保护规则 ──
check('目标搁置(4)跳过', mapShelfType('complete', 4, 'off'), { kind: 'skip-on-hold' });
check('目标搁置(4)跳过-dropped', mapShelfType('dropped', 4, 'off'), {
  kind: 'skip-on-hold',
});
check('no-downgrade: 看过不被想看降级', mapShelfType('wishlist', 2, 'no-downgrade'), {
  kind: 'no-downgrade',
});
check('no-downgrade: 看过不被在看降级', mapShelfType('progress', 2, 'no-downgrade'), {
  kind: 'no-downgrade',
});
check('no-downgrade: 看过→看过正常', mapShelfType('complete', 2, 'no-downgrade'), {
  kind: 'map',
  type: 2,
});
check('guard=off: 看过可被想看覆盖', mapShelfType('wishlist', 2, 'off'), {
  kind: 'map',
  type: 1,
});
check('未知状态失败在关闭一侧', mapShelfType('unknown', 0, 'off'), {
  kind: 'unknown-shelf-type',
});

// ── 分类 → subject_type ──
check('book→[1]', neodbCategoryToBangumiSubjectTypes('book'), [1]);
check('movie→[2,6]', neodbCategoryToBangumiSubjectTypes('movie'), [2, 6]);
check('tv→[2,6]', neodbCategoryToBangumiSubjectTypes('tv'), [2, 6]);
check('music→[3]', neodbCategoryToBangumiSubjectTypes('music'), [3]);
check('game→[4]', neodbCategoryToBangumiSubjectTypes('game'), [4]);
check('podcast→[]', neodbCategoryToBangumiSubjectTypes('podcast'), []);
check('performance→[]', neodbCategoryToBangumiSubjectTypes('performance'), []);
check('podcast 不被 Bangumi 支持', isBangumiSupportedCategory('podcast'), false);
check('book 被 Bangumi 支持', isBangumiSupportedCategory('book'), true);

// ── 评分合并（0–10 同分制透传）──
check('prefer: 目标非0保留', mergeRating(7, 9, 'bangumi_prefer'), 9);
check('prefer: 目标0用源填充', mergeRating(7, 0, 'bangumi_prefer'), 7);
check('prefer: 源无分不清空', mergeRating(null, 8, 'bangumi_prefer'), 8);
check('prefer: 双方无分', mergeRating(null, 0, 'bangumi_prefer'), 0);
check('overwrite: 源覆盖', mergeRating(6, 8, 'overwrite'), 6);

// ── 短评合并（纯文本透传）──
check(
  'prefer: 目标非空短评保留',
  mergeComment('新的', '旧的', 'bangumi_prefer'),
  '旧的',
);
check('prefer: 目标空短评用源填充', mergeComment('新的', '', 'bangumi_prefer'), '新的');
check('prefer: 源空短评不清空', mergeComment('', '旧的', 'bangumi_prefer'), '旧的');
check('overwrite: 源空短评清空目标', mergeComment('', '旧的', 'overwrite'), '');

// ── 隐私：target / source 双模式 ──
check(
  'target 模式统一写配置值',
  planBangumiPrivate({ mode: 'target', targetPrivate: true, sourceVisibility: 0 }),
  { private: true, reason: 'target' },
);
check(
  'source 模式：私密(2)→true',
  planBangumiPrivate({ mode: 'source', targetPrivate: false, sourceVisibility: 2 }),
  { private: true, reason: 'source-private' },
);
check(
  'source 模式：公开(0)→false',
  planBangumiPrivate({
    mode: 'source',
    targetPrivate: true,
    sourceVisibility: 0,
    existingPrivate: true,
  }),
  { private: false, reason: 'source-public' },
);
check(
  'source 模式：仅关注者(1)→false',
  planBangumiPrivate({ mode: 'source', targetPrivate: false, sourceVisibility: 1 }),
  { private: false, reason: 'source-public' },
);
check(
  'source 缺失：保留目标现值',
  planBangumiPrivate({
    mode: 'source',
    targetPrivate: false,
    sourceVisibility: undefined,
    existingPrivate: true,
  }),
  { private: true, reason: 'source-missing' },
);
check(
  'source 缺失且无目标：用配置兜底',
  planBangumiPrivate({ mode: 'source', targetPrivate: true, sourceVisibility: null }),
  { private: true, reason: 'source-missing' },
);

// ── 分集进度：OP/ED 可选纳入 ──
const episodesForThemes = [
  { id: 1, type: 0, sort: 1 },
  { id: 2, type: 1, sort: 2 },
  { id: 3, type: 2, sort: 3 },
  { id: 4, type: 3, sort: 4 },
];
check(
  'OP/ED 默认不纳入',
  planEpisodeProgress(episodesForThemes, new Map(), {
    isMovie: false,
    includeSp: false,
    collected: true,
  }).target,
  [1],
);
check(
  'OP/ED 开启后纳入 type 2/3',
  planEpisodeProgress(episodesForThemes, new Map(), {
    isMovie: false,
    includeSp: false,
    includeOpEd: true,
    collected: true,
  }).target,
  [1, 3, 4],
);
check(
  '电影永不纳入 OP/ED',
  planEpisodeProgress(episodesForThemes, new Map(), {
    isMovie: true,
    includeSp: true,
    includeOpEd: true,
    collected: true,
  }).target,
  [1],
);

// ── 书籍进度：迁移语义（sourceComplete=true）──
check(
  '迁移语义: 两维度都有总量则全拉满',
  planBookProgress(
    { ep_status: 0, vol_status: 0 },
    { eps: 12, volumes: 3 },
    { sourceComplete: true },
  ),
  { epStatus: 12, volStatus: 3, skip: false },
);
check(
  '迁移语义: 总量缺失的维度跳过',
  planBookProgress(
    { ep_status: 0, vol_status: 0 },
    { eps: 12 },
    { sourceComplete: true },
  ),
  { epStatus: 12, volStatus: undefined, skip: false },
);
check(
  '迁移语义: 两维度都无总量则 no-totals',
  planBookProgress({ ep_status: 0, vol_status: 0 }, {}, { sourceComplete: true }),
  { skip: true, reason: 'no-totals' },
);
check(
  '迁移语义: 已达上限不重写（幂等）',
  planBookProgress(
    { ep_status: 12, vol_status: 3 },
    { eps: 12, volumes: 3 },
    { sourceComplete: true },
  ),
  { skip: true, reason: 'nothing-to-write' },
);

// ── 书籍进度：原保守语义（sourceComplete 缺省）──
check(
  '保守语义: 0 视为未知不触碰',
  planBookProgress({ ep_status: 0, vol_status: 0 }, { eps: 12, volumes: 3 }),
  { skip: true, reason: 'both-unknown' },
);
check(
  '保守语义: 只拉满已知维度',
  planBookProgress({ ep_status: 5, vol_status: 0 }, { eps: 12, volumes: 3 }),
  { epStatus: 12, volStatus: undefined, skip: false },
);

if (failures > 0) {
  consola.error(`verify-mapping: ${failures} 项断言失败`);
  process.exitCode = 1;
} else {
  consola.info('verify-mapping: 全部通过');
}

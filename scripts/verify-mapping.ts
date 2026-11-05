/**
 * 离线断言状态/分类/字段映射表 —— 与 docs/mapping.md 逐行对应。
 */
import { consola } from 'consola';
import {
  isBangumiSupportedCategory,
  mapShelfType,
  mapVisibilityToPrivate,
  mergeComment,
  mergeRating,
  neodbCategoryToBangumiSubjectTypes,
} from '../src/rules/neodb-bangumi-mapping';
import { planBookProgress } from '../src/rules/bangumi-progress';

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

// ── 短评合并 ──
check('prefer: 目标非空保留', mergeComment('新的', '旧的', 'bangumi_prefer'), '旧的');
check('prefer: 目标空用源填充', mergeComment('新的', '', 'bangumi_prefer'), '新的');
check('prefer: 源空不清空', mergeComment('', '旧的', 'bangumi_prefer'), '旧的');
check('overwrite: 源覆盖含清空', mergeComment('', '旧的', 'overwrite'), '');

// ── 可见性 ──
check('visibility 2→private', mapVisibilityToPrivate(2), true);
check('visibility 0→public', mapVisibilityToPrivate(0), false);
check('visibility 缺失→public', mapVisibilityToPrivate(undefined), false);

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

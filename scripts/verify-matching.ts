/**
 * 用 fixture 断言三级匹配策略：外链提取、标题候选顺序、精确匹配、年份三态过滤。
 */
import { consola } from 'consola';
import {
  bangumiSubjectYear,
  exactMatches,
  extractBangumiSubjectId,
  neodbItemYear,
  pickExactMatchByYear,
  titleCandidates,
} from '../src/rules/neodb-bangumi-matching';
import type { BangumiSubject, NeodbItem } from '../src/types';

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

function subject(partial: Partial<BangumiSubject>): BangumiSubject {
  return {
    id: 1,
    type: 2,
    name: 'test',
    name_cn: '',
    ...partial,
  };
}

// ── 外链提取 ──
check(
  'bgm.tv 外链',
  extractBangumiSubjectId([{ url: 'https://bgm.tv/subject/12345' }]),
  12345,
);
check(
  'bangumi.tv 外链',
  extractBangumiSubjectId([{ url: 'http://bangumi.tv/subject/999' }]),
  999,
);
check(
  '无外链返回 null',
  extractBangumiSubjectId([{ url: 'https://movie.douban.com/subject/1/' }]),
  null,
);
check('空资源返回 null', extractBangumiSubjectId(undefined), null);

// ── 标题候选顺序与去重 ──
const item = {
  display_title: '千与千寻',
  title: 'Spirited Away',
  localized_title: [
    { lang: 'zh', text: '千与千寻' },
    { lang: 'ja', text: '千と千尋の神隠し' },
  ],
  year: 2001,
  pub_year: undefined,
} as unknown as NeodbItem;
check('候选顺序 display_title → title → localized_title，去重', titleCandidates(item), [
  '千与千寻',
  'Spirited Away',
  '千と千尋の神隠し',
]);

// ── 精确匹配 ──
const candidates = [
  subject({ id: 10, name: 'Spirited Away', name_cn: '千与千寻' }),
  subject({ id: 11, name: 'spirited away ', name_cn: '' }),
  subject({ id: 12, name: 'Other', name_cn: '千与千寻ova' }),
];
check(
  'name/name_cn 规范化后精确相等',
  exactMatches(candidates, '千与千寻').map((s) => s.id),
  [10],
);
check(
  '大小写与首尾空白不敏感',
  exactMatches(candidates, '  SPIRITED AWAY ').map((s) => s.id),
  [10, 11],
);

// ── 年份解析 ──
check(
  'air_year 优先',
  bangumiSubjectYear(subject({ air_year: 2001, date: '1999-01-01' })),
  2001,
);
check('date 回落', bangumiSubjectYear(subject({ date: '2001-07-20' })), 2001);
check('无年份', bangumiSubjectYear(subject({})), null);
check('NeoDB year', neodbItemYear({ year: 2001, pub_year: 2003 } as NeodbItem), 2001);
check('NeoDB 书籍 pub_year', neodbItemYear({ pub_year: 2003 } as NeodbItem), 2003);

// ── 年份三态过滤 ──
async function yearChecks(): Promise<void> {
  // 源年份未知 → 过滤不运行，取第一个候选
  const picked1 = await pickExactMatchByYear(candidates, null, 1);
  check(
    '源年份未知取第一个',
    picked1.status === 'matched' ? picked1.subject.id : null,
    10,
  );

  // 候选年份未知 → 通过
  const noYear = [subject({ id: 20, name: 'x', name_cn: '' })];
  const picked2 = await pickExactMatchByYear(noYear, 2001, 1);
  check(
    '候选年份未知通过',
    picked2.status === 'matched' ? picked2.subject.id : null,
    20,
  );

  // 双方都有且在容差内
  const year2001 = [subject({ id: 30, name: 'x', name_cn: '', air_year: 2001 })];
  const picked3 = await pickExactMatchByYear(year2001, 2002, 1);
  check(
    '年份差在容差内通过',
    picked3.status === 'matched' ? picked3.subject.id : null,
    30,
  );

  // 双方都有且超容差 → 拒绝
  const year1990 = [subject({ id: 31, name: 'x', name_cn: '', air_year: 1990 })];
  const picked4 = await pickExactMatchByYear(year1990, 2001, 1);
  check('年份超容差拒绝', picked4.status, 'no-candidate');

  // 第一个被拒后尝试下一个
  const mixed = [
    subject({ id: 40, name: 'x', name_cn: '', air_year: 1990 }),
    subject({ id: 41, name: 'x', name_cn: '', air_year: 2001 }),
  ];
  const picked5 = await pickExactMatchByYear(mixed, 2001, 1);
  check(
    '第一个被拒尝试下一个',
    picked5.status === 'matched' ? picked5.subject.id : null,
    41,
  );

  // 书籍（type 1）不参与年份过滤
  const book = [
    subject({ id: 50, type: 1, name: 'x', name_cn: '', date: '1999-01-01' }),
  ];
  const picked6 = await pickExactMatchByYear(book, 2020, 1);
  check(
    '书籍不参与年份过滤',
    picked6.status === 'matched' ? picked6.subject.id : null,
    50,
  );

  // 空候选
  check('空候选', (await pickExactMatchByYear([], 2001, 1)).status, 'no-candidate');
}

try {
  await yearChecks();
} catch (error) {
  failures += 1;
  consola.error('FAIL 年份过滤执行异常: ', error);
}

if (failures > 0) {
  consola.error(`verify-matching: ${failures} 项断言失败`);
  process.exitCode = 1;
} else {
  consola.info('verify-matching: 全部通过');
}

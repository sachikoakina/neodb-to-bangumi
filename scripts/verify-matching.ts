/**
 * 用 fixture 断言匹配策略：外链提取、标题候选顺序、精确匹配、年份三态、
 * 媒体形态冲突与多候选歧义。
 */
import { consola } from 'consola';
import {
  bangumiPlatformMediaForm,
  bangumiSubjectYear,
  exactMatches,
  extractBangumiSubjectId,
  neodbCategoryToMediaForm,
  neodbItemYear,
  pickExactMatch,
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

// ── 年份与媒体形态解析 ──
check(
  'air_year 优先',
  bangumiSubjectYear(subject({ air_year: 2001, date: '1999-01-01' })),
  2001,
);
check('date 回落', bangumiSubjectYear(subject({ date: '2001-07-20' })), 2001);
check('无年份', bangumiSubjectYear(subject({})), null);
check('NeoDB year', neodbItemYear({ year: 2001 } as NeodbItem), 2001);
check('NeoDB 书籍 pub_year', neodbItemYear({ pub_year: 2003 } as NeodbItem), 2003);

check('NeoDB movie → movie', neodbCategoryToMediaForm('movie'), 'movie');
check('NeoDB tv → tv', neodbCategoryToMediaForm('tv'), 'tv');
check('NeoDB book → 不可判定', neodbCategoryToMediaForm('book'), null);
check('平台剧场版 → movie', bangumiPlatformMediaForm('剧场版'), 'movie');
check('平台 TV → tv', bangumiPlatformMediaForm('TV'), 'tv');
check('平台 电视剧 → tv', bangumiPlatformMediaForm('电视剧'), 'tv');
check('平台 OVA → 不可判定', bangumiPlatformMediaForm('OVA'), null);
check('平台缺失 → 不可判定', bangumiPlatformMediaForm(undefined), null);

// ── 年份三态 + 歧义 ──
async function yearChecks(): Promise<void> {
  // 源年份未知 + 单候选 → 直接命中
  const single = [subject({ id: 10 })];
  const picked1 = await pickExactMatch(single, null, 1);
  check(
    '源年份未知单候选命中',
    picked1.status === 'matched' ? picked1.subject.id : null,
    10,
  );

  // 源年份未知 + 多候选 → 歧义（不再取第一个）
  const picked2 = await pickExactMatch(
    [subject({ id: 10 }), subject({ id: 11 })],
    null,
    1,
  );
  check('源年份未知多候选歧义', picked2.status, 'ambiguous');

  // 候选年份未知 + 单候选 → 通过
  const picked3 = await pickExactMatch([subject({ id: 20 })], 2001, 1);
  check(
    '候选年份未知单候选命中',
    picked3.status === 'matched' ? picked3.subject.id : null,
    20,
  );

  // 双方都有且在容差内
  const picked4 = await pickExactMatch([subject({ id: 30, air_year: 2001 })], 2002, 1);
  check(
    '年份差在容差内命中',
    picked4.status === 'matched' ? picked4.subject.id : null,
    30,
  );

  // 双方都有且超容差 → 拒绝
  const picked5 = await pickExactMatch([subject({ id: 31, air_year: 1990 })], 2001, 1);
  check('年份超容差拒绝', picked5.status, 'no-candidate');

  // 第一个被拒后尝试下一个
  const picked6 = await pickExactMatch(
    [subject({ id: 40, air_year: 1990 }), subject({ id: 41, air_year: 2001 })],
    2001,
    1,
  );
  check(
    '第一个被拒尝试下一个',
    picked6.status === 'matched' ? picked6.subject.id : null,
    41,
  );

  // 书籍（type 1）参与年份过滤；书籍容差单独放宽
  const book = [subject({ id: 50, type: 1, date: '1999-01-01' })];
  const picked7 = await pickExactMatch(book, 2020, 1);
  check('书籍超差拒绝', picked7.status, 'no-candidate');
  const bookNear = await pickExactMatch(book, 2000, 0, { bookTolerance: 1 });
  check(
    '书籍单独容差生效',
    bookNear.status === 'matched' ? bookNear.subject.id : null,
    50,
  );

  // 空候选
  check('空候选', (await pickExactMatch([], 2001, 1)).status, 'no-candidate');
}

// ── 媒体形态冲突 ──
async function mediaChecks(): Promise<void> {
  const movieCandidate = subject({
    id: 60,
    platform: '剧场版',
    air_year: 2001,
  });
  const tvCandidate = subject({ id: 61, platform: 'TV', air_year: 2001 });

  const picked = await pickExactMatch([movieCandidate, tvCandidate], 2001, 1, {
    mediaForm: 'tv',
  });
  check(
    'NeoDB tv 拒绝 Bangumi 剧场版，保留 TV',
    picked.status === 'matched' ? picked.subject.id : null,
    61,
  );

  const unknownPlatform = subject({ id: 62, platform: 'OVA', air_year: 2001 });
  const picked2 = await pickExactMatch([unknownPlatform], 2001, 1, {
    mediaForm: 'tv',
  });
  check(
    '平台不可判定时不拒绝',
    picked2.status === 'matched' ? picked2.subject.id : null,
    62,
  );

  // 国别剧平台（日剧/华语剧）归一为 tv 后，电影源的跨媒介候选必须被拒绝
  const jdrama = subject({ id: 63, platform: '日剧', air_year: 2001 });
  const rejected = await pickExactMatch([jdrama], 2001, 1, {
    mediaForm: 'movie',
  });
  check('源 movie 拒绝日剧候选', rejected.status, 'no-candidate');

  // 同年同形态多候选 → 歧义
  const picked3 = await pickExactMatch(
    [
      subject({ id: 70, platform: 'TV', air_year: 2001 }),
      subject({ id: 71, platform: 'TV', air_year: 2001 }),
    ],
    2001,
    1,
    { mediaForm: 'tv' },
  );
  check('同年同形态多候选歧义', picked3.status, 'ambiguous');
}

// ── 证据严格模式（SYNC_MATCH_STRICT=1）──
async function strictChecks(): Promise<void> {
  // 唯一候选年份未知 + 平台不可判定 → 持留，不写入
  const held = await pickExactMatch([subject({ id: 100 })], 2002, 1, {
    strict: true,
  });
  check(
    'strict：唯一候选证据不足 → 持留',
    held.status === 'ambiguous' && held.hold === 'insufficient-evidence',
    true,
  );

  // 同一候选关闭 strict → 命中（旧行为保留）
  const loose = await pickExactMatch([subject({ id: 101 })], 2002, 1);
  check(
    '非 strict：证据缺失照写（旧行为）',
    loose.status === 'matched' ? loose.subject.id : null,
    101,
  );

  // 年份经双方核对（容差内）→ 命中
  const verified = await pickExactMatch(
    [subject({ id: 102, air_year: 2001 })],
    2001,
    1,
    {
      strict: true,
    },
  );
  check(
    'strict：年份核对通过 → 命中',
    verified.status === 'matched' ? verified.subject.id : null,
    102,
  );

  // 影视年份缺失：形态互证不足以定案 → ambiguous + year-missing
  const formHeld = await pickExactMatch(
    [subject({ id: 103, platform: '剧场版' })],
    null,
    1,
    {
      strict: true,
      mediaForm: 'movie',
    },
  );
  check(
    'strict：影视年份缺失 → year-missing',
    formHeld.status === 'ambiguous' && formHeld.hold === 'year-missing',
    true,
  );

  // 书籍候选年份核对通过 → 命中；年份无法核对 → 持留
  const book = await pickExactMatch(
    [subject({ id: 104, type: 1, date: '2002-01-01' })],
    2002,
    1,
    {
      strict: true,
    },
  );
  check(
    'strict：书籍年份核对通过 → 命中',
    book.status === 'matched' ? book.subject.id : null,
    104,
  );
  const bookHeld = await pickExactMatch([subject({ id: 105, type: 1 })], 2002, 1, {
    strict: true,
  });
  check(
    'strict：书籍年份无法核对 → 持留',
    bookHeld.status === 'ambiguous' && bookHeld.hold === 'insufficient-evidence',
    true,
  );
}

try {
  await yearChecks();
  await mediaChecks();
  await strictChecks();
} catch (error) {
  failures += 1;
  consola.error('FAIL 匹配断言执行异常: ', error);
}

if (failures > 0) {
  consola.error(`verify-matching: ${failures} 项断言失败`);
  process.exitCode = 1;
} else {
  consola.info('verify-matching: 全部通过');
}

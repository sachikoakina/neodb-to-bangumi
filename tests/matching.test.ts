import { describe, expect, it } from 'vitest';
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

function subject(partial: Partial<BangumiSubject>): BangumiSubject {
  return { id: 1, type: 2, name: 'test', name_cn: '', ...partial };
}

describe('外链提取', () => {
  it('识别 bgm.tv 与 bangumi.tv 的 subject 链接', () => {
    expect(extractBangumiSubjectId([{ url: 'https://bgm.tv/subject/12345' }])).toBe(
      12345,
    );
    expect(extractBangumiSubjectId([{ url: 'http://bangumi.tv/subject/999' }])).toBe(
      999,
    );
  });

  it('其他平台与空资源返回 null', () => {
    expect(
      extractBangumiSubjectId([{ url: 'https://movie.douban.com/subject/1/' }]),
    ).toBeNull();
    expect(extractBangumiSubjectId(undefined)).toBeNull();
  });
});

describe('标题候选', () => {
  it('顺序 display_title → title → localized_title，且规范化去重', () => {
    const item = {
      display_title: '千与千寻',
      title: 'Spirited Away',
      localized_title: [
        { lang: 'zh', text: '千与千寻' },
        { lang: 'ja', text: '千と千尋の神隠し' },
      ],
    } as unknown as NeodbItem;
    expect(titleCandidates(item)).toEqual([
      '千与千寻',
      'Spirited Away',
      '千と千尋の神隠し',
    ]);
  });
});

describe('精确匹配', () => {
  const candidates = [
    subject({ id: 10, name: 'Spirited Away', name_cn: '千与千寻' }),
    subject({ id: 11, name: 'spirited away ', name_cn: '' }),
  ];

  it('name/name_cn 规范化后完全相等', () => {
    expect(exactMatches(candidates, '千与千寻').map((s) => s.id)).toEqual([10]);
    expect(exactMatches(candidates, '  SPIRITED AWAY ').map((s) => s.id)).toEqual([
      10, 11,
    ]);
  });

  it('空关键词无匹配', () => {
    expect(exactMatches(candidates, '   ')).toEqual([]);
  });
});

describe('年份与媒体形态解析', () => {
  it('air_year 优先，date 回落', () => {
    expect(bangumiSubjectYear(subject({ air_year: 2001, date: '1999-01-01' }))).toBe(
      2001,
    );
    expect(bangumiSubjectYear(subject({ date: '2001-07-20' }))).toBe(2001);
    expect(bangumiSubjectYear(subject({}))).toBeNull();
  });

  it('NeoDB 侧 year / pub_year', () => {
    expect(neodbItemYear({ year: 2001 } as NeodbItem)).toBe(2001);
    expect(neodbItemYear({ pub_year: 2003 } as NeodbItem)).toBe(2003);
    expect(neodbItemYear({} as NeodbItem)).toBeNull();
  });

  it('NeoDB 分类 → 媒体形态', () => {
    expect(neodbCategoryToMediaForm('movie')).toBe('movie');
    expect(neodbCategoryToMediaForm('tv')).toBe('tv');
    expect(neodbCategoryToMediaForm('book')).toBeNull();
    expect(neodbCategoryToMediaForm(undefined)).toBeNull();
  });

  it('Bangumi 平台 → 媒体形态（保守识别）', () => {
    expect(bangumiPlatformMediaForm('剧场版')).toBe('movie');
    expect(bangumiPlatformMediaForm('电影')).toBe('movie');
    expect(bangumiPlatformMediaForm('TV')).toBe('tv');
    expect(bangumiPlatformMediaForm('Web')).toBe('tv');
    expect(bangumiPlatformMediaForm('电视剧')).toBe('tv');
    expect(bangumiPlatformMediaForm('OVA')).toBeNull();
    expect(bangumiPlatformMediaForm(undefined)).toBeNull();
  });
});

describe('候选裁决（年份三态 + 歧义）', () => {
  it('源年份未知：单候选命中，多候选歧义（不再取第一个）', async () => {
    const single = await pickExactMatch([subject({ id: 10 })], null, 1);
    expect(single).toEqual({
      status: 'matched',
      subject: expect.objectContaining({ id: 10 }),
    });

    const multiple = await pickExactMatch(
      [subject({ id: 10 }), subject({ id: 11 })],
      null,
      1,
    );
    expect(multiple.status).toBe('ambiguous');
  });

  it('候选年份未知：单候选通过', async () => {
    const picked = await pickExactMatch([subject({ id: 20 })], 2001, 1);
    expect(picked).toEqual({
      status: 'matched',
      subject: expect.objectContaining({ id: 20 }),
    });
  });

  it('双方都有：容差内通过，超容差拒绝', async () => {
    const ok = await pickExactMatch([subject({ id: 30, air_year: 2001 })], 2002, 1);
    expect(ok.status).toBe('matched');
    const rejected = await pickExactMatch(
      [subject({ id: 31, air_year: 1990 })],
      2001,
      1,
    );
    expect(rejected.status).toBe('no-candidate');
  });

  it('第一个被拒后继续尝试下一个', async () => {
    const picked = await pickExactMatch(
      [subject({ id: 40, air_year: 1990 }), subject({ id: 41, air_year: 2001 })],
      2001,
      1,
    );
    expect(picked).toEqual({
      status: 'matched',
      subject: expect.objectContaining({ id: 41 }),
    });
  });

  it('书籍/音乐/游戏不参与年份过滤', async () => {
    const picked = await pickExactMatch(
      [subject({ id: 50, type: 1, date: '1999-01-01' })],
      2020,
      1,
    );
    expect(picked).toEqual({
      status: 'matched',
      subject: expect.objectContaining({ id: 50 }),
    });
  });

  it('空候选 → no-candidate', async () => {
    expect((await pickExactMatch([], 2001, 1)).status).toBe('no-candidate');
  });
});

describe('媒体形态裁决', () => {
  it('NeoDB tv 拒绝 Bangumi 剧场版，保留 TV', async () => {
    const picked = await pickExactMatch(
      [
        subject({ id: 60, platform: '剧场版', air_year: 2001 }),
        subject({ id: 61, platform: 'TV', air_year: 2001 }),
      ],
      2001,
      1,
      { mediaForm: 'tv' },
    );
    expect(picked).toEqual({
      status: 'matched',
      subject: expect.objectContaining({ id: 61 }),
    });
  });

  it('平台不可判定（OVA/缺失）时不拒绝', async () => {
    const picked = await pickExactMatch(
      [subject({ id: 62, platform: 'OVA', air_year: 2001 })],
      2001,
      1,
      { mediaForm: 'tv' },
    );
    expect(picked.status).toBe('matched');
  });

  it('同年同形态多候选 → 歧义', async () => {
    const picked = await pickExactMatch(
      [
        subject({ id: 70, platform: 'TV', air_year: 2001 }),
        subject({ id: 71, platform: 'TV', air_year: 2001 }),
      ],
      2001,
      1,
      { mediaForm: 'tv' },
    );
    expect(picked.status).toBe('ambiguous');
  });

  it('年份更接近者胜出', async () => {
    const picked = await pickExactMatch(
      [
        subject({ id: 80, platform: 'TV', air_year: 2001 }),
        subject({ id: 81, platform: 'TV', air_year: 2000 }),
      ],
      2001,
      2,
      { mediaForm: 'tv' },
    );
    expect(picked).toEqual({
      status: 'matched',
      subject: expect.objectContaining({ id: 80 }),
    });
  });

  it('自定义证据读取器优先于内置解析', async () => {
    const picked = await pickExactMatch([subject({ id: 90, name_cn: 'x' })], 2001, 1, {
      resolveEvidence: () => ({ year: 2001, mediaForm: 'tv' }),
    });
    expect(picked.status).toBe('matched');
  });
});

import { describe, expect, it } from 'vitest';
import {
  absoluteNeodbUrl,
  DEFAULT_NEODB_BASE_URL,
  displayName,
} from '../src/rules/neodb-display';
import type { NeodbItem } from '../src/types';

/** 只填展示相关的字段，其余字段与被测纯函数无关。 */
function item(
  partial: Partial<
    Pick<NeodbItem, 'display_title' | 'title' | 'uuid' | 'localized_title'>
  > = {},
): Pick<NeodbItem, 'display_title' | 'title' | 'uuid' | 'localized_title'> {
  return {
    display_title: '',
    title: '',
    uuid: 'uuid-fallback',
    ...partial,
  };
}

describe('displayName —— 名称取 NeoDB 首个本地化名称', () => {
  it('英文 display_title + 中文 localized_title 时取中文名（14 Blades → 锦衣卫）', () => {
    expect(
      displayName(
        item({
          display_title: '14 Blades',
          title: '14 Blades',
          localized_title: [
            { lang: 'en', text: '14 Blades' },
            { lang: 'zh-cn', text: '锦衣卫' },
          ],
        }),
      ),
    ).toBe('锦衣卫');
  });

  it('多个中文项时取第一个 zh* 项', () => {
    expect(
      displayName(
        item({
          localized_title: [
            { lang: 'zh-hant', text: '錦衣衛' },
            { lang: 'zh-cn', text: '锦衣卫' },
          ],
        }),
      ),
    ).toBe('錦衣衛');
  });

  it('lang 大小写不敏感，且 text 会 trim', () => {
    expect(
      displayName(
        item({
          localized_title: [{ lang: 'ZH-Hans', text: '  锦衣卫  ' }],
        }),
      ),
    ).toBe('锦衣卫');
  });

  it('没有中文项时取首个本地化项', () => {
    expect(
      displayName(
        item({
          display_title: '14 Blades',
          localized_title: [
            { lang: 'en', text: '14 Blades' },
            { lang: 'ja', text: '14 Blades 日本語' },
          ],
        }),
      ),
    ).toBe('14 Blades');
  });

  it('本地化项 text 为空白时跳过，回退 display_title', () => {
    expect(
      displayName(
        item({
          display_title: 'Spirited Away',
          localized_title: [
            { lang: 'zh', text: '   ' },
            { lang: 'ja', text: '' },
          ],
        }),
      ),
    ).toBe('Spirited Away');
  });

  it('localized_title 为空数组时回退 display_title', () => {
    expect(displayName(item({ display_title: 'Dune', localized_title: [] }))).toBe(
      'Dune',
    );
  });

  it('display_title 为空时回退 title', () => {
    expect(displayName(item({ display_title: '  ', title: '沙丘' }))).toBe('沙丘');
  });

  it('display_title 与 title 都为空时回退 uuid', () => {
    expect(displayName(item({ uuid: '3IFQp20nMweuIdKwGoDdtN' }))).toBe(
      '3IFQp20nMweuIdKwGoDdtN',
    );
  });

  it('lang 缺失时按非中文项处理，但仍可作为首个本地化项', () => {
    expect(
      displayName(
        item({
          display_title: 'Original',
          localized_title: [{ text: '无名语言名' }],
        }),
      ),
    ).toBe('无名语言名');
  });
});

describe('absoluteNeodbUrl —— 站内相对链接补成绝对地址', () => {
  it('相对路径按 baseUrl 拼全（回归用例：/movie/xxx）', () => {
    expect(
      absoluteNeodbUrl('/movie/3IFQp20nMweuIdKwGoDdtN', 'https://neodb.social'),
    ).toBe('https://neodb.social/movie/3IFQp20nMweuIdKwGoDdtN');
  });

  it('已是 http(s):// 的地址原样保留', () => {
    expect(
      absoluteNeodbUrl(
        'https://neodb.social/movie/3IFQp20nMweuIdKwGoDdtN',
        'https://example.com',
      ),
    ).toBe('https://neodb.social/movie/3IFQp20nMweuIdKwGoDdtN');
    expect(absoluteNeodbUrl('http://neodb.social/book/1', 'https://example.com')).toBe(
      'http://neodb.social/book/1',
    );
  });

  it('自建实例：按传入 baseUrl 拼全', () => {
    expect(absoluteNeodbUrl('/tv/xyz', 'https://neodb.example.org')).toBe(
      'https://neodb.example.org/tv/xyz',
    );
  });

  it('baseUrl 带尾斜杠、相对路径带多个前导斜杠都不重复拼斜杠', () => {
    expect(absoluteNeodbUrl('///movie/abc', 'https://neodb.example.org///')).toBe(
      'https://neodb.example.org/movie/abc',
    );
  });

  it('baseUrl 为空/缺省/空白时回退官方域名', () => {
    expect(absoluteNeodbUrl('/movie/abc', '')).toBe('https://neodb.social/movie/abc');
    expect(absoluteNeodbUrl('/movie/abc')).toBe('https://neodb.social/movie/abc');
    expect(absoluteNeodbUrl('/movie/abc', '   ')).toBe(
      'https://neodb.social/movie/abc',
    );
    expect(DEFAULT_NEODB_BASE_URL).toBe('https://neodb.social');
  });

  it('raw 为空串/undefined/空白时返回空串（调用方渲染「（无链接）」）', () => {
    expect(absoluteNeodbUrl('', 'https://neodb.social')).toBe('');
    expect(absoluteNeodbUrl(undefined, 'https://neodb.social')).toBe('');
    expect(absoluteNeodbUrl('   ', 'https://neodb.social')).toBe('');
  });
});

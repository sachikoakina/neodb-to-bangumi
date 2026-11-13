import { describe, expect, it } from 'vitest';
import { extractIsbns, normalizeIsbn } from '../src/rules/isbn';
import type { BangumiSubject } from '../src/types';

function subject(partial: Partial<BangumiSubject>): BangumiSubject {
  return { id: 1, type: 1, name: 'test', name_cn: '', ...partial };
}

describe('ISBN 归一化', () => {
  it('13 位原样返回，带连字符/空格也能识别', () => {
    expect(normalizeIsbn('9784047376465')).toBe('9784047376465');
    expect(normalizeIsbn('978-4-04-737646-5')).toBe('9784047376465');
    expect(normalizeIsbn(' 978 4047 376465 ')).toBe('9784047376465');
  });

  it('10 位转 13 位，便于与 13 位直接比较', () => {
    expect(normalizeIsbn('4047376469')).toBe('9784047376465');
    expect(normalizeIsbn('4-04-737646-9')).toBe('9784047376465');
  });

  it('校验位错误一律视为不可用', () => {
    expect(normalizeIsbn('9784047376466')).toBeNull();
    expect(normalizeIsbn('4047376468')).toBeNull();
  });

  it('长度不对 / 空值 / 非数字返回 null', () => {
    expect(normalizeIsbn('123')).toBeNull();
    expect(normalizeIsbn('')).toBeNull();
    expect(normalizeIsbn(null)).toBeNull();
    expect(normalizeIsbn(undefined)).toBeNull();
  });
});

describe('候选 ISBN 提取', () => {
  it('主 ISBN 与「版本:*」子项都会被收进来', () => {
    const isbns = extractIsbns(
      subject({
        infobox: [
          { key: 'ISBN', value: '978-4-04-737646-5' },
          {
            key: '版本:天角版',
            value: [
              { k: '版本名', v: '九井谅子涂鸦集 白日梦时间' },
              { k: 'ISBN', v: '9787513356756' },
            ],
          },
        ],
      }),
    );
    expect(isbns).toEqual(['9784047376465', '9787513356756']);
  });

  it('非法 ISBN 被跳过，重复值只保留一次', () => {
    const isbns = extractIsbns(
      subject({
        infobox: [
          { key: 'ISBN', value: '9784047376465' },
          { key: '版本:青文版', value: [{ k: 'ISBN', v: '9784047376465' }] },
          { key: '版本:坏数据', value: [{ k: 'ISBN', v: '123' }] },
        ],
      }),
    );
    expect(isbns).toEqual(['9784047376465']);
  });

  it('没有 infobox 时返回空数组', () => {
    expect(extractIsbns(subject({}))).toEqual([]);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { readSubjectCached } from '../src/paths/neodb-to-bangumi';
import type { BangumiSubject, ReadResult } from '../src/types';

function subject(id: number): BangumiSubject {
  return { id, type: 2, name: `name-${id}`, name_cn: `cn-${id}` };
}

function found(id: number): ReadResult<BangumiSubject> {
  return { status: 'found', value: subject(id) };
}

describe('条目读取缓存', () => {
  it('同一 subject 在同一轮只发一次请求', async () => {
    const cache = new Map<number, BangumiSubject>();
    const read = vi.fn(async (id: number) => found(id));

    const first = await readSubjectCached(42, cache, read);
    const second = await readSubjectCached(42, cache, read);

    expect(read).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(first.status).toBe('found');
    expect(cache.size).toBe(1);
  });

  it('失败不写缓存：下一轮仍会重试', async () => {
    const cache = new Map<number, BangumiSubject>();
    const read = vi.fn(async (): Promise<ReadResult<BangumiSubject>> => ({
      status: 'error',
      scope: 'item',
      message: 'subject 7 returned 500',
    }));

    const first = await readSubjectCached(7, cache, read);
    const second = await readSubjectCached(7, cache, read);

    expect(read).toHaveBeenCalledTimes(2);
    expect(cache.size).toBe(0);
    expect(first).toEqual({
      status: 'error',
      scope: 'item',
      message: 'subject 7 returned 500',
    });
    expect(second.status).toBe('error');
  });

  it('失败不污染同 id 的后续成功读取', async () => {
    const cache = new Map<number, BangumiSubject>();
    const read = vi
      .fn<() => Promise<ReadResult<BangumiSubject>>>()
      .mockResolvedValueOnce({
        status: 'error',
        scope: 'item',
        message: 'boom',
      })
      .mockResolvedValueOnce(found(9));

    await readSubjectCached(9, cache, read);
    const second = await readSubjectCached(9, cache, read);

    expect(second).toEqual(found(9));
    expect(cache.get(9)?.id).toBe(9);
  });

  it('不同 subject 各自缓存，互不串味', async () => {
    const cache = new Map<number, BangumiSubject>();
    const read = vi.fn(async (id: number) => found(id));

    await readSubjectCached(1, cache, read);
    await readSubjectCached(2, cache, read);
    await readSubjectCached(1, cache, read);

    expect(read).toHaveBeenCalledTimes(2);
    expect([...cache.keys()].sort()).toEqual([1, 2]);
  });

  it('保留三态：能区分「读取失败」与「条目不存在」', async () => {
    const cache = new Map<number, BangumiSubject>();
    const absent = vi.fn(async (): Promise<ReadResult<BangumiSubject>> => ({
      status: 'error',
      scope: 'item',
      message: 'subject 404',
    }));
    const result = await readSubjectCached(404, cache, absent);
    expect(result.status).toBe('error');
    expect(result.status === 'error' && result.message).toContain('404');
  });
});

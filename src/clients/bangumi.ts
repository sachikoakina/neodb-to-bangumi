/**
 * Bangumi 客户端 —— api.bgm.tv v0 端点。
 *
 * 只放传输与端点；分制换算、标题比较、年份过滤等**事实性逻辑**都在
 * `rules/`，保持纯函数可离线断言。
 */
import got, { HTTPError } from 'got';
import { consola } from 'consola';
import {
  BGM_API,
  authHeaders,
  bangumiThrottle,
  bangumiToken,
  isUnauthorized,
  logUnauthorized,
} from './bangumi-http';
import { classifyReadFailure } from '../rules/read-result';
import type {
  BangumiCollection,
  BangumiEpisode,
  BangumiEpisodeState,
  BangumiSubject,
  BangumiSubjectType,
  BangumiUser,
  ReadResult,
} from '../types';

/** GET /v0/me —— 当前账号；拿不到 username 就无法读收藏，因此失败返回 null。 */
export async function getBangumiMe(): Promise<BangumiUser | null> {
  if (!bangumiToken) {
    return null;
  }
  try {
    return (await got(`${BGM_API}/v0/me`, {
      headers: authHeaders(),
    }).json()) as BangumiUser;
  } catch (error) {
    if (isUnauthorized(error)) {
      logUnauthorized();
    } else {
      consola.error('读取 Bangumi /v0/me 失败: ', error);
    }
    return null;
  }
}

/**
 * 完整条目详情（含书籍的 `eps` / `volumes` 总量）。
 *
 * 404 表示条目本身不存在，是条目级失败 —— 「没有平台」与「没有条目」不能混。
 */
export async function getBangumiSubject(
  subjectId: number,
): Promise<ReadResult<BangumiSubject>> {
  if (!bangumiToken) {
    return {
      status: 'error',
      scope: 'auth',
      message: 'BANGUMI_ACCESS_TOKEN is not set',
    };
  }
  try {
    return {
      status: 'found',
      value: (await got(`${BGM_API}/v0/subjects/${subjectId}`, {
        headers: authHeaders(),
      }).json()) as BangumiSubject,
    };
  } catch (error) {
    const status = error instanceof HTTPError ? error.response.statusCode : null;
    const kind = classifyReadFailure(status, 'item');
    if (kind === 'auth') {
      logUnauthorized();
      return {
        status: 'error',
        scope: 'auth',
        message: `subject ${subjectId} returned ${status ?? 'no response'}`,
      };
    }
    consola.error(`读取 Bangumi 条目 ${subjectId} 失败: `, error);
    return {
      status: 'error',
      scope: 'item',
      message: `subject ${subjectId} returned ${status ?? 'no response'}`,
    };
  }
}

/**
 * 当前用户对某条目的收藏。
 *
 * `absent` = 用户没有收藏这个主体，是唯一可以据此**新建**的读法。404 是这个
 * 答案；401 或 5xx 不是 —— 拒绝回答不能被当成空记录去覆盖。
 */
export async function getBangumiCollection(
  username: string,
  subjectId: number,
): Promise<ReadResult<BangumiCollection>> {
  if (!bangumiToken) {
    return {
      status: 'error',
      scope: 'auth',
      message: 'BANGUMI_ACCESS_TOKEN is not set',
    };
  }
  try {
    return {
      status: 'found',
      value: (await got(`${BGM_API}/v0/users/${username}/collections/${subjectId}`, {
        headers: authHeaders(),
      }).json()) as BangumiCollection,
    };
  } catch (error) {
    const status = error instanceof HTTPError ? error.response.statusCode : null;
    const kind = classifyReadFailure(status);
    if (kind === 'auth') {
      logUnauthorized();
      return {
        status: 'error',
        scope: 'auth',
        message: `collection ${subjectId} returned ${status ?? 'no response'}`,
      };
    }
    if (kind === 'absent') {
      return { status: 'absent' };
    }
    consola.error(`读取 Bangumi 收藏 ${subjectId} 失败: `, error);
    return {
      status: 'error',
      scope: 'item',
      message: `collection ${subjectId} returned ${status ?? 'no response'}`,
    };
  }
}

/**
 * 新建或更新一条收藏（状态/评分/短评/可见性/书籍进度）。
 * 服务端把 `updated_at` 设为该次请求的处理时间；客户端无法指定时间。
 */
export async function upsertBangumiCollection(
  subjectId: number,
  payload: {
    type: BangumiCollection['type'];
    rate?: number;
    comment?: string;
    private?: boolean;
    /** 仅书籍使用的进度。 */
    ep_status?: number;
    vol_status?: number;
  },
): Promise<boolean> {
  if (!bangumiToken) {
    return false;
  }
  try {
    await got.post(`${BGM_API}/v0/users/-/collections/${subjectId}`, {
      headers: authHeaders(),
      json: payload,
    });
    return true;
  } catch (error) {
    if (isUnauthorized(error)) {
      logUnauthorized();
    } else {
      consola.error(`写入 Bangumi 收藏 ${subjectId} 失败: `, error);
    }
    return false;
  }
}

/** 分页读取条目分集。 */
export async function getBangumiEpisodes(
  subjectId: number,
): Promise<ReadResult<BangumiEpisode[]>> {
  if (!bangumiToken) {
    return {
      status: 'error',
      scope: 'auth',
      message: 'BANGUMI_ACCESS_TOKEN is not set',
    };
  }
  const episodes: BangumiEpisode[] = [];
  let offset = 0;
  try {
    while (true) {
      await bangumiThrottle();
      const page = (await got(`${BGM_API}/v0/episodes`, {
        headers: authHeaders(),
        searchParams: { subject_id: subjectId, limit: 200, offset },
      }).json()) as { data?: BangumiEpisode[]; total?: number };
      const data = page.data ?? [];
      episodes.push(...data);
      offset += data.length;
      if (data.length < 200 || offset >= (page.total ?? offset)) break;
    }
    return { status: 'found', value: episodes };
  } catch (error) {
    const status = error instanceof HTTPError ? error.response.statusCode : null;
    if (classifyReadFailure(status) === 'auth') {
      logUnauthorized();
      return {
        status: 'error',
        scope: 'auth',
        message: `episodes ${subjectId} returned ${status ?? 'no response'}`,
      };
    }
    consola.error(`读取 Bangumi 分集 ${subjectId} 失败: `, error);
    return {
      status: 'error',
      scope: 'item',
      message: `episodes ${subjectId} returned ${status ?? 'no response'}`,
    };
  }
}

/** 当前用户某条目的分集收藏状态。 */
export async function getBangumiEpisodeStates(
  subjectId: number,
): Promise<ReadResult<Map<number, BangumiEpisodeState>>> {
  if (!bangumiToken) {
    return {
      status: 'error',
      scope: 'auth',
      message: 'BANGUMI_ACCESS_TOKEN is not set',
    };
  }
  const states = new Map<number, BangumiEpisodeState>();
  let offset = 0;
  try {
    while (true) {
      await bangumiThrottle();
      const page = (await got(
        `${BGM_API}/v0/users/-/collections/${subjectId}/episodes`,
        {
          headers: authHeaders(),
          searchParams: { limit: 1000, offset },
        },
      ).json()) as {
        data?: Array<{ episode?: { id?: number }; type?: number; updated_at?: number }>;
        total?: number;
      };
      const data = page.data ?? [];
      for (const row of data) {
        if (row.episode?.id != null && row.type != null) {
          states.set(row.episode.id, { type: row.type, updatedAt: row.updated_at });
        }
      }
      offset += data.length;
      if (data.length < 1000 || offset >= (page.total ?? offset)) break;
    }
    return { status: 'found', value: states };
  } catch (error) {
    const status = error instanceof HTTPError ? error.response.statusCode : null;
    if (classifyReadFailure(status) === 'auth') {
      logUnauthorized();
      return {
        status: 'error',
        scope: 'auth',
        message: `episode states ${subjectId} returned ${status ?? 'no response'}`,
      };
    }
    consola.error(`读取 Bangumi 分集状态 ${subjectId} 失败: `, error);
    return {
      status: 'error',
      scope: 'item',
      message: `episode states ${subjectId} returned ${status ?? 'no response'}`,
    };
  }
}

/** 标记单集看过；时间由服务端写入。已看过的集调用方不应再发本请求。 */
export async function markBangumiEpisodeWatched(
  subjectId: number,
  episodeId: number,
): Promise<boolean> {
  if (!bangumiToken) return false;
  try {
    await bangumiThrottle();
    await got.put(`${BGM_API}/v0/users/-/collections/-/episodes/${episodeId}`, {
      headers: authHeaders(),
      json: { type: 2 },
    });
    return true;
  } catch (error) {
    if (isUnauthorized(error)) {
      logUnauthorized();
    } else {
      consola.error(`标记 Bangumi 分集 ${subjectId}/${episodeId} 失败: `, error);
    }
    return false;
  }
}

/**
 * 按关键词与类型搜索条目。
 *
 * 返回 `ReadResult` 而不是空数组：请求失败与「真的没有结果」不是同一件事，
 * 把前者伪装成空结果会让条目被误记为 unresolved（数据缺口），而不是 failed
 * （可重跑）。401/403 归为 auth，由调用方中止链路。
 */
export async function searchBangumiSubjects(
  keyword: string,
  types?: BangumiSubjectType[],
  limit = 10,
): Promise<ReadResult<BangumiSubject[]>> {
  if (!bangumiToken) {
    return {
      status: 'error',
      scope: 'auth',
      message: 'BANGUMI_ACCESS_TOKEN is not set',
    };
  }
  try {
    const body: {
      keyword: string;
      filter?: { type?: BangumiSubjectType[] };
    } = { keyword };
    if (types?.length) {
      body.filter = { type: types };
    }
    const result = (await got
      .post(`${BGM_API}/v0/search/subjects`, {
        headers: authHeaders(),
        searchParams: { limit, offset: 0 },
        json: body,
      })
      .json()) as { data?: BangumiSubject[] };
    return { status: 'found', value: result.data || [] };
  } catch (error) {
    const status = error instanceof HTTPError ? error.response.statusCode : null;
    if (classifyReadFailure(status) === 'auth') {
      logUnauthorized();
      return {
        status: 'error',
        scope: 'auth',
        message: `search "${keyword}" returned ${status ?? 'no response'}`,
      };
    }
    consola.error(`搜索 Bangumi 条目失败（${keyword}）: `, error);
    return {
      status: 'error',
      scope: 'item',
      message: `search "${keyword}" returned ${status ?? 'no response'}`,
    };
  }
}

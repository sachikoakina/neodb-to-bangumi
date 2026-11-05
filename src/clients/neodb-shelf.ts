/**
 * NeoDB 书架客户端 —— 只读：凭据校验、账号、书架分页、条目详情。
 *
 * 失败时返回 `null` 而不是空数组：调用方必须能区分「出错」与「空页」，
 * 否则一次网络故障会被当成书架到头，静默截断迁移范围。
 */
import { HTTPError } from 'got';
import { consola } from 'consola';
import {
  logNeodbUnauthorized,
  neodbAuthHeaders,
  neodbClient,
  neodbFailureCode,
  neodbThrottle,
  neodbToken,
} from './neodb-http';
import type { NeodbItem, NeodbMe, NeodbPagedMark, ShelfType } from '../types';

/** GET /api/token —— 整轮运行前低成本校验凭据。 */
export async function verifyNeodbToken(): Promise<boolean> {
  if (!neodbToken) {
    return false;
  }
  try {
    await neodbClient('api/token', { headers: neodbAuthHeaders() });
    return true;
  } catch (error) {
    if (error instanceof HTTPError && error.response.statusCode === 401) {
      logNeodbUnauthorized();
    } else {
      consola.error('NeoDB token 校验失败: ', neodbFailureCode(error));
    }
    return false;
  }
}

/** GET /api/me —— 当前账号。 */
export async function getNeodbMe(): Promise<NeodbMe | null> {
  if (!neodbToken) {
    return null;
  }
  try {
    return (await neodbClient('api/me', {
      headers: neodbAuthHeaders(),
    }).json()) as NeodbMe;
  } catch (error) {
    if (error instanceof HTTPError && error.response.statusCode === 401) {
      logNeodbUnauthorized();
    } else {
      consola.error('读取 NeoDB 账号失败: ', neodbFailureCode(error));
    }
    return null;
  }
}

/**
 * GET /api/me/shelf/{type} 的一页。
 *
 * `type` 是**路径参数**而非查询参数 —— 这是最容易踩的集成坑，因此显式拼接 URL。
 */
export async function fetchShelfPage(options: {
  shelfType: ShelfType;
  page: number;
}): Promise<NeodbPagedMark | null> {
  if (!neodbToken) {
    return null;
  }
  try {
    const result = (await neodbClient(`api/me/shelf/${options.shelfType}`, {
      headers: neodbAuthHeaders(),
      searchParams: { page: options.page },
    }).json()) as NeodbPagedMark;

    // 防御性处理：结构已实测，但代理或分支实现可能不同。返回 null 让遍历方
    // 把这次书架标成截断，而不是悄悄假装到头了。
    if (!Array.isArray(result?.data)) {
      consola.warn(
        `书架 ${options.shelfType} 第 ${options.page} 页响应结构异常；中止该书架。`,
      );
      return null;
    }
    return result;
  } catch (error) {
    if (error instanceof HTTPError && error.response.statusCode === 401) {
      logNeodbUnauthorized();
    } else if (error instanceof HTTPError && error.response.statusCode === 404) {
      consola.warn(`书架 ${options.shelfType} 返回 404 —— 该实例上可能不存在。`);
    } else {
      consola.error(
        `读取书架 ${options.shelfType} 第 ${options.page} 页失败: `,
        neodbFailureCode(error),
      );
    }
    return null;
  }
}

export type ShelfPageVisitor = (
  marks: NeodbPagedMark['data'],
) => boolean | Promise<boolean>;

/**
 * 遍历某个书架的全部分页，把每一页交给 `visit`。
 *
 * - `visit` 返回 `false` 表示调用方主动停止（条目配额已满），这**不是**截断；
 * - 失败或畸形页返回 `{ truncated: true }`，让上层在摘要里如实标注覆盖不完整。
 */
export async function walkShelfPages(
  shelfType: ShelfType,
  maxPages: number,
  visit: ShelfPageVisitor,
  fetchPage: typeof fetchShelfPage = fetchShelfPage,
): Promise<{ truncated: boolean }> {
  for (let page = 1; page <= maxPages; page += 1) {
    const result = await fetchPage({ shelfType, page });
    if (result === null) {
      consola.warn(`书架 ${shelfType} 在第 ${page} 页因错误中止。`);
      return { truncated: true };
    }
    if (result.data.length === 0) {
      return { truncated: false };
    }

    // 先跑 visitor 再判断页数预算：因为配额已满而停的决定优先于「走到了第 N 页」。
    const keepGoing = await visit(result.data);
    if (!keepGoing) {
      return { truncated: false };
    }

    const reportedPages = Number(result.pages);
    if (Number.isFinite(reportedPages) && page >= reportedPages) {
      return { truncated: false };
    }
    if (page === maxPages) {
      consola.warn(`书架 ${shelfType} 达到页数上限 ${maxPages}，还有条目未遍历。`);
      return { truncated: true };
    }
    await neodbThrottle();
  }
  return { truncated: false };
}

/**
 * 用条目自身的 `api_url` 拉取完整目录条目 —— 书架列表内联的是 ItemSchema，
 * 没有 `year` / `pub_year`，标题匹配那一级需要年份。
 *
 * `prefixUrl` 不接受前导斜杠，而 NeoDB 的 `api_url` 总是带一个；绝对 URL 会丢
 * origin，只有路径部分才标识条目。返回 `null` 而不抛出：拿不到年份只少一次匹配，
 * 绝不会写错。
 */
export async function getNeodbItemDetail(apiUrl: string): Promise<NeodbItem | null> {
  const cataloguePath = apiUrl
    .trim()
    .replace(/^https?:\/\/[^/]+/i, '')
    .replace(/^\/+/, '');
  if (!cataloguePath) {
    return null;
  }
  try {
    const detail = (await neodbClient(cataloguePath, {
      headers: { accept: 'application/json' },
    }).json()) as NeodbItem;
    return detail?.uuid ? detail : null;
  } catch (error) {
    consola.warn(
      '读取 NeoDB 条目详情失败: ',
      `${cataloguePath} — ${neodbFailureCode(error)}`,
    );
    return null;
  }
}

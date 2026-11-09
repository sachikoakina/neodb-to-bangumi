/**
 * Bangumi 传输层 —— 鉴权头、UA、限流与 401 提示。
 *
 * Bangumi 要求带可识别的 UA 与真实链接；限流用固定小延迟规避。
 */
import dotenv from 'dotenv';
import got, { HTTPError } from 'got';
import { consola } from 'consola';
import { recordSleep } from '../metrics';
import { sleep } from '../utils';

dotenv.config();

/** `BANGUMI_ACCESS_TOKEN`；未设置时所有需鉴权的调用都会被跳过。 */
export const bangumiToken = process.env.BANGUMI_ACCESS_TOKEN;

const rawDelay = Number(process.env.BANGUMI_REQUEST_DELAY_MS);
export const bangumiDelayMs =
  Number.isFinite(rawDelay) && rawDelay >= 0 ? rawDelay : 400;

export const bangumiUserAgent =
  process.env.BANGUMI_USER_AGENT ||
  'neodb-to-bangumi/1.0 (+https://github.com/sachikoakina/neodb-to-bangumi)';

export const BGM_API = 'https://api.bgm.tv';

/**
 * 重试只用于**幂等**请求：GET 全部可重试；分集 PUT 把 `type` 设为 2 也是幂等的。
 * POST（搜索 / 收藏 upsert）刻意排除——重复提交的语义没有把握，宁可按失败重试下一轮。
 */
export function retriesMethod(method: string): boolean {
  return method === 'GET' || method === 'PUT';
}

/**
 * Bangumi 共享 got 实例。
 *
 * 之前每个端点各自裸调 `got(...)`：没有超时、没有重试，一次 429/500 就把该条目
 * 判成 failed，要等到第二天。这里的退避（≥1s，2 的幂）本身就比 `BANGUMI_REQUEST_DELAY_MS`
 * 更慢，因此重试不会把瞬时速率打高。
 */
export const bangumiGot = got.extend({
  timeout: { request: 30000 },
  retry: {
    limit: 2,
    methods: ['GET', 'PUT'],
    statusCodes: [408, 429, 500, 502, 503, 504],
    errorCodes: ['ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN'],
    calculateDelay: ({ attemptCount, error, computedValue }) => {
      const retryAfter = Number(error?.response?.headers?.['retry-after']);
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        return retryAfter * 1000;
      }
      return Math.min(2 ** attemptCount * 500, 8000) || computedValue;
    },
  },
});

export function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    'User-Agent': bangumiUserAgent,
  };
  if (bangumiToken) {
    headers.Authorization = `Bearer ${bangumiToken}`;
  }
  return headers;
}

export function isUnauthorized(error: unknown): boolean {
  return error instanceof HTTPError && error.response.statusCode === 401;
}

export async function bangumiThrottle(): Promise<void> {
  const begin = performance.now();
  await sleep(bangumiDelayMs);
  recordSleep('bangumi', performance.now() - begin);
}

/**
 * 用用户的语言解释 401，并给出确切的修复步骤。
 * 运行时消息刻意用英文，仅这一条例外 —— 写成中文是为了让修复步骤可直接照做。
 */
export function logUnauthorized(): void {
  consola.error(
    'Bangumi token 可能已过期，请到 https://next.bgm.tv/demo/access-token 重新生成并更新 BANGUMI_ACCESS_TOKEN',
  );
}

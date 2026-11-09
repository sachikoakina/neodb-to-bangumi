/**
 * NeoDB 传输层 —— got 实例、鉴权头、限流与失败码归一。
 *
 * 目录读取与书架读取共用同一个实例，`NEODB_BASE_URL` 支持自建实例。
 */
import dotenv from 'dotenv';
import got from 'got';
import { consola } from 'consola';
import { recordSleep } from '../metrics';
import { sleep } from '../utils';

dotenv.config();

/** `NEODB_API_TOKEN`；未设置时所有需鉴权的调用都会被跳过。 */
export const neodbToken = process.env.NEODB_API_TOKEN;

const rawBaseUrl = process.env.NEODB_BASE_URL?.trim();
export const neodbBaseUrl = rawBaseUrl || 'https://neodb.social';

const rawDelay = Number(process.env.NEODB_REQUEST_DELAY_MS);
export const neodbDelayMs = Number.isFinite(rawDelay) && rawDelay >= 0 ? rawDelay : 300;

export const neodbClient = got.extend({
  prefixUrl: neodbBaseUrl,
  headers: { accept: 'application/json' },
  timeout: { request: 30000 },
  retry: {
    limit: 3,
    methods: ['GET'],
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

export function neodbAuthHeaders(): Record<string, string> {
  return neodbToken ? { Authorization: `Bearer ${neodbToken}` } : {};
}

export async function neodbThrottle(): Promise<void> {
  const begin = performance.now();
  await sleep(neodbDelayMs);
  recordSleep('neodb', performance.now() - begin);
}

/** 把任意错误归一成「状态码 + 简短信息」，日志不再打印整包响应。 */
export function neodbFailureCode(error: unknown): string {
  const status = (error as { response?: { statusCode?: number } }).response?.statusCode;
  return `${status ?? 'no response'}`;
}

export function logNeodbUnauthorized(): void {
  consola.error(
    'NeoDB token 可能已过期，请到实例的 /developer/ 页面重新授权并更新 NEODB_API_TOKEN',
  );
}

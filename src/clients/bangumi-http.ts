/**
 * Bangumi 传输层 —— 鉴权头、UA、限流与 401 提示。
 *
 * Bangumi 要求带可识别的 UA 与真实链接；限流用固定小延迟规避。
 */
import dotenv from 'dotenv';
import { HTTPError } from 'got';
import { consola } from 'consola';
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
  await sleep(bangumiDelayMs);
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

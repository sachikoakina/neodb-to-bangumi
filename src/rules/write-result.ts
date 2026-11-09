/**
 * 写入失败的归因与错误体摘要 —— 纯函数，便于离线断言。
 *
 * 与 `read-result.ts` 同构，但语义不同：读取时 404 往往意味着「没有记录，可以新建」，
 * 写入时 404 只能意味着「服务端不接受为目标建收藏」。混用会让一条坏数据
 * 每晚把整条流水线判红，所以归因必须在这里定死。
 */
import type { WriteFailureKind } from '../types';

/** 错误体摘要上限：够看清 Bangumi 的 title/description，又不至于刷屏。 */
const MAX_DETAIL = 300;

export function classifyWriteFailure(status: number | null): WriteFailureKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not-found';
  return 'transient';
}

/**
 * 从 Bangumi 错误体里取一句人话。
 *
 * v0 的错误体通常是 `{ title, description }`（有时是纯文本）。`got` 在
 * `response.body` 里保留原始字符串，所以先尝试解析 JSON，失败则直接截断原文。
 * 取不到就返回空串，由调用方决定是否拼接。
 */
export function summarizeErrorBody(body: unknown): string {
  if (body == null) return '';
  const text =
    typeof body === 'string'
      ? body
      : typeof body === 'object'
        ? jsonBodyText(body)
        : String(body);
  const compact = text.replace(/\s+/g, ' ').trim();
  if (!compact) return '';
  return compact.length > MAX_DETAIL ? `${compact.slice(0, MAX_DETAIL)}…` : compact;
}

function jsonBodyText(body: object): string {
  const record = body as { title?: unknown; description?: unknown; message?: unknown };
  const parts = [record.title, record.description, record.message]
    .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
    .map((part) => part.trim());
  if (parts.length) return parts.join(': ');
  try {
    const serialized = JSON.stringify(body);
    // 空对象没有信息量，不要让它变成噪音（`{}` / `[]`）。
    return serialized === '{}' || serialized === '[]' ? '' : serialized;
  } catch {
    return '';
  }
}

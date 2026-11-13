/**
 * ISBN 归一化与提取 —— 纯函数，无 IO。
 *
 * ISBN 是书籍的**强身份键**：同一 ISBN 即同一版次，命中后不必再拿年份兜底
 * （再版/不同印次年份必然有差）。但它的覆盖面不完整：画集、独立出版物、
 * 部分旧书没有 ISBN，因此它只能做「正证据」——缺失时保持中性，绝不否决。
 */
import type { BangumiSubject } from '../types';

/** ISBN-13 校验位：前 12 位按 1/3 交替加权，补足到 10 的倍数。 */
function isbn13CheckDigit(first12: string): string {
  let sum = 0;
  for (let i = 0; i < 12; i += 1) {
    sum += Number(first12[i]) * (i % 2 === 0 ? 1 : 3);
  }
  return String((10 - (sum % 10)) % 10);
}

function isValidIsbn13(digits: string): boolean {
  return isbn13CheckDigit(digits.slice(0, 12)) === digits[12];
}

/** ISBN-10 校验：按 10..1 加权求和，能被 11 整除；X 记作 10。 */
function isValidIsbn10(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < 10; i += 1) {
    const char = digits[i]!;
    const value = char === 'X' ? 10 : Number(char);
    if (!Number.isInteger(value)) return false;
    sum += value * (10 - i);
  }
  return sum % 11 === 0;
}

/** 10 位转 13 位：统一补 978 前缀并重算校验位，便于与 13 位直接比较。 */
function isbn10To13(digits: string): string {
  const first12 = `978${digits.slice(0, 9)}`;
  return `${first12}${isbn13CheckDigit(first12)}`;
}

/**
 * 归一化：去除非数字（保留 X）、10 位转 13 位、校验位校验。
 * 校验失败返回 `null` —— 脏数据应当被视为「没有 ISBN」，而不是拿去比对。
 */
export function normalizeIsbn(raw: string | null | undefined): string | null {
  const digits = (raw ?? '').replace(/[^0-9Xx]/g, '').toUpperCase();
  if (digits.length === 10) {
    return isValidIsbn10(digits) ? isbn10To13(digits) : null;
  }
  if (digits.length === 13) {
    return isValidIsbn13(digits) ? digits : null;
  }
  return null;
}

/**
 * 候选的全部 ISBN：infobox 的 `ISBN` + 所有「版本:*」子项的 `ISBN`。
 *
 * 版本子项必须一起收：NeoDB 条目可能是中文版，主 infobox 的 ISBN 是日版，
 * 只比对主 ISBN 会漏掉「同一部书的不同版次」这种正确答案。
 */
export function extractIsbns(subject: BangumiSubject): string[] {
  const out: string[] = [];
  const push = (raw: unknown): void => {
    if (typeof raw !== 'string') return;
    const normalized = normalizeIsbn(raw);
    if (normalized && !out.includes(normalized)) {
      out.push(normalized);
    }
  };

  for (const item of subject.infobox ?? []) {
    const key = item?.key?.trim() ?? '';
    if (!key) continue;
    if (key === 'ISBN') {
      push(item.value);
      continue;
    }
    if (key.startsWith('版本') && Array.isArray(item.value)) {
      for (const entry of item.value) {
        if (entry?.k?.trim() === 'ISBN') {
          push(entry.v);
        }
      }
    }
  }
  return out;
}

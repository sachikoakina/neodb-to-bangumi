/** 通用小工具。 */

/** 固定延迟，用于请求间限流。 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

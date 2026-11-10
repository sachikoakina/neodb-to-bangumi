/**
 * 只读探测脚本：验证 NeoDB 凭据并打印书架概况。
 * 不写任何数据，用于首次运行前确认凭据与字段形态。
 */
import { consola } from 'consola';
import { neodbToken } from '../src/clients/neodb-http';
import {
  fetchShelfPage,
  getNeodbMe,
  verifyNeodbToken,
} from '../src/clients/neodb-shelf';
import { extractBangumiSubjectId } from '../src/rules/neodb-bangumi-matching';
import { displayName } from '../src/rules/neodb-display';
import { SHELF_TYPES } from '../src/types';

async function main(): Promise<void> {
  if (!neodbToken) {
    consola.error('NEODB_API_TOKEN 未设置。');
    process.exitCode = 2;
    return;
  }
  if (!(await verifyNeodbToken())) {
    consola.error('NeoDB 凭据校验失败。');
    process.exitCode = 2;
    return;
  }
  const me = await getNeodbMe();
  consola.info(`NeoDB 账号: ${me?.display_name || me?.username || '未知'}`);

  for (const shelfType of SHELF_TYPES) {
    const page = await fetchShelfPage({ shelfType, page: 1 });
    if (page === null) {
      consola.warn(`书架 ${shelfType}: 读取失败`);
      continue;
    }
    consola.info(
      `书架 ${shelfType}: 本页 ${page.data.length} 条 / 共约 ${page.count} 条`,
    );
    for (const mark of page.data.slice(0, 3)) {
      const item = mark.item;
      const bangumiId = extractBangumiSubjectId(item.external_resources);
      consola.info(
        `  - ${displayName(item)}｜shelf=${mark.shelf_type}｜` +
          `rating=${mark.rating_grade ?? 0}｜comment=${(mark.comment_text ?? '').length}字｜` +
          `bangumi外链=${bangumiId ?? '无'}`,
      );
    }
  }
}

main().catch((error) => {
  consola.error('探测失败: ', error);
  process.exitCode = 1;
});

/**
 * 错配清理 —— 按清单撤销误写入的收藏与分集。
 *
 * 背景：2026-11-06 全量迁移的弱匹配把部分 NeoDB 条目错配到同名的冷门
 * Bangumi 条目上，写入了「看过」并点亮分集。本脚本按审计产出的清理清单
 * 逐条撤销。端点核对依据 bangumi/api 官方 v0 规范（2026-11 查证）：
 *
 * - 分集重置：PUT /v0/users/-/collections/-/episodes/{episode_id}
 *   body {type: 0}（EpisodeCollectionType: 0=未收藏 1=想看 2=看过 3=抛弃）
 *   —— 已文档化，本脚本自动化；
 * - 收藏状态改写：PATCH /v0/users/-/collections/{subject_id}
 *   （字段可选：type/rate/comment/ep_status/vol_status/private/tags）
 *   —— 已文档化，经 `--set-type` 启用（如改回 1=想看）；
 * - 收藏本体删除：v0 规范**没有** DELETE 端点 —— 只能在 bangumi.tv 条目页
 *   （收藏管理 → 取消收藏）手动完成，本脚本逐条输出指引，不臆造端点。
 *
 * 用法：
 *   npm run cleanup -- audit/cleanup-list.txt                # dry：只打印计划
 *   npm run cleanup -- audit/cleanup-list.txt --apply        # 重置分集
 *   npm run cleanup -- audit/cleanup-list.txt --apply --set-type 1
 *
 * 清单格式：每行一个 subject id，`#` 起为注释（行内注释亦可）。幂等：
 * 已无收藏的条目跳过，已未收藏的分集不计入重置。
 * 退出码：0 成功；1 有失败；2 认证不可用。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { consola } from 'consola';
import got from 'got';
import {
  authHeaders,
  BGM_API,
  bangumiThrottle,
  bangumiToken,
} from '../src/clients/bangumi-http';
import {
  getBangumiCollection,
  getBangumiEpisodeStates,
  getBangumiMe,
  getBangumiSubject,
} from '../src/clients/bangumi';

const COLLECTION_TYPE_NAMES: Record<number, string> = {
  1: '想看',
  2: '看过',
  3: '在看',
  4: '搁置',
  5: '抛弃',
};

type Args = {
  list: string;
  apply: boolean;
  setType: number | null;
};

function parseArgs(argv: string[]): Args {
  const args: Args = { list: '', apply: false, setType: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--apply') {
      args.apply = true;
      continue;
    }
    if (arg === '--set-type') {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 1 || value > 5) {
        throw new Error(
          `--set-type 需要 1..5 的收藏类型（1想看 2看过 3在看 4搁置 5抛弃），得到: ${argv[i]}`,
        );
      }
      args.setType = value;
      continue;
    }
    if (args.list) {
      throw new Error(`多余的位置参数: ${arg}`);
    }
    args.list = arg;
  }
  if (!args.list) {
    throw new Error(
      '缺少清单文件参数。用法: npm run cleanup -- <list-file> [--apply] [--set-type <1..5>]',
    );
  }
  if (args.setType != null && !args.apply) {
    consola.warn('--set-type 只在 --apply 下生效；本轮按 dry 打印计划。');
  }
  return args;
}

/** 每行一个 subject id；`#` 起为注释，行内注释亦可；去重保序。 */
function parseList(content: string): number[] {
  const ids: number[] = [];
  const seen = new Set<number>();
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const id = Number(line);
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error(`清单中存在非法行「${raw.trim()}」——每行应为正整数 subject id`);
    }
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

/** 重置单集为「未收藏」（type=0）。已文档化端点，失败不中断整批。 */
async function resetEpisode(subjectId: number, episodeId: number): Promise<boolean> {
  try {
    await bangumiThrottle();
    await got.put(`${BGM_API}/v0/users/-/collections/-/episodes/${episodeId}`, {
      headers: authHeaders(),
      json: { type: 0 },
      responseType: 'json',
    });
    return true;
  } catch (error) {
    consola.error(`重置分集失败 subject/${subjectId} episode/${episodeId}: `, error);
    return false;
  }
}

/** 按文档化 PATCH 端点改写收藏类型（如把「看过」改回「想看」）。 */
async function patchCollectionType(subjectId: number, type: number): Promise<boolean> {
  try {
    await bangumiThrottle();
    await got.patch(`${BGM_API}/v0/users/-/collections/${subjectId}`, {
      headers: authHeaders(),
      json: { type },
      responseType: 'json',
    });
    return true;
  } catch (error) {
    consola.error(`改写收藏类型失败 subject/${subjectId} → type=${type}: `, error);
    return false;
  }
}

type SubjectReport = {
  subjectId: number;
  subjectName: string;
  action: 'reset-episodes' | 'absent' | 'failed' | 'plan';
  episodesReset: number;
  episodesFailed: number;
  setTypeApplied: boolean;
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!bangumiToken) {
    consola.error('BANGUMI_ACCESS_TOKEN 未设置，链路中止。');
    process.exitCode = 2;
    return;
  }
  const me = await getBangumiMe();
  if (!me) {
    consola.error('无法确认 Bangumi 账号身份，链路中止。');
    process.exitCode = 2;
    return;
  }

  const ids = parseList(readFileSync(args.list, 'utf8'));
  consola.info(
    `错配清理: ${ids.length} 个 subject｜模式: ${args.apply ? 'APPLY' : 'dry（只打印计划）'}${args.setType != null ? `｜--set-type ${args.setType}（${COLLECTION_TYPE_NAMES[args.setType]}）` : ''}`,
  );
  consola.warn(
    '收藏本体删除没有 v0 API 端点：请在 bangumi.tv 条目页「收藏管理 → 取消收藏」手动完成（脚本会在每条后输出链接）。',
  );

  const report: SubjectReport[] = [];
  let failedSubjects = 0;
  let resetTotal = 0;
  let resetFailedTotal = 0;

  for (const subjectId of ids) {
    const subjectRes = await getBangumiSubject(subjectId);
    const subjectName =
      subjectRes.status === 'found'
        ? `${subjectRes.value.name_cn || subjectRes.value.name}（type=${subjectRes.value.type}）`
        : `subject/${subjectId}`;
    consola.info(`── subject/${subjectId} ${subjectName}`);

    const coll = await getBangumiCollection(me.username, subjectId);
    if (coll.status === 'error') {
      // 读取失败绝不当作「无收藏」——拒绝回答不是无话可说。
      consola.error(`   收藏读取失败（${coll.message}），跳过该条，待人工核查。`);
      report.push({
        subjectId,
        subjectName,
        action: 'failed',
        episodesReset: 0,
        episodesFailed: 0,
        setTypeApplied: false,
      });
      failedSubjects += 1;
      continue;
    }
    if (coll.status === 'absent') {
      consola.info('   无收藏（已清理或从未写入），跳过。');
      report.push({
        subjectId,
        subjectName,
        action: 'absent',
        episodesReset: 0,
        episodesFailed: 0,
        setTypeApplied: false,
      });
      continue;
    }
    const existing = coll.value;
    consola.info(
      `   当前收藏: type=${existing.type}（${COLLECTION_TYPE_NAMES[existing.type] ?? existing.type}）` +
        ` rate=${existing.rate} comment=${JSON.stringify(existing.comment ?? '')} updated_at=${existing.updated_at}`,
    );

    const statesRes = await getBangumiEpisodeStates(subjectId);
    const watched =
      statesRes.status === 'found'
        ? [...statesRes.value.entries()]
            .filter(([, state]) => state.type === 2)
            .map(([episodeId]) => episodeId)
        : [];
    consola.info(
      `   已点亮分集: ${watched.length} 个${statesRes.status === 'error' ? '（分集读取失败，本轮不重置）' : ''}`,
    );

    if (!args.apply) {
      consola.info(
        `   计划: 重置 ${watched.length} 个分集（type=0）${args.setType != null ? `；PATCH type→${args.setType}` : ''}；本体删除 → https://bangumi.tv/subject/${subjectId}`,
      );
      report.push({
        subjectId,
        subjectName,
        action: 'plan',
        episodesReset: 0,
        episodesFailed: 0,
        setTypeApplied: false,
      });
      continue;
    }

    let resetOk = 0;
    let resetFailed = 0;
    for (const episodeId of watched) {
      if (await resetEpisode(subjectId, episodeId)) {
        resetOk += 1;
      } else {
        resetFailed += 1;
      }
    }
    resetTotal += resetOk;
    resetFailedTotal += resetFailed;

    let setTypeApplied = false;
    if (args.setType != null && args.setType !== existing.type) {
      setTypeApplied = await patchCollectionType(subjectId, args.setType);
      if (!setTypeApplied) {
        failedSubjects += 1;
      }
    }
    consola.info(
      `   结果: 重置 ${resetOk}/${watched.length} 分集${resetFailed > 0 ? `（失败 ${resetFailed}）` : ''}` +
        `${args.setType != null ? `；type→${args.setType}: ${setTypeApplied ? '已写入' : '失败'}` : ''}` +
        `；本体删除（手动）→ https://bangumi.tv/subject/${subjectId}`,
    );
    report.push({
      subjectId,
      subjectName,
      action: 'reset-episodes',
      episodesReset: resetOk,
      episodesFailed: resetFailed,
      setTypeApplied,
    });
  }

  consola.info(
    `清理完成: ${ids.length} 个 subject｜重置分集 ${resetTotal}${resetFailedTotal > 0 ? `（失败 ${resetFailedTotal}）` : ''}｜失败条目 ${failedSubjects}` +
      `${args.apply ? '' : '（dry：以上均为计划，未写入）'}`,
  );

  const reportPath = `${args.list.replace(/\.[^.]+$/, '')}.cleanup-report.json`;
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        version: 1,
        list: args.list,
        apply: args.apply,
        setType: args.setType,
        finishedAt: new Date().toISOString(),
        resetTotal,
        resetFailedTotal,
        failedSubjects,
        subjects: report,
      },
      null,
      2,
    ),
    'utf8',
  );
  consola.info(`清理报告已写入: ${reportPath}`);

  process.exitCode = failedSubjects > 0 || resetFailedTotal > 0 ? 1 : 0;
}

main().catch((error) => {
  consola.error('清理执行异常: ', error);
  process.exitCode = 1;
});

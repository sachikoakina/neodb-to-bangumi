# neodb-to-bangumi

把 NeoDB 书架的**标记状态、评分、短评与进度**迁移到 Bangumi 收藏。TypeScript 命令行工具，默认目标优先、幂等可重跑，dry-run 先行。

## 它做什么

- 读取 NeoDB 书架（`wishlist / progress / complete / dropped`）；
- 为每条标记找到对应的 Bangumi 条目：**外链直连 → 标题搜索 + 精确匹配 → 年份软过滤**；
- 与现有 Bangumi 收藏逐字段 diff，有变化才写（状态、评分 0–10、短评，可选私密映射）；
- `SYNC_PROGRESS=1` 时把 complete 条目的进度**拉满至上限**（书籍章节/卷数、电影首集、TV/动画/真人分集）；
- 未匹配条目进入待核对名单，不猜测、不跨类型；认证失败中止链路，单条失败继续。

[映射与匹配规则的完整说明](docs/mapping.md)。

## 快速开始

```bash
npm ci
cp .env.example .env   # 填入 NEODB_API_TOKEN 与 BANGUMI_ACCESS_TOKEN
npm run probe:neodb    # 只读探测：确认凭据与书架字段
```

首次迁移的推荐顺序：

```bash
SYNC_DRY_RUN=1 FULL_SYNC=1 npm run sync   # 全量预演，核对计划与未匹配清单
npm run sync                              # 常规增量写入（受 SYNC_MAX_ITEMS 保护）
FULL_SYNC=1 npm run sync                  # 全量正式迁移
```

## 配置

全部配置项见 [.env.example](.env.example)（每项含默认值与用途说明）。要点：

| 配置                         | 默认             | 说明                            |
| ---------------------------- | ---------------- | ------------------------------- |
| `SYNC_DRY_RUN`               | `0`              | 只输出计划，不写入              |
| `SYNC_NEODB_BANGUMI_RATING`  | `bangumi_prefer` | 评分：目标非 0 分优先           |
| `SYNC_NEODB_BANGUMI_COMMENT` | `bangumi_prefer` | 短评：只填空不清空              |
| `SYNC_STATUS_GUARD`          | `off`            | `no-downgrade` 保护现有「看过」 |
| `SYNC_PROGRESS`              | `0`              | 进度拉满总开关，显式启用        |
| `SYNC_INCLUDE_SP`            | `0`              | 分集拉满是否纳入 SP             |
| `SYNC_MAP_PRIVATE`           | `0`              | NeoDB 私密 → Bangumi private    |
| `FULL_SYNC`                  | `0`              | 全量模式：忽略上限、关闭增量    |

## 定时运行与手动触发

`.github/workflows/sync.yml` 是定时任务入口，提供两种触发方式：

| 方式 | 操作                                                      | 说明                                                              |
| ---- | --------------------------------------------------------- | ----------------------------------------------------------------- |
| 定时 | 每天上海时间 03:15（前一日 19:15 UTC）                    | 增量推进：缓存 `.cache/sync-state.json`，已同步条目不消耗条目预算 |
| 手动 | 仓库 → Actions → 左侧 `sync` → 右侧 **Run workflow** 按钮 | 可选 `full_sync` / `dry_run` / `progress` 三个输入                |

手动输入优先于仓库 Variables，且只对本次运行生效，不会残留到定时任务。运行前会先跑 `verify:all` 离线断言门禁；无论成败都会发布 Job Summary，并上传报告、摘要与未匹配清单三个 artifact（保留 7 天）。

需要在仓库 Settings 配置：

- Secrets：`NEODB_API_TOKEN`、`BANGUMI_ACCESS_TOKEN`；
- Variables（可选，未设置时用代码默认值）：`.env.example` 中除凭据外的全部配置项。

## 运行结果

每轮输出统一 `PathReport`（满足 `scanned = written + unchanged + skipped + unresolved + failed`）、Markdown 摘要与机器可读 JSON。`failed` 条目使退出码为 1，认证中止为 2。

## 已知限制

- **收藏时间无法迁移**：Bangumi API 不接受自定义收藏时间，服务端写 `updated_at`；
- **真人影视匹配率**：Bangumi 对动画/书籍/游戏/音乐覆盖好，真人电影/电视剧覆盖弱，无外链的条目可能大量 unresolved——在 NeoDB 条目上补 Bangumi 外链后重跑即可命中；
- `podcast` / `performance` 分类在 Bangumi 无对应类型，写入侧跳过。

## 开发校验

```bash
npm run typecheck
npm run lint
npm run verify:all   # 单元测试 + 映射断言 + 匹配断言 + 文档一致性
```

改动映射表或匹配规则时，同步更新 `scripts/verify-mapping.ts` / `verify-matching.ts` 与 [docs/mapping.md](docs/mapping.md)——三者必须一致。

## License

MIT

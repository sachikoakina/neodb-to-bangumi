# neodb-to-bangumi

把 NeoDB 书架的**标记状态、评分、短评与进度**迁移到 Bangumi 收藏。TypeScript 命令行工具，默认目标优先、幂等可重跑，dry-run 先行。

## 它做什么

- 读取 NeoDB 书架（`wishlist / progress / complete / dropped`）；
- 为每条标记找到对应的 Bangumi 条目：**外链直连 → 标题搜索 + 精确匹配 → 年份软过滤**；严格模式下，唯一候选若证据不足（年份无法核对且形态不可判定）转待核对而不写入；
- 与现有 Bangumi 收藏逐字段 diff，有变化才写（状态、评分 0–10、短评，可选私密映射）；
- `SYNC_PROGRESS=1` 时把 complete 条目的进度**拉满至上限**（书籍章节/卷数、电影首集、TV/动画/真人分集）；
- 同一 Bangumi 目标被多条 NeoDB 标记命中时，只让最强认领者写入（外链 > 标题；`complete` > 在看/想看 > 抛弃）；
- 未匹配、歧义与重复目标进入待核对名单，不猜测、不跨类型；认证失败中止链路，单条失败继续。

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

配置来源优先级（仅 Actions 手动运行涉及）：**手动输入 > 仓库 Variables > 代码默认值**；本地运行只读 `.env` 与进程环境变量。

按敏感性分为两类，注入位置不同：

| 归属         | 含义                                  | 本地                    | GitHub Actions                                   | 是否可公开     |
| ------------ | ------------------------------------- | ----------------------- | ------------------------------------------------ | -------------- |
| **Secret**   | 密钥/令牌，泄露即可被他人读写你的账号 | `.env`（已被 git 忽略） | Settings → Secrets and variables → **Secrets**   | 否，绝不外泄   |
| **Variable** | 普通配置，泄露不造成账号风险          | `.env`                  | Settings → Secrets and variables → **Variables** | 是，可写进文档 |

> 条目清单以 [.env.example](.env.example) 为唯一模板；`npm run verify:docs` 会校验代码读取项与该模板双向一致，新增配置项时两处必须同步。

### 一、Secret（密钥/敏感信息，共 2 项）

| 名称                   | 数据类型 | 必填 | 用途                                | 注意事项                                                                                         |
| ---------------------- | -------- | ---- | ----------------------------------- | ------------------------------------------------------------------------------------------------ |
| `NEODB_API_TOKEN`      | string   | 是   | 读取 NeoDB 书架（只读，不写 NeoDB） | 实例 `/developer/` 授权获取；泄露后立即在实例内吊销并重新授权。未设置时链路直接中止              |
| `BANGUMI_ACCESS_TOKEN` | string   | 是   | 读取/写入 Bangumi 收藏              | `https://next.bgm.tv/demo/access-token` 生成；该令牌具备写权限，泄露影响最大，务必只放入 Secrets |

**保密要求**：不要把 Secret 写进 README、提交历史、issue、截图或日志；项目运行日志不会打印令牌原值。`SYNC_UNMATCHED_LOG` 与报告只记录条目标题与链接，不含凭据。

### 二、Variable（普通变量/非敏感配置，共 26 项）

#### 1. 连接与节流（5 项）

| 名称                       | 数据类型 | 默认值                             | 用途                                        |
| -------------------------- | -------- | ---------------------------------- | ------------------------------------------- |
| `NEODB_BASE_URL`           | string   | `https://neodb.social`             | NeoDB 实例地址；自建实例时指向你的域名      |
| `NEODB_REQUEST_DELAY_MS`   | number   | `300`                              | 书架请求间隔（毫秒），规避限流              |
| `NEODB_MAX_PAGES`          | number   | `10`                               | 每个书架最大遍历页数；`FULL_SYNC=1` 时忽略  |
| `BANGUMI_USER_AGENT`       | string   | `neodb-to-bangumi/1.0 (+仓库链接)` | Bangumi 要求可识别 UA，建议保留真实仓库地址 |
| `BANGUMI_REQUEST_DELAY_MS` | number   | `400`                              | Bangumi 请求间隔（毫秒）                    |

#### 2. 迁移范围（5 项）

| 名称                       | 数据类型 | 默认值                               | 用途                                                                                                                                             |
| -------------------------- | -------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SYNC_SHELF_TYPES`         | CSV      | `wishlist,progress,complete,dropped` | 要遍历的 NeoDB 书架；可只填 `complete` 等                                                                                                        |
| `SYNC_CATEGORIES`          | CSV      | `book,movie,tv,music,game`           | 分类白名单，可选 `podcast,performance`（Bangumi 无对应类型，写入侧跳过）。**写错分类名会让白名单整体作废（失败在关闭一侧），本次不同步任何分类** |
| `SYNC_YEAR_TOLERANCE`      | number   | `1`                                  | 标题匹配允许的年份差；动画（2）/真人（6）/书籍（1）/音乐（3）/游戏（4）参与过滤                                                                  |
| `SYNC_YEAR_TOLERANCE_BOOK` | number   | `1`                                  | 书籍类（type 1）单独的年份容差；初版/再版年份口径差异大，可单独放宽                                                                              |
| `SYNC_MATCH_STRICT`        | boolean  | `1`                                  | 匹配严格模式：唯一同名候选年份无法核对且形态不可判定时转待核对，不自动写入（宁可漏配，不可错配）；`0` = 证据缺失照写（旧行为）                   |

#### 3. 字段合并与保护（8 项）

| 名称                         | 数据类型 | 默认值           | 用途                                                                                   |
| ---------------------------- | -------- | ---------------- | -------------------------------------------------------------------------------------- |
| `SYNC_NEODB_BANGUMI_RATING`  | enum     | `bangumi_prefer` | 评分合并：`bangumi_prefer` 保留目标非 0 分；`overwrite` 用 NeoDB 分覆盖                |
| `SYNC_NEODB_BANGUMI_COMMENT` | enum     | `bangumi_prefer` | 短评合并：`bangumi_prefer` 保留目标非空短评；`overwrite` 用 NeoDB 短评覆盖（空值清空） |
| `SYNC_STATUS_GUARD`          | enum     | `off`            | `no-downgrade` 时现有「看过」不被想看/在看降级                                         |
| `SYNC_BANGUMI_PRIVATE_MODE`  | enum     | `target`         | `target` 统一写配置值；`source` 逐条跟随 NeoDB（2→私密，0/1→公开），源缺失保留现值     |
| `SYNC_BANGUMI_PRIVATE`       | boolean  | `false`          | `target` 模式的 private 值；`source` 模式在源缺失且无目标值时的兜底                    |
| `SYNC_PROGRESS`              | boolean  | `0`              | 进度拉满总开关；`1` 时 complete 条目书籍章节/卷数、电影首集、TV/动画/真人分集拉到上限  |
| `SYNC_INCLUDE_SP`            | boolean  | `0`              | 分集拉满是否纳入 SP；电影永不处理 SP                                                   |
| `SYNC_INCLUDE_OP_ED`         | boolean  | `0`              | 是否把 OP/ED（type 2/3）纳入拉满；默认关闭，电影永不处理                               |

#### 4. 运行模式（3 项）

| 名称             | 数据类型 | 默认值 | 用途                                                                                     |
| ---------------- | -------- | ------ | ---------------------------------------------------------------------------------------- |
| `SYNC_DRY_RUN`   | boolean  | `0`    | `1` = 只输出计划，不写入任何数据                                                         |
| `SYNC_MAX_ITEMS` | number   | `50`   | 单次运行处理的条目上限；增量跳过的条目不消耗预算。**`0` 不是「无限」**，低于 1 回落为 50 |
| `FULL_SYNC`      | boolean  | `0`    | `1` = 忽略条目/页数上限并关闭增量跳过；首次迁移使用                                      |

#### 5. 增量与产物（8 项）

| 名称                        | 数据类型 | 默认值                         | 用途                                                                                  |
| --------------------------- | -------- | ------------------------------ | ------------------------------------------------------------------------------------- |
| `SYNC_INCREMENTAL`          | boolean  | `1`                            | 按条目指纹跳过已同步项；`FULL_SYNC=1` 时自动失效                                      |
| `SYNC_STATE_FILE`           | path     | `.cache/sync-state.json`       | 增量指纹文件；删除即重新全量比对。CI 通过 cache 跨运行保留                            |
| `SYNC_UNMATCHED_LOG`        | path     | `.cache/unmatched.json`        | 未匹配/歧义/重复目标名单（upsert 去重），供人工补外链                                 |
| `SYNC_MATCH_AUDIT_FILE`     | path     | `.cache/match-audit.json`      | 匹配审计：每条目的匹配方式/候选/证据/结局（dry-run 也产出），错配复核与清理清单的依据 |
| `REVIEW_STATE_MAX_AGE_DAYS` | number   | `30`                           | 名单按 `lastSeenAt` 老化的天数；`0` 永不清理；不按「本轮未出现」淘汰                  |
| `SYNC_REPORT_FILE`          | path     | `.cache/sync-report.json`      | 机器可读运行报告                                                                      |
| `SYNC_SUMMARY_FILE`         | path     | `.cache/sync-summary.md`       | Markdown 运行摘要（含待核对原因分布）                                                 |
| `FULL_SYNC_CURSOR_FILE`     | path     | `.cache/full-sync-cursor.json` | 仅 `FULL_SYNC=1` 使用的分页游标；常规运行不读不写，空页自动清除该书架                 |

### 配置注意事项

1. **布尔值写法**：`1/true/yes/on` 为真，其余为假；空值取默认值。
2. **非法值处理**：枚举写错会告警并回落到默认值；分类白名单写错则整体作废（不同步任何分类）——刻意失败在关闭一侧，避免误同步。
3. **相对路径**：产物、增量状态与全量游标路径均按进程工作目录解析，目录不存在会自动创建。
4. **CI 与本地差异**：CI runner 是临时的，增量状态、全量游标与待核对名单依赖 Actions cache 跨运行保留；未匹配清单同时发布为 90 天的 `review-state-*-stock` artifact，两种 artifact 的分工见下节。
5. **改配置不改代码**：所有可调项均通过环境变量读取；新增配置项时同步更新 `.env.example` 与本节，否则 `verify:docs` 会失败。

## 定时运行与手动触发

`.github/workflows/sync.yml` 是定时任务入口，提供两种触发方式：

| 方式 | 操作                                                      | 说明                                                              |
| ---- | --------------------------------------------------------- | ----------------------------------------------------------------- |
| 定时 | 每天上海时间 03:15（前一日 19:15 UTC）                    | 增量推进：缓存 `.cache/sync-state.json`，已同步条目不消耗条目预算 |
| 手动 | 仓库 → Actions → 左侧 `sync` → 右侧 **Run workflow** 按钮 | 可选 `full_sync` / `dry_run` / `progress` 三个输入                |

全量运行额外缓存 `.cache/full-sync-cursor.json`：被超时杀掉后从停下的那一页继续；空页或走完自动删除该书架游标。常规运行不读不写该文件。待核对名单同样跨轮缓存，详见下方「待核对状态载体」。

手动输入优先于仓库 Variables，且只对本次运行生效，不会残留到定时任务。运行前会先跑 `verify:all` 离线断言门禁；无论成败都会发布 Job Summary，并产出两类 artifact：

| artifact                            | 保留  | 内容                                                                 | 用途                                                 |
| ----------------------------------- | ----- | -------------------------------------------------------------------- | ---------------------------------------------------- |
| `sync-report-<run_id>-<UTC>`        | 7 天  | 本轮报告、摘要、全量游标（仅全量时存在）                             | 看本轮发生了什么                                     |
| `review-state-<run_id>-<UTC>-stock` | 90 天 | 待核对名单（`unmatched.json`）+ 匹配审计（`match-audit.json`）+ 摘要 | 人工跟进长期缺口；错配复核与清理清单以匹配审计为依据 |

### 待核对状态载体

`review-state-*-stock` 是 **artifact，不是仓库文件**。CI 会在 `npm run sync` 前恢复上一轮的 `.cache/unmatched.json`，运行后在同一文件上 upsert 并保存，因此 `firstSeenAt` 能跨轮保留——同一条缺口不会每天重新计时。

清理只按时间：`REVIEW_STATE_MAX_AGE_DAYS`（默认 30，`0` 永不清理）之后仍未再出现的条目会被删除；无效时间戳一律保留。刻意**不**按「本轮未出现」淘汰——单链路没有多路径 coverage 对账，一次分页截断或限流就可能误删真实缺口。

dry-run 不写正式名单：本轮视角的待核对名单会落到派生路径 `.cache/unmatched-dryrun.json`（由 `SYNC_UNMATCHED_LOG` 派生），并随 7 天报表 artifact 上传——预演不会改变下一次正式运行的起点。

私有仓库请保持 Settings → Actions →「Artifact and log retention」不低于 90 天；该值只能被单次上传缩短，不能被延长。

注入位置见上方[配置](#配置)章节：Secret 两项放入 **Secrets**，其余全部配置项放入 **Variables**（可选，未设置时用代码默认值）。

## 错配清理

匹配审计（`match-audit.json`）复核出错配后，用清理脚本按 subject 清单撤销：

```bash
npm run cleanup -- audit/cleanup-list.txt                  # dry：只打印计划
npm run cleanup -- audit/cleanup-list.txt --apply          # 重置已点亮的分集（type=0）
npm run cleanup -- audit/cleanup-list.txt --apply --set-type 1   # 同时把收藏改回「想看」
```

- 分集重置与收藏状态改写（`--set-type`，可选）走已文档化的 v0 端点，默认 dry、`--apply` 才写，幂等可重跑，结果写回 `<清单>.cleanup-report.json`；
- **收藏本体删除没有 v0 API 端点**：请按脚本输出的链接在 bangumi.tv 条目页「收藏管理 → 取消收藏」手动完成；
- 清单格式：每行一个 subject id，`#` 为注释。端点核对依据 bangumi/api 官方 v0 规范。

## 运行结果

每轮输出统一 `PathReport`（满足 `scanned = written + unchanged + skipped + unresolved + failed`）、Markdown 摘要与机器可读 JSON。`failed` 条目使退出码为 1，认证中止为 2。

`failed` 与 `unresolved` 刻意分开：搜索请求失败、年份读取失败、目标写入失败都是 `failed`，下一轮会重试；只有「搜索过但没有可信候选」才是 `unresolved`（数据缺口，需要人工补外链或补条目）。

## 已知限制

- **收藏时间无法迁移**：Bangumi API 不接受自定义收藏时间，服务端写 `updated_at`；
- **真人影视匹配率**：Bangumi 对动画/书籍/游戏/音乐覆盖好，真人电影/电视剧覆盖弱，无外链的条目可能大量 unresolved——在 NeoDB 条目上补 Bangumi 外链后重跑即可命中；
- **同名歧义**：多个精确同名候选且年份/媒体形态无法区分时，本轮不会写入，记 `ambiguous-bangumi-match`；这是刻意不猜，补外链即可解决；
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

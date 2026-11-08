# neodb-to-bangumi

把 NeoDB 书架的**标记状态、评分、短评与进度**迁移到 Bangumi 收藏。TypeScript 命令行工具，默认目标优先、幂等可重跑，dry-run 先行。

## 它做什么

- 读取 NeoDB 书架（`wishlist / progress / complete / dropped`）；
- 为每条标记找到对应的 Bangumi 条目：**外链直连 → 标题搜索 + 精确匹配 → 年份软过滤**；
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

### 二、Variable（普通变量/非敏感配置，共 25 项）

#### 1. 连接与节流（5 项）

| 名称                       | 数据类型 | 默认值                             | 用途                                        |
| -------------------------- | -------- | ---------------------------------- | ------------------------------------------- |
| `NEODB_BASE_URL`           | string   | `https://neodb.social`             | NeoDB 实例地址；自建实例时指向你的域名      |
| `NEODB_REQUEST_DELAY_MS`   | number   | `300`                              | 书架请求间隔（毫秒），规避限流              |
| `NEODB_MAX_PAGES`          | number   | `10`                               | 每个书架最大遍历页数；`FULL_SYNC=1` 时忽略  |
| `BANGUMI_USER_AGENT`       | string   | `neodb-to-bangumi/1.0 (+仓库链接)` | Bangumi 要求可识别 UA，建议保留真实仓库地址 |
| `BANGUMI_REQUEST_DELAY_MS` | number   | `400`                              | Bangumi 请求间隔（毫秒）                    |

#### 2. 迁移范围（3 项）

| 名称                  | 数据类型 | 默认值                               | 用途                                                                                                                                             |
| --------------------- | -------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SYNC_SHELF_TYPES`    | CSV      | `wishlist,progress,complete,dropped` | 要遍历的 NeoDB 书架；可只填 `complete` 等                                                                                                        |
| `SYNC_CATEGORIES`     | CSV      | `book,movie,tv,music,game`           | 分类白名单，可选 `podcast,performance`（Bangumi 无对应类型，写入侧跳过）。**写错分类名会让白名单整体作废（失败在关闭一侧），本次不同步任何分类** |
| `SYNC_YEAR_TOLERANCE` | number   | `1`                                  | 标题匹配允许的年份差；仅动画（2）/真人（6）参与过滤                                                                                              |

#### 3. 字段合并与保护（8 项）

| 名称                         | 数据类型 | 默认值           | 用途                                                                                  |
| ---------------------------- | -------- | ---------------- | ------------------------------------------------------------------------------------- |
| `SYNC_NEODB_BANGUMI_RATING`  | enum     | `bangumi_prefer` | 评分合并：`bangumi_prefer` 保留目标非 0 分；`overwrite` 用 NeoDB 分覆盖               |
| `SYNC_NEODB_BANGUMI_COMMENT` | enum     | `bangumi_prefer` | 短评合并：`bangumi_prefer` 只填空；`overwrite` 覆盖（含清空）                         |
| `SYNC_STATUS_GUARD`          | enum     | `off`            | `no-downgrade` 时现有「看过」不被想看/在看降级                                        |
| `SYNC_BANGUMI_PRIVATE_MODE`  | enum     | `target`         | `target` 统一写配置值；`source` 逐条跟随 NeoDB（2→私密，0/1→公开），源缺失保留现值    |
| `SYNC_BANGUMI_PRIVATE`       | boolean  | `false`          | `target` 模式的 private 值；`source` 模式在源缺失且无目标值时的兜底                   |
| `SYNC_PROGRESS`              | boolean  | `0`              | 进度拉满总开关；`1` 时 complete 条目书籍章节/卷数、电影首集、TV/动画/真人分集拉到上限 |
| `SYNC_INCLUDE_SP`            | boolean  | `0`              | 分集拉满是否纳入 SP；电影永不处理 SP                                                  |
| `SYNC_INCLUDE_OP_ED`         | boolean  | `0`              | 是否把 OP/ED（type 2/3）纳入拉满；默认关闭，电影永不处理                              |

#### 4. 运行模式（3 项）

| 名称             | 数据类型 | 默认值 | 用途                                                                                     |
| ---------------- | -------- | ------ | ---------------------------------------------------------------------------------------- |
| `SYNC_DRY_RUN`   | boolean  | `0`    | `1` = 只输出计划，不写入任何数据                                                         |
| `SYNC_MAX_ITEMS` | number   | `50`   | 单次运行处理的条目上限；增量跳过的条目不消耗预算。**`0` 不是「无限」**，低于 1 回落为 50 |
| `FULL_SYNC`      | boolean  | `0`    | `1` = 忽略条目/页数上限并关闭增量跳过；首次迁移使用                                      |

#### 5. 增量与产物（6 项）

| 名称                    | 数据类型 | 默认值                         | 用途                                                                  |
| ----------------------- | -------- | ------------------------------ | --------------------------------------------------------------------- |
| `SYNC_INCREMENTAL`      | boolean  | `1`                            | 按条目指纹跳过已同步项；`FULL_SYNC=1` 时自动失效                      |
| `SYNC_STATE_FILE`       | path     | `.cache/sync-state.json`       | 增量指纹文件；删除即重新全量比对。CI 通过 cache 跨运行保留            |
| `SYNC_UNMATCHED_LOG`    | path     | `.cache/unmatched.json`        | 未匹配/歧义/重复目标名单（upsert 去重），供人工补外链                 |
| `SYNC_REPORT_FILE`      | path     | `.cache/sync-report.json`      | 机器可读运行报告                                                      |
| `SYNC_SUMMARY_FILE`     | path     | `.cache/sync-summary.md`       | Markdown 运行摘要（含待核对原因分布）                                 |
| `FULL_SYNC_CURSOR_FILE` | path     | `.cache/full-sync-cursor.json` | 仅 `FULL_SYNC=1` 使用的分页游标；常规运行不读不写，空页自动清除该书架 |

### 配置注意事项

1. **布尔值写法**：`1/true/yes/on` 为真，其余为假；空值取默认值。
2. **非法值处理**：枚举写错会告警并回落到默认值；分类白名单写错则整体作废（不同步任何分类）——刻意失败在关闭一侧，避免误同步。
3. **相对路径**：产物、增量状态与全量游标路径均按进程工作目录解析，目录不存在会自动创建。
4. **CI 与本地差异**：CI runner 是临时的，增量状态与全量游标依赖 Actions cache；未匹配清单随 artifact 上传（保留 7 天），不会留在仓库里。
5. **改配置不改代码**：所有可调项均通过环境变量读取；新增配置项时同步更新 `.env.example` 与本节，否则 `verify:docs` 会失败。

## 定时运行与手动触发

`.github/workflows/sync.yml` 是定时任务入口，提供两种触发方式：

| 方式 | 操作                                                      | 说明                                                              |
| ---- | --------------------------------------------------------- | ----------------------------------------------------------------- |
| 定时 | 每天上海时间 03:15（前一日 19:15 UTC）                    | 增量推进：缓存 `.cache/sync-state.json`，已同步条目不消耗条目预算 |
| 手动 | 仓库 → Actions → 左侧 `sync` → 右侧 **Run workflow** 按钮 | 可选 `full_sync` / `dry_run` / `progress` 三个输入                |

全量运行额外缓存 `.cache/full-sync-cursor.json`：被超时杀掉后从停下的那一页继续；空页或走完自动删除该书架游标。常规运行不读不写该文件。

手动输入优先于仓库 Variables，且只对本次运行生效，不会残留到定时任务。运行前会先跑 `verify:all` 离线断言门禁；无论成败都会发布 Job Summary，并上传一份包含报告、摘要、未匹配清单与全量游标（仅全量时存在）的 artifact（保留 7 天）。

注入位置见上方[配置](#配置)章节：Secret 两项放入 **Secrets**，其余全部配置项放入 **Variables**（可选，未设置时用代码默认值）。

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

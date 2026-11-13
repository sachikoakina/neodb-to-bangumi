# 映射与匹配规则

本文是实现的权威描述；`scripts/verify-mapping.ts` / `verify-matching.ts` 逐行断言其中的表格，`tests/*.test.ts` 覆盖同一批边界。

## 状态映射

| NeoDB `shelf_type` | 含义                | Bangumi `type` | 含义 | 转换条件                    |
| ------------------ | ------------------- | -------------- | ---- | --------------------------- |
| `wishlist`         | 想看/想读/想玩      | `1`            | 想看 | 无条件                      |
| `progress`         | 在看/在读/在玩/在听 | `3`            | 在看 | 目标已有 `4`（搁置）时跳过  |
| `complete`         | 看完/读完/通关      | `2`            | 看过 | 受 `SYNC_STATUS_GUARD` 约束 |
| `dropped`          | 放弃                | `5`            | 抛弃 | 目标已有 `4` 时跳过         |

保护规则：

1. **搁置保护**（始终开启）：NeoDB 没有「搁置」概念，无法表达该意图；目标为 `4` 时不覆盖，记 skipped。
2. **`SYNC_STATUS_GUARD=no-downgrade`**：只固定状态字段——Bangumi 现有「看过」（2）不被想看/在看降级，评分/短评/隐私仍按各自开关合并，不会整条跳过。
3. **未知 shelf_type**：失败在关闭一侧，记 skipped 并告警。
4. **目标认领**：同一 Bangumi `subject` 被多条 NeoDB 标记命中时，只让最强认领者写入。排序：外链（link）> 标题（title）；`complete` > `progress`/`wishlist` > `dropped`；仍相同取较小 NeoDB uuid。落败者记 `skipped` 并进入待核对名单（`duplicate-target`），不读收藏、不写目标。

## 字段映射

| 字段 | 规则                                                                                                                                                                                                 |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 评分 | NeoDB `rating_grade` 与 Bangumi `rate` 同为 0–10，**直接透传**。默认 `bangumi_prefer`：目标非 0 分保留、为 0 才填充、源无分不清空；`overwrite` 才覆盖。                                              |
| 短评 | NeoDB `comment_text` 与 Bangumi `comment` 均为纯文本，**直接透传**。默认 `bangumi_prefer`：目标非空短评保留、为空（含仅空白）才填充、源为空不清空；`overwrite` 才覆盖（空值会清空目标）。            |
| 隐私 | `SYNC_BANGUMI_PRIVATE_MODE=target`（默认）统一写 `SYNC_BANGUMI_PRIVATE`；`source` 逐条跟随 NeoDB：`visibility=2` → `private=true`，`0/1` → `false`，源缺失保留目标现值/配置兜底。隐私始终参与 diff。 |
| 时间 | **无法迁移**：Bangumi API 不接受自定义收藏时间，服务端写 `updated_at`。`unchanged` 时不发请求，目标时间不变。                                                                                        |
| 进度 | 见下节，`SYNC_PROGRESS=1` 才写。                                                                                                                                                                     |

## 进度拉满（`SYNC_PROGRESS=1`，仅 complete 条目）

| Bangumi 条目类型 | 上限来源                                                        | 拉满方式                                                                                                                   |
| ---------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 书籍 1           | `subject.eps` / `subject.volumes`                               | 随收藏 upsert 同一请求写 `ep_status`/`vol_status` 至上限；**总量缺失的维度跳过**（迁移语义，不瞎填）；已达上限的维度不重写 |
| 电影             | 正片列表                                                        | 只补第一个正片集；无正片仅收藏；SP 与 OP/ED 永不处理                                                                       |
| 动画 2 / 真人 6  | 正片列表（`SYNC_INCLUDE_SP`/`SYNC_INCLUDE_OP_ED` 才含对应类型） | 逐集 `PUT /v0/users/-/collections/-/episodes/{id}` 标记看过；已 `type=2` 的集零请求                                        |
| 音乐 3 / 游戏 4  | —                                                               | 平台无对应进度字段，不写                                                                                                   |

- OP/ED（`type=2/3`）默认不纳入：看完本篇不代表看过主题曲；开启后仍只作用于非电影。
- 幂等保证：分集层面以**分集实际 `type=2`** 为准，不以上条目「看过」为准；第二轮运行 missing 为空 → 零请求。
- **分集独立于收藏字段**：收藏的状态/评分/短评/隐私完全一致时，仍会读取分集并补齐缺口；书籍进度随收藏 upsert 提交，不在这一路。
  - 边界：这句只在条目**本轮进入处理**时成立。增量门（`src/rules/progress-gate.ts` 的 `isUpToDate`）在 `processMark` 之前，因此进度适用但未拉满的条目会保持 pending 并进入下一轮；只有该条被记为 `progress: done` 后才整体跳过。这也意味着开启 `SYNC_PROGRESS` 不需要 `FULL_SYNC`。
- **失败可重试**：分集列表/状态读取失败或单集写入失败 → 该条记 `failed`，并清除其增量指纹，下一轮重新检查；已成功写入的集不会重复发请求。
- **dry-run 不读分集**：dry-run 只打印收藏字段计划，不校验分集完整性（避免为每条增加两次读取）。

## 匹配策略（三级）

```text
1. 外链直连：external_resources 里的 (bgm|bangumi).tv/subject/{id} —— 最可靠
2. 标题搜索：display_title → title → localized_title[].text 依次作为关键词，
   按分类限定 subject_type（book→1；movie,tv→2,6；music→3；game→4；
   podcast/performance 无对应，直接跳过），
   候选 name/name_cn 经 trim().toLowerCase() 后必须与搜索标题完全相等
3. 证据裁决：
   a0. ISBN 裁决（仅书籍，命中即定案，先于年份）：
      源 ISBN 取自 NeoDB 条目详情（书架列表不含），候选 ISBN 取自主 infobox
      的 ISBN 与全部「版本:*」子项；两侧归一化（去连字符、10 位转 13 位、
      校验位）后精确相等才算命中。
      · 命中 1 个 → matched（via=isbn），不再比较年份（再版必然有差）
      · 命中 ≥2 个 → ambiguous（hold=duplicate-isbn），不写入、不猜顺序
      · 未命中 / 任一侧没有 ISBN → 中性，继续下面的年份裁决
   a. 年份过滤（动画 2 / 真人 6 / 书籍 1 / 音乐 3 / 游戏 4）：
      双方都有 → |候选 − 源| ≤ 容差（书籍用 SYNC_YEAR_TOLERANCE_BOOK，
      其余用 SYNC_YEAR_TOLERANCE）；超容差 → 剔除（负证据：知道不是它）
   b. 影视年份证据（SYNC_MATCH_STRICT=1 且来源 movie/tv）：
      源年份或候选年份任一不可判定 → 该候选不参与裁决；
      全部候选因此出局 → ambiguous（hold=year-missing）——
      movie↔剧场版 的形态互证恒真，不足以单独定案
   c. 媒体形态过滤（白名单全等匹配，大小写不敏感）：
      · movie ← 电影 / 剧场版 / 劇場版 / 映画 / 映畫
      · tv    ← TV / Web / 电视剧 / 剧集 / 网络剧 / 短剧 / 动态漫画 /
                日剧 / 韩剧 / 美剧 / 英剧 / 泰剧 / 港剧 / 台剧 /
                华语剧 / 欧美剧
      · 其余（OVA / OAD / 动画 / 舞台剧 / 综艺 / 纪录片 / 未定 / 空）
        不可判定 → 不参与冲突判断，也不拒绝
      国别剧平台必须归一为 tv：缺少它们时「电影 ↔ 剧集」这种最明显的
      冲突会被跳过（历史错配 403493 / 164871 即由此产生）
   d. 年份接近度打分：唯一最高分 → 命中；并列或全部不可知 → ambiguous
   e. 严格模式（其余类目）：唯一候选若年份无法核对（任一侧未知）且双方
      形态无法相互印证（书籍/音乐/游戏无形态证据，等价于仅看年份核对）
      → 证据不足持留（hold=insufficient-evidence），转 ambiguous
      进待核对名单——宁可漏配，不可错配
```

- 不猜、不模糊匹配、不跨分类回退；多候选不再取第一个。
- 歧义不写入，记 unresolved，原因分两种：`ambiguous-bangumi-match`（多候选并列 / 证据不足，含同一 ISBN 命中多个 subject 的 `duplicate-isbn`）与 `ambiguous-year-missing`（影视年份不可判定）；本方向没有「直连回退」可用。
- 搜索失败、年份读取失败归 `failed`（可重跑），**不**伪装成「没有结果」；读取收藏失败同样按 failed 处理，绝不当成「未收藏」覆盖。
- 条目缺年份时按 `api_url` 拉取 NeoDB 条目详情补齐并缓存；失败不缓存，下轮重试。
- 未匹配与歧义写入待核对名单（upsert 去重，带 category/shelf/uuid）；在 NeoDB 条目上补 Bangumi 外链后下轮即可命中。
- 匹配审计（`match-audit.json`，dry-run 也产出）：每条目记录匹配方式/候选/证据/结局，错配可离线复核，也是清理错配收藏的依据。
- 每条目处理结束后统一节流，避免全量运行把请求打出突发。

## 全量游标

- 仅 `FULL_SYNC=1` 且非 dry-run 读写 `FULL_SYNC_CURSOR_FILE`；按书架记录下一页。
- 每页处理完写一次；空页、已到上报页数时删除该书架键。
- 认证中止等主动停止保留当前页（`nextPage = page`），续跑时整页重走——写入幂等，不会漏条目。
- 常规运行永远从第 1 页开始，靠增量指纹跳过已同步条目。

## 与原项目（Audiovisual-Transporter）的差异

- 书籍进度只有一个语义：**源端 complete 即拉满**。`planBookProgress(existing, subject)` 按 `subject.eps` / `subject.volumes` 把对应维度推到上限，总量缺失的维度跳过；目标端当前进度为 0 不构成「未知维度」，不影响拉满。
- 不引入标记时间策略：Bangumi 没有可写的收藏时间字段。
- 其余规则（状态映射方向、年份三态过滤、分集幂等、401 中止、unresolved 语义、目标认领裁决）与原项目一致。

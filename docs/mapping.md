# 映射与匹配规则

本文是实现的权威描述；`scripts/verify-mapping.ts` / `verify-matching.ts` 逐行断言其中的表格。

## 状态映射

| NeoDB `shelf_type` | 含义                | Bangumi `type` | 含义 | 转换条件                    |
| ------------------ | ------------------- | -------------- | ---- | --------------------------- |
| `wishlist`         | 想看/想读/想玩      | `1`            | 想看 | 无条件                      |
| `progress`         | 在看/在读/在玩/在听 | `3`            | 在看 | 目标已有 `4`（搁置）时跳过  |
| `complete`         | 看完/读完/通关      | `2`            | 看过 | 受 `SYNC_STATUS_GUARD` 约束 |
| `dropped`          | 放弃                | `5`            | 抛弃 | 目标已有 `4` 时跳过         |

保护规则：

1. **搁置保护**（始终开启）：NeoDB 没有「搁置」概念，无法表达该意图；目标为 `4` 时不覆盖，记 skipped。
2. **`SYNC_STATUS_GUARD=no-downgrade`**：Bangumi 现有「看过」（2）不被想看/在看降级；评分短评仍按各自开关合并。
3. **未知 shelf_type**：失败在关闭一侧，记 skipped 并告警。

## 字段映射

| 字段   | 规则                                                                                                                                                    |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 评分   | NeoDB `rating_grade` 与 Bangumi `rate` 同为 0–10，**直接透传**。默认 `bangumi_prefer`：目标非 0 分保留、为 0 才填充、源无分不清空；`overwrite` 才覆盖。 |
| 短评   | 默认 `bangumi_prefer` 只填空；`overwrite` 覆盖含清空。                                                                                                  |
| 可见性 | 默认不映射。`SYNC_MAP_PRIVATE=1` 时 NeoDB `visibility=2`（私密）→ `private: true`。                                                                     |
| 时间   | **无法迁移**：Bangumi API 不接受自定义收藏时间，服务端写 `updated_at`。`unchanged` 时不发请求，目标时间不变。                                           |
| 进度   | 见下节，`SYNC_PROGRESS=1` 才写。                                                                                                                        |

## 进度拉满（`SYNC_PROGRESS=1`，仅 complete 条目）

| Bangumi 条目类型 | 上限来源                          | 拉满方式                                                                                                                   |
| ---------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 书籍 1           | `subject.eps` / `subject.volumes` | 随收藏 upsert 同一请求写 `ep_status`/`vol_status` 至上限；**总量缺失的维度跳过**（迁移语义，不瞎填）；已达上限的维度不重写 |
| 电影             | 正片列表                          | 只补第一个正片集；无正片仅收藏                                                                                             |
| 动画 2 / 真人 6  | 正片列表（`includeSp` 才含 SP）   | 逐集 `PUT /v0/users/-/collections/-/episodes/{id}` 标记看过；已 `type=2` 的集零请求                                        |
| 音乐 3 / 游戏 4  | —                                 | 平台无对应进度字段，不写                                                                                                   |

幂等保证：分集层面以**分集实际 `type=2`** 为准，不以上条目「看过」为准；第二轮运行 missing 为空 → 零请求。

## 匹配策略（三级，失败即 unresolved）

```text
1. 外链直连：external_resources 里的 (bgm|bangumi).tv/subject/{id} —— 最可靠
2. 标题搜索：display_title → title → localized_title[].text 依次作为关键词，
   按分类限定 subject_type（book→1；movie,tv→2,6；music→3；game→4；
   podcast/performance 无对应，直接跳过），
   候选 name/name_cn 经 trim().toLowerCase() 后必须与搜索标题完全相等
3. 年份软过滤：仅动画 2 / 真人 6 参与，三态规则——
   源年份未知 → 过滤不运行；候选年份未知 → 通过；
   双方都有 → |候选 − 源| ≤ SYNC_YEAR_TOLERANCE 才保留
```

- 不猜、不模糊匹配、不跨分类回退；
- 条目缺年份时按 `api_url` 拉取 NeoDB 条目详情补齐并缓存；
- 全部失败 → `unresolved` 并写入待核对名单（upsert 去重），在 NeoDB 条目上补 Bangumi 外链后下轮即可命中。

## 与原项目（Audiovisual-Transporter）的差异

- 书籍进度在迁移语境下以「源 complete」为拉满意图（`planBookProgress` 的 `sourceComplete` 分支）；原豆瓣链路的保守行为（0 视为未知不触碰）保留为缺省分支，两种语境一个纯函数。
- 其余规则（状态映射方向、年份三态过滤、分集幂等、401 中止、unresolved 语义）与原项目一致。

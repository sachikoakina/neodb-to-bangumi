/**
 * 共享词汇表 —— NeoDB 与 Bangumi 两端的数据结构。
 *
 * 刻意集中在这里：客户端之间不允许互相导入类型，所有跨端结构都从本模块取。
 */

/** NeoDB 书架类型。 */
export type ShelfType = 'wishlist' | 'progress' | 'complete' | 'dropped';

export const SHELF_TYPES: readonly ShelfType[] = [
  'wishlist',
  'progress',
  'complete',
  'dropped',
];

/** NeoDB 目录分类。`podcast` 与 `performance` 在 Bangumi 没有对应类型。 */
export type NeodbCategory =
  'book' | 'movie' | 'tv' | 'music' | 'game' | 'podcast' | 'performance';

/** NeoDB 目录条目（书架列表内联版本 + 条目详情共用）。 */
export type NeodbItem = {
  id: string;
  type: string;
  uuid: string;
  url: string;
  api_url: string;
  category: NeodbCategory | string;
  parent_uuid: string | null;
  display_title: string;
  title: string;
  brief: string;
  description: string;
  cover_image_url: string;
  rating: number;
  rating_count: number;
  localized_title?: { lang?: string; text?: string }[];
  /** 外链平台，已验证包含 bangumi / douban / imdb / tmdb。 */
  external_resources: { url: string }[];
  /** MovieSchema / TVSchema 才有。 */
  year?: number;
  /** EditionSchema（书籍）才有。 */
  pub_year?: number;
  /** 书籍详情（`api_url`）才有；书架列表不返回。 */
  isbn?: string;
};

/** PagedMarkSchema 里 `data[]` 的一项：书架标记（内联条目）。 */
export type NeodbShelfMark = {
  shelf_type: ShelfType | string;
  /** 0 = 公开，1 = 仅关注者，2 = 私密。 */
  visibility?: number;
  item: NeodbItem;
  created_time?: string;
  comment_text?: string;
  /** 0 = 未评分，2 = 一星 … 10 = 五星（即 0–10 分制）。 */
  rating_grade?: number;
};

/** GET /api/me/shelf/{type} 的响应。 */
export type NeodbPagedMark = {
  data: NeodbShelfMark[];
  pages: number;
  count: number;
};

/** GET /api/me —— 当前 NeoDB 账号。 */
export type NeodbMe = {
  username?: string;
  display_name?: string;
  url?: string;
};

/** Bangumi 条目类型：1 书籍，2 动画，3 音乐，4 游戏，6 真人。 */
export type BangumiSubjectType = 1 | 2 | 3 | 4 | 6;

/** Bangumi 收藏类型：1 想看，2 看过，3 在看，4 搁置，5 抛弃。 */
export type BangumiCollectionType = 1 | 2 | 3 | 4 | 5;

/** Bangumi 信息表项；`版本:*` 这类条目的 value 是子键值对数组。 */
export type BangumiInfoboxItem = {
  key: string;
  value: string | { k: string; v: string }[];
};

export type BangumiSubject = {
  id: number;
  type: BangumiSubjectType;
  name: string;
  name_cn: string;
  platform?: string;
  /** 搜索端点（SlimSubject）带 `air_year` / `air_date`；完整条目带 `date`。 */
  air_year?: number;
  air_date?: string;
  date?: string;
  /** 书籍总章节数。 */
  eps?: number;
  /** 书籍总卷数。 */
  volumes?: number;
  /** 完整条目才有：书籍的 ISBN / 作者 / 版本都在这里。 */
  infobox?: BangumiInfoboxItem[];
};

export type BangumiEpisode = {
  id: number;
  /** 0 本篇，1 SP，2 OP，3 ED。 */
  type: number;
  sort: number;
  ep?: number;
};

export type BangumiEpisodeState = {
  type: number;
  /** API 返回 Unix 秒。 */
  updatedAt?: number;
};

export type BangumiCollection = {
  subject_id: number;
  subject_type: BangumiSubjectType;
  rate: number;
  type: BangumiCollectionType;
  comment?: string | null;
  ep_status?: number;
  vol_status?: number;
  updated_at: string;
  private: boolean;
  subject?: BangumiSubject;
};

export type BangumiUser = {
  id: number;
  username: string;
  nickname: string;
};

/**
 * 统一的三态读取结果。
 *
 * `absent`（404）是唯一允许据此**新建**的答案；`error`（401、5xx、无响应）绝不
 * 可以被当成「目标为空」来覆盖 —— 拒绝回答与无话可说不是同一件事。
 */
export type ReadResult<T> =
  | { status: 'found'; value: T }
  | { status: 'absent' }
  | { status: 'error'; scope: 'auth' | 'item'; message: string };

/**
 * 写入失败的三种归因 —— 决定调用方能不能继续。
 *
 * `auth`（401/403）：凭据失效，必须中止整轮；
 * `not-found`（404）：服务端拒绝为该目标建收藏（条目合并/锁定/不可收藏），
 *   重试无意义，转待核对让人处理；
 * `transient`（5xx/超时/其余）：可以下一轮再试，记 failed 但保留可重跑语义。
 */
export type WriteFailureKind = 'auth' | 'not-found' | 'transient';

/** 写入结果。失败时携带状态码与归一化短消息，供审计与摘要复用。 */
export type WriteResult =
  | { ok: true }
  | {
      ok: false;
      kind: WriteFailureKind;
      /** HTTP 状态码；无响应（超时 / DNS）为 null。 */
      status: number | null;
      /** 归一化短消息：`collection 123 returned 404: Not Found: <body>`。 */
      message: string;
    };

/**
 * 缓存里的增量状态被丢弃的原因 —— 非 null 表示本轮是「按空状态运行」。
 *
 * 不把「文件不存在」算进来：首次运行本来就没有状态，那是正常起点而不是重置。
 */
export type SyncStateDiscardReason =
  'invalid-json' | 'version-mismatch' | 'shape-mismatch';

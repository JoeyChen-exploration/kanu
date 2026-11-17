// 前后端共用的接口类型（SRS 6.1）。

export interface ApiError {
  ok: false;
  code: string;
  /** 给玩家看的中文 */
  message: string;
}

export interface ConfigResponse {
  ok: true;
  clientId: string | null;
  devAuth: boolean;
  disabled: boolean;
}

export interface SessionUser {
  id: string;
  name: string;
  avatar: string | null;
}

export interface AuthTokenResponse {
  ok: true;
  /** Discord access token，前端拿去 commands.authenticate；开发登录时为 null */
  accessToken: string | null;
  /** 卡奴自己的会话 token，之后所有 /api 请求带 Authorization: Bearer */
  session: string;
  user: SessionUser;
}

export interface WalletView {
  /** 查不到（旺财没开、网络错）时为 null，界面显示"金币暂时查不到"（FR-AUTH-7） */
  coins: number | null;
  /** 旺财还没给这个人开户（进服满 3 天才开） */
  opened: boolean;
}

// ---------- 卡牌（M2） ----------
// 只放玩家能知道的信息（FR-INV-2、NFR-SEC-2）：真伪、真实品相、来源永远不出现在这里。

export type CardLocation = 'inventory' | 'showcase';

export interface CardView {
  id: number;
  templateId: string;
  name: string;
  seriesId: string;
  seriesName: string;
  rarity: string;
  tags: string[];
  flavor: string | null;
  /** 看得见的外层风格 */
  style: string;
  /** 编号限定的序列号（如 7 表示 07/50），其他风格是 null */
  serialNo: number | null;
  location: CardLocation;
  /** 放在哪本卡册里；散放在桌面上是 null */
  binderId: number | null;
  /** 散放在桌面上时，从第几个营业日开始散放（前端按天数画磨损；只是公开的天数，不代表真实品相） */
  looseSinceDay: number | null;
  /** 公开市场价（没封壳按未评级算） */
  price: number;
  createdAt: number;
}

// ---------- 进货和卡包（DESIGN 4，2026-11-17 卡包重做） ----------

export interface StorePack {
  seriesId: string;
  name: string;
  /** themed 主题包 / premium 典藏包 */
  kind: string;
  kindName: string;
  price: number;
  /** 这种卡包里一共几张卡（图鉴） */
  cardCount: number;
  /** 各稀有度的爆率（百分比，给玩家看的） */
  odds: Array<{ rarity: string; percent: number }>;
}

export interface StoreResponse {
  ok: true;
  packs: StorePack[];
  /** 本营业日电脑订货还能买几包；测试账号是 null（不限） */
  packsLeftToday: number | null;
}

export interface BuyPacksResponse {
  ok: true;
  credits: number;
  packsLeftToday: number | null;
  /** 新买到的卡包 id（原封不动放进库存） */
  packIds: number[];
}

export interface SealedPackGroup {
  seriesId: string;
  name: string;
  kind: string;
  /** 这一种还没拆的卡包 id */
  ids: number[];
}

export interface SealedPacksResponse {
  ok: true;
  groups: SealedPackGroup[];
}

export interface OpenPackResponse {
  ok: true;
  cards: CardView[];
  pityCount: number;
  pityTriggered: boolean;
}

export interface InventoryResponse {
  ok: true;
  cards: CardView[];
  total: number;
  page: number;
  pageSize: number;
}

export interface CollectionEntry {
  templateId: string;
  name: string;
  rarity: string;
  tags: string[];
  /** 有过这张卡（卖掉也算） */
  owned: boolean;
  /** 现在手上有几张 */
  count: number;
  /** 大师图鉴：这张卡可能出的每种外层风格（不可能出的不列），有过没有、现在手上几张 */
  styles: Array<{ style: string; name: string; owned: boolean; count: number }>;
  /** 每种可能的风格都有过 */
  master: boolean;
}

export interface CollectionResponse {
  ok: true;
  /** 每个系列一本图鉴册；kind 是主题包 / 典藏包（封面不同）；master 是集齐所有风格的张数 */
  series: Array<{ id: string; name: string; kind: string; total: number; owned: number; master: number; cards: CollectionEntry[] }>;
}

// ---------- 柜台（M4） ----------
// 心理价位、个人浮动是隐藏的，不出现在这里（NFR-SEC-2）。

export type CustomerStatus = 'waiting' | 'sold' | 'left' | 'dismissed';

export interface CustomerView {
  id: number;
  type: string;
  typeName: string;
  /** 最近一句台词 */
  line: string;
  /** 想要什么：card 要卡（text 是"火属性的 SR 以上的卡"或"「霓虹龙·影」"），pack 要没拆的卡包 */
  demand: { kind: 'card' | 'pack'; text: string };
  budgetLow: number;
  budgetHigh: number;
  patience: number;
  maxPatience: number;
  status: CustomerStatus;
  /** 上次还价报的数（还价之后才有） */
  counterPrice: number | null;
}

export interface CounterResponse {
  ok: true;
  /** 第几个营业日（玩家自己推进，打烊 +1） */
  day: number;
  /** 眼前这一位；没人了是 null */
  current: CustomerView | null;
  /** 今天已经接待过的（成交、走人、请走），最新的在最后 */
  served: CustomerView[];
  /** 今天的顾客都接待完了，可以打烊。今天一共来几位不告诉玩家 */
  done: boolean;
}

export interface EndDayResponse {
  ok: true;
  /** 打烊后进入的新营业日 */
  day: number;
}

export interface EligibleCardsResponse {
  ok: true;
  cards: Array<{ card: CardView; quickPrice: number }>;
  /** 开箱主播要的是没拆的卡包 */
  packs: Array<{ id: number; seriesId: string; name: string; kind: string; quickPrice: number }>;
  /** 柜台翻卡册用：每本卡册里有几张符合这位顾客 */
  binders: Array<{ id: number; kind: string; name: string; used: number; slots: number; matchCount: number }>;
  /** 桌面散放的卡（翻卡册接口里 binderId = 0） */
  loose: { count: number; matchCount: number };
  /** 珍藏柜里的卡也能卖（翻卡册接口里 binderId = showcase） */
  showcase: { count: number; matchCount: number };
}

/** GET /api/counter/:id/binder/:binderId?page=&matchFirst= ：按这位顾客翻一本卡册（0 = 桌面散放） */
export interface CounterBinderPageResponse {
  ok: true;
  binder: { id: number; kind: string; name: string };
  page: number;
  pages: number;
  matchFirst: boolean;
  /** match = 符合这位顾客的要求；不符合的 quickPrice 为 null，前端变暗、不能点 */
  cards: Array<{ card: CardView; match: boolean; quickPrice: number | null }>;
}

export interface OfferResponse {
  ok: true;
  outcome: 'deal' | 'counter' | 'too_high' | 'left' | 'caught';
  customer: CustomerView;
  /** 这位走了以后进门的下一位（没有了是 null） */
  next: CustomerView | null;
  done: boolean;
  /** 成交价（deal 时） */
  price: number | null;
  credits: number;
  reputation: number;
}

export interface MeResponse {
  ok: true;
  user: SessionUser;
  credits: number;
  reputation: number;
  weekNo: number;
  wallet: WalletView;
  /** 连续多少包正规包没出 SSR 以上（保底进度） */
  pityCount: number;
  /** 本营业日还能开几包正规包 */
  packsLeftToday: number;
  /** 第几个营业日 */
  gameDay: number;
  /** 测试账号（DEV_AUTH=1 且在 DEV_UNLIMITED_IDS 里）才是 true：前端显示测试工具 */
  devTools: boolean;
}

// ---------- 卡册（DESIGN 4.5） ----------

export interface BinderView {
  id: number;
  kind: string;
  name: string;
  slots: number;
  used: number;
  effect: string;
}

export interface BinderCatalogItem {
  kind: string;
  name: string;
  price: number;
  slots: number;
  effect: string;
}

export interface BindersResponse {
  ok: true;
  binders: BinderView[];
  /** 桌面上散放的卡（会磨损） */
  loose: { slots: number; cards: CardView[] };
  /** 用品店里能买的卡册 */
  catalog: BinderCatalogItem[];
}

export interface BinderPageResponse {
  ok: true;
  binder: BinderView;
  page: number;
  pages: number;
  cards: CardView[];
}

export interface BuyBinderResponse {
  ok: true;
  credits: number;
  binder: BinderView;
  /** 买完自动从桌面收进来几张散卡 */
  placed: number;
}

/** 珍藏柜的状态（FR-INV-11）：展示分只按公开的稀有度和风格算 */
export interface ShowcaseStatus {
  /** 0 = 还没解锁 */
  level: number;
  slots: number;
  used: number;
  score: number;
  /** 顾客预算和心理价位加了几 %（整数） */
  priceBonusPct: number;
  patienceBonus: number;
  /** 下一级；已经满级为 null */
  next: { level: number; price: number; slots: number } | null;
}

/** GET /api/showcase */
export interface ShowcaseResponse {
  ok: true;
  status: ShowcaseStatus;
  cards: CardView[];
}

/** POST /api/showcase/upgrade：解锁或升一级 */
export interface ShowcaseUpgradeResponse {
  ok: true;
  credits: number;
  status: ShowcaseStatus;
}

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
}

export interface CollectionResponse {
  ok: true;
  series: Array<{ id: string; name: string; total: number; owned: number; cards: CollectionEntry[] }>;
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
  demand: { rarities: string[]; tag: string | null; text: string };
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
  customers: CustomerView[];
  /** 第几个营业日（玩家自己推进，打烊 +1） */
  day: number;
}

export interface EndDayResponse {
  ok: true;
  /** 打烊后进入的新营业日 */
  day: number;
}

export interface EligibleCardsResponse {
  ok: true;
  cards: Array<{ card: CardView; quickPrice: number }>;
}

export interface OfferResponse {
  ok: true;
  outcome: 'deal' | 'counter' | 'too_high' | 'left' | 'caught';
  customer: CustomerView;
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

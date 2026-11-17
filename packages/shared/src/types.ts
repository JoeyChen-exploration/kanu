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

export interface OpenPackResponse {
  ok: true;
  cards: CardView[];
  credits: number;
  pityCount: number;
  pityTriggered: boolean;
  packsLeftToday: number;
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

export interface MeResponse {
  ok: true;
  user: SessionUser;
  credits: number;
  reputation: number;
  weekNo: number;
  wallet: WalletView;
  /** 连续多少包正规包没出 SSR 以上（保底进度） */
  pityCount: number;
  /** 今天还能开几包正规包 */
  packsLeftToday: number;
}

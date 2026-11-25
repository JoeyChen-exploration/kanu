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

/** inventory 库存（卡册或桌面）、showcase 珍藏柜、grading 送评中（在星港评级社） */
export type CardLocation = 'inventory' | 'showcase' | 'grading' | 'pawned';

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
  /** 评级社封壳（公开）：总分 1–10 或 BL（黑标），四个分项 centering / corners / edges / surface；errata 是评级社认定的错版 */
  slab: { score: string; subgrades: Record<string, number>; errata: boolean } | null;
  /** 评级社拒评（疑似假卡，公开标记） */
  gradeRejected: boolean;
  /** 送评中时，第几个营业日出结果 */
  readyDay: number | null;
  /** 从哪来的（公开）：store 电脑订货（保证正品）、wholesale 电话批发（不保证，可能混着假卡） */
  acquired: 'store' | 'wholesale';
}

// ---------- 鉴定（M3，DESIGN 5，2026-11-17 用户重定） ----------
// 放大镜是柜台上的道具，拖到卡上查验；送评在电话里（电话要买）。没有鉴定机构。

/** 放大镜查验的结论（只给卡的主人看，不改卡价）。looks：fake 看出是假的 / looks_real 看起来是真的（漏看也这么说） */
export interface InspectionView {
  looks: 'fake' | 'looks_real';
  /** 品相大概在这相邻两档，如 ["8","9"]、["10","BL"] */
  gradeRange: [string, string];
  /** 认出是错版 */
  errataFound: boolean;
}

/** GET /api/cards/:id/appraisal、POST /api/cards/:id/inspect */
export interface CardAppraisalResponse {
  ok: true;
  card: CardView;
  /** 放大镜查过就有（每张卡只查一次） */
  inspection: InspectionView | null;
  /** 送评状态：pending 评级中、slab 已封壳、rejected 被拒评 */
  grading: 'pending' | 'slab' | 'rejected' | null;
  /** 送评费 */
  gradingFee: number;
  canInspect: boolean;
  canGrade: boolean;
}

/** 打烊时评级社出的结果（只给主人看） */
export interface AppraisalOutcome {
  cardId: number;
  name: string;
  outcome: 'slab' | 'rejected';
  /** 封壳时的评分 */
  score: string | null;
  /** 评级社认定是错版 */
  errata: boolean;
}

/** GET /api/phone：电话（买了没有、价格、在评级社的卡、批发商今天能不能订） */
export interface PhoneResponse {
  ok: true;
  owned: boolean;
  price: number;
  day: number;
  grading: CardView[];
  wholesale: {
    /** 今天还能订几盒 */
    leftToday: number;
    /** 每种卡包一盒多少钱（一盒 boxPacks 包） */
    offers: Array<{ seriesId: string; name: string; kind: string; packs: number; boxPrice: number; normalPrice: number }>;
    /** 已经订了、送货员还没来（或还没处理）的那一盒 */
    /** 等送货的订单；arriveDay = 送货员哪天来（隔日送达） */
    pending: { orderId: number; seriesName: string; packs: number; price: number; arriveDay: number } | null;
  };
}

/** POST /api/phone/wholesale { seriesId }：下单（不扣钱）。送货员会作为下一位顾客来柜台，货到付款 */
export interface WholesaleResponse {
  ok: true;
  order: { orderId: number; seriesId: string; seriesName: string; packs: number; price: number };
}

/** POST /api/counter/:id/receive：在柜台收下送货员的货、付钱 */
export interface ReceiveResponse {
  ok: true;
  credits: number;
  cost: number;
  packIds: number[];
  next: CustomerView | null;
  done: boolean;
}

/** POST /api/phone/buy */
export interface BuyPhoneResponse {
  ok: true;
  credits: number;
}

/** POST /api/cards/:id/grade：送评一张（要电话） */
export interface GradeResponse {
  ok: true;
  credits: number;
  card: CardView;
}

/** POST /api/phone/grade { cardIds }：一次寄好几张去送评（全部能送才扣钱，一起送走） */
export interface GradeBatchResponse {
  ok: true;
  credits: number;
  /** 一共扣了多少 */
  cost: number;
  cards: CardView[];
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
  /** 电话批发来的（批发商不保证正品） */
  wholesale: boolean;
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

/** received：送货员的货收下了（2026-11-18） */
export type CustomerStatus = 'waiting' | 'sold' | 'left' | 'dismissed' | 'received';

export interface CustomerView {
  id: number;
  type: string;
  typeName: string;
  /** 最近一句台词 */
  line: string;
  /** 想要什么：card 要卡（text 是"火属性的 SR 以上的卡"或"「霓虹龙·影」"），pack 要没拆的卡包；
   *  delivery 是送货员（送电话批发的货，货到付款），delivery 字段给出这盒货 */
  demand: { kind: 'card' | 'pack' | 'delivery'; text: string; delivery?: { orderId: number; seriesId: string; seriesName: string; packs: number; price: number } };
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
  /** 欠租中：柜台关门，先去店铺页交租 / 抵押（FR-RENT-2） */
  arrears?: { amount: number; week: number } | null;
}

export interface EndDayResponse {
  ok: true;
  /** 打烊后进入的新营业日 */
  day: number;
  /** 这次打烊出结果的鉴定 / 送评 */
  appraisals: AppraisalOutcome[];
  /** 今天是交租日、交上了：交了多少、第几周 */
  rentPaid?: { amount: number; week: number } | null;
  /** 交租日钱不够：进入欠租，没有进入下一天（day 还是今天） */
  arrears?: { amount: number; week: number } | null;
  /** 过了赎回期、归房东的抵押卡张数 */
  forfeited?: number;
}

/** 房租状态（FR-RENT-6）：首页、店铺页显示 */
export interface RentStatus {
  /** 买下店铺了，不再交租 */
  owned: boolean;
  /** 欠租中（交租日打烊时钱不够）：柜台关门、不能进下一天 */
  arrears: { amount: number; week: number } | null;
  /** 下一次交租：第几个营业日打烊时、这一轮第几周、多少钱；店主是 null */
  next: { day: number; week: number; amount: number } | null;
  shopPrice: number;
}
export interface PawnView {
  id: number;
  card: CardView;
  /** 抵押时拿到的钱、赎回要付的钱、最后能赎回的营业日 */
  loan: number;
  redeem: number;
  dueDay: number;
}
/** GET /api/rent：房租、抵押中的卡、能抵押的卡（珍藏柜不能抵押） */
export interface RentResponse {
  ok: true;
  credits: number;
  day: number;
  rent: RentStatus;
  pawns: PawnView[];
  pawnable: Array<{ card: CardView; loan: number; redeem: number }>;
}
export interface RentActionResponse {
  ok: true;
  credits: number;
  rent: RentStatus;
  /** 这次抵押 / 赎回的卡 */
  cards?: CardView[];
  /** 交租或破产后进入的新营业日 */
  day?: number;
  /** 一键抵押：全部抵押完还不够 */
  notEnough?: boolean;
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
  /** 房租（FR-RENT-6） */
  rent: RentStatus;
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

/** 任务栏里的一条任务（FR-UI-4） */
export interface QuestView {
  id: string;
  title: string;
  hint: string;
  /** 点任务跳到哪一页 */
  tab: string;
  progress: number;
  target: number;
  reward: number;
  done: boolean;
  claimed: boolean;
}

/** GET /api/quests：全部任务（按顺序），前端只显示前几条没领奖的 */
export interface QuestsResponse {
  ok: true;
  quests: QuestView[];
  /** 任务栏里追踪的科技树节点（没追踪 / 已点过就是 null） */
  tracked: TechNodeView | null;
}

/** 科技树（docs/TECH-TREE.md）：一个节点在这个玩家眼里的样子 */
export interface TechNodeView {
  id: string;
  branch: string;
  branchName: string;
  tier: number;
  name: string;
  price: number;
  effect: string;
  flavor: string;
  requires: Array<{ id: string; name: string; owned: boolean }>;
  /** 这几个里点过任意一个就行 */
  anyOf: Array<{ id: string; name: string; owned: boolean }>;
  /** 二选一的另一个节点 */
  exclusive: { id: string; name: string; owned: boolean } | null;
  conditions: Array<{ text: string; current: number; target: number; met: boolean }>;
  /** 还没开放的节点：第几阶段开放、之后的解锁条件说明 */
  soon: number | null;
  conditionText: string | null;
  owned: boolean;
  /** 前置和条件都满足了（钱够不够另看） */
  unlockable: boolean;
  tracked: boolean;
}
export interface TechResponse {
  ok: true;
  credits: number;
  blueprints: number;
  branches: Array<{ id: string; name: string; contact: string; nodes: TechNodeView[] }>;
}
export interface TechBuyResponse {
  ok: true;
  credits: number;
  blueprints: number;
  /** 这次从信用点换了多少蓝图 */
  converted: number;
  node: TechNodeView;
}

/** POST /api/quests/:id/claim */
export interface QuestClaimResponse {
  ok: true;
  credits: number;
  reward: number;
  quests: QuestView[];
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

/** 金币兑换单（FR-EXCH）：pending = 正在到账（旺财那边还没给结论，会自动重试），done = 到账了，failed = 旺财拒绝、信用点已退回 */
export interface ExchangeView {
  id: number;
  credits: number;
  coins: number;
  status: 'pending' | 'done' | 'failed';
  error: string | null;
  createdAt: number;
}
/** GET /api/exchange：兑换页（FR-EXCH-1） */
export interface ExchangeResponse {
  ok: true;
  /** 多少信用点换 1 金币、每周上限、本周已兑、本周还能兑、下次重置（悉尼周一 00:00 的日期） */
  rate: number;
  weeklyCap: number;
  weekUsed: number;
  weekLeft: number;
  resetDay: string;
  credits: number;
  /** 要留着交下次摊位费的信用点（租金保证金，FR-EXCH-3）；欠租时不能兑 */
  reserve: number;
  arrears: boolean;
  /** 这次最多能兑多少金币（本周额度和可用信用点里取小的） */
  maxCoins: number;
  wallet: WalletView;
  orders: ExchangeView[];
}
/** POST /api/exchange { coins }：兑换（幂等） */
export interface ExchangeOrderResponse {
  ok: true;
  credits: number;
  order: ExchangeView;
}

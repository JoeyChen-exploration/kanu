// 全部游戏数值的唯一来源（CLAUDE.md 第 3 条）。以 docs/DESIGN.md 为准（版本 2026-11-17），改了要跑 npm run sim。
// 概率一律写成"百万分之几"（ppm）的整数，抽签时用整数随机数，不受浮点误差影响；每张概率表的合计由测试检查等于 1,000,000。

// ---------- 稀有度（DESIGN 3.2、4） ----------
export const RARITIES = ['N', 'R', 'SR', 'SSR', 'UR', 'LR', 'MR'] as const;
export type Rarity = (typeof RARITIES)[number];

export const RARITY: Record<Rarity, { name: string; basePrice: number }> = {
  N: { name: '普通', basePrice: 25 },
  R: { name: '稀有', basePrice: 100 },
  // 2026-11-17 模拟调参：SR 400 → 600、SSR 1,500 → 2,200，抬高中位玩家的周收入（目标中位约 1,000 金币）
  SR: { name: '超稀有', basePrice: 600 },
  SSR: { name: '特级稀有', basePrice: 2200 },
  UR: { name: '极稀有', basePrice: 6000 },
  LR: { name: '传说', basePrice: 20000 },
  MR: { name: '神话', basePrice: 60000 },
};

/** a 是否不低于 b（如 atLeast('UR', 'SSR') === true） */
export const atLeast = (a: Rarity, b: Rarity) => RARITIES.indexOf(a) >= RARITIES.indexOf(b);

// ---------- 卡包（DESIGN 3.2、4） ----------
// 2026-11-17 改：卡牌按卡包分。每种卡包就是一个系列（content/series/*.json 里的 kind 决定它是主题包还是典藏包）。
// 现阶段 4 种主题包 + 1 种典藏包，每种 20 张。
export type PackType = 'themed' | 'premium' | 'black';

export const PACKS: Record<PackType, {
  name: string;
  /** 电脑订货（按包买）的价格 */
  price: number;
  cards: number;
  /** 单张稀有度概率，ppm */
  odds: Record<Rarity, number>;
  /** 这类卡包每种（每个系列）里各稀有度有几张卡；内容校验用 */
  composition: Record<Rarity, number>;
  /** 每张卡独立判定是假卡的概率（ppm）；假卡里低仿和高仿各占一半 */
  fakePpm: number;
  /** 每张卡独立判定是赃物的概率（ppm） */
  stolenPpm: number;
  /** 计不计保底 */
  pity: boolean;
}> = {
  themed: {
    name: '主题包',
    price: 300,
    cards: 5,
    // 原正规包的爆率，主题包没有 MR，MR 的 0.05% 并进 LR
    odds: { N: 640_000, R: 240_000, SR: 80_000, SSR: 32_000, UR: 6_000, LR: 2_000, MR: 0 },
    composition: { N: 7, R: 5, SR: 4, SSR: 2, UR: 1, LR: 1, MR: 0 },
    fakePpm: 0,
    stolenPpm: 0,
    pity: true,
  },
  premium: {
    name: '典藏包',
    // 初值，待模拟脚本按新卡包重跑后再定
    price: 800,
    cards: 5,
    odds: { N: 520_000, R: 270_000, SR: 120_000, SSR: 60_000, UR: 20_000, LR: 8_000, MR: 2_000 },
    composition: { N: 4, R: 4, SR: 5, SSR: 3, UR: 2, LR: 1, MR: 1 },
    fakePpm: 0,
    stolenPpm: 0,
    pity: true,
  },
  black: {
    name: '黑市卡包',
    price: 200,
    cards: 5,
    odds: { N: 520_000, R: 270_000, SR: 120_000, SSR: 60_000, UR: 20_000, LR: 8_000, MR: 2_000 },
    // 黑市包（2026-11-26 上线）开的是所有系列里的卡：先按 odds 抽稀有度，再从所有系列这个稀有度的卡里随机抽一张
    composition: { N: 0, R: 0, SR: 0, SSR: 0, UR: 0, LR: 0, MR: 0 },
    fakePpm: 250_000,
    stolenPpm: 200_000,
    pity: false,
  },
};

/**
 * 黑市（DESIGN 4，2026-11-26 上线）：黑市卡包 PACKS.black（200 / 包、约 25% 假卡、20% 赃物、不计保底），每个营业日最多 perDay 包（和电脑订货分开算）。
 * 解锁：设计里是黑市派系关系到"熟脸"；派系还没做，先用"和黑市中间人成交 unlockMiddlemanSales 次"代替。
 * 黑市包拆出来的卡带公开的"黑"字（acquired = black），来路不明，图鉴要送评封壳后才点亮。
 */
export const BLACK_MARKET = { seriesId: 'BLK', perDay: 3, unlockMiddlemanSales: 6 };

/** 电脑订货（店里终端，DESIGN 4）：按包买、正常价、唯一保证正品；每个营业日限购（各种卡包合计） */
export const STORE = { packsPerDay: 5 };

/** 保底：计保底的卡包连续 packs 包没出 rarity 及以上，第 packs 包必出一张 rarity（不出编号限定） */
export const PITY = { packs: 10, rarity: 'SSR' as Rarity };

// ---------- 外层风格（DESIGN 3.4） ----------
export const STYLES = ['standard', 'holo', 'ice', 'gold', 'dark', 'serial'] as const;
export type Style = (typeof STYLES)[number];

export const STYLE: Record<Style, { name: string; ppm: number; mult: number; minRarity: Rarity | null }> = {
  standard: { name: '标准框', ppm: 800_000, mult: 1, minRarity: null },
  holo: { name: '闪卡', ppm: 120_000, mult: 1.5, minRarity: null },
  ice: { name: '镭射碎冰', ppm: 50_000, mult: 2, minRarity: null },
  gold: { name: '金框', ppm: 25_000, mult: 3, minRarity: null },
  dark: { name: '暗物质', ppm: 4_500, mult: 6, minRarity: 'SR' },
  serial: { name: '编号限定', ppm: 500, mult: 10, minRarity: 'SSR' },
};
/** 这个稀有度可能出哪些外层风格（暗物质要 SR 以上、编号限定要 SSR 以上）；大师图鉴只算这些 */
export const stylesFor = (r: Rarity): Style[] => STYLES.filter((s) => STYLE[s].minRarity === null || atLeast(r, STYLE[s].minRarity!));

/** 编号限定：每个卡牌模板全服最多几张 */
export const SERIAL_LIMIT = 50;

// ---------- 品相与评级（DESIGN 5.2、9.2） ----------
/** 真实品相：1–10，另有黑标（四个分项全 10）。开包时确定，隐藏 */
export const GRADES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 'BL'] as const;
export type Grade = (typeof GRADES)[number];

export const GRADE: Record<string, { ppm: number; mult: number }> = {
  1: { ppm: 50_000, mult: 0.2 },
  2: { ppm: 70_000, mult: 0.3 },
  3: { ppm: 80_000, mult: 0.4 },
  4: { ppm: 120_000, mult: 0.5 },
  5: { ppm: 140_000, mult: 0.6 },
  6: { ppm: 140_000, mult: 0.7 },
  7: { ppm: 160_000, mult: 0.9 },
  8: { ppm: 140_000, mult: 1.2 },
  9: { ppm: 70_000, mult: 2.0 },
  10: { ppm: 27_000, mult: 5.0 },
  BL: { ppm: 3_000, mult: 15 },
};
/** 没封壳的卡一律按这个系数定价，不读真实品相（FR-APPR-5） */
export const UNGRADED_MULT = 0.85;

// ---------- 鉴定费用和准确率（DESIGN 5.1、5.2） ----------
/**
 * 鉴定（2026-11-17 用户重定）：
 * - 放大镜是柜台上的道具，拖到卡上查验（学深空当铺），免费，每张卡只能查一次：看真伪、估品相（相邻两档）、找错版。
 * - 没有鉴定机构了。送评（星港评级社）在电话里，电话要花信用点买（PHONE）。
 */
export const APPRAISAL = {
  /** 送评：max(min, 基准价 × 风格系数 × pct)；送去后过 days 个营业日（打烊时）出结果 */
  grading: { min: 20, pct: 0.15, days: 1 },
  /** 放大镜识破假卡的概率（ppm），漏看时说"看起来是真的" */
  loupeDetect: { low_fake: 950_000, high_fake: 600_000 },
  /** 放大镜认出错版的概率（ppm） */
  errataDetect: 800_000,
  /** 假卡送评被拒扣的信誉 */
  gradeRejectRepLoss: 5,
  /** 评级社查不查失窃登记表（DESIGN 5.2 待定项，先做成开关） */
  gradingChecksStolen: false,
};

/**
 * 电话批发（DESIGN 4）：打电话给批发商整盒订。2026-11-18 用户定：隔日送达（deliveryDays 天后）——送货员（courier）
 * 作为那天的第一位顾客来柜台，占一个顾客名额，在柜台货到付款（收货 / 拒收）；那天名额已满就再往后一天。
 * 一盒 boxPacks 包、每包按电脑订货价 × discount；批发商不保证正品：每张卡 fakePpm 的概率是假卡（低仿高仿各半）。
 * 每个营业日只能订 perDay 次、一次一盒，上一盒没送到不能再订。批发来的卡带公开的"批发"标记；图鉴要送评封壳后才点亮。保底照常算。
 */
export const WHOLESALE = { boxPacks: 10, discount: 0.8, fakePpm: 50_000, perDay: 1, deliveryDays: 1 };

/** 错版卡（2026-11-17 用户定）：开包时每张卡有 ppm 的概率是错版（印错字、印错色，隐藏属性）。
 *  放大镜能认出来；送评封壳后标签写"错版"，公开价再 × mult。没封壳的照旧按普通卡定价，不泄露 */
export const ERRATA = { ppm: 5_000, mult: 3 };

/** 电话（2026-11-17 用户定）：花信用点买，买了才能打给星港评级社送评、打给批发商整盒订货（WHOLESALE） */
export const PHONE = {
  price: 2000,
  /** 一次电话最多寄几张卡去送评（2026-11-18 用户要求能一次放很多张；只是防误操作的上限） */
  gradingBatch: 20,
};

// ---------- 柜台顾客（DESIGN 6，SRS 8.5） ----------
export const CUSTOMER_TYPES = ['resident', 'student', 'tourist', 'collector', 'nostalgic', 'rich', 'speculator', 'streamer', 'middleman', 'grand', 'courier', 'dealer', 'undercover'] as const;
export type CustomerType = (typeof CUSTOMER_TYPES)[number];

/**
 * 顾客想要什么：
 *   card：要卡。rarities 是收哪些稀有度；tagChance 是需求里带一个标签的概率（ppm）；
 *         template 为 true 时点名要某一张卡（怀旧老顾客）。styleBonus：特殊风格（非标准框）的卡心理价位再乘这个数
 *   pack：要没拆的卡包（开箱主播），按卡包的电脑订货价算
 */
export type CustomerWants =
  | { kind: 'card'; rarities: Rarity[]; tagChance: number; template?: boolean; styleBonus?: number }
  | { kind: 'pack' };

const ALL: Rarity[] = ['N', 'R', 'SR', 'SSR', 'UR', 'LR', 'MR'];
const SR_UP: Rarity[] = ['SR', 'SSR', 'UR', 'LR', 'MR'];

export const CUSTOMER: Record<CustomerType, {
  name: string;
  ppm: number;
  /** MVP 里有没有这类顾客（DESIGN 12：MVP 不含卡贩和便衣） */
  mvp: boolean;
  wants: CustomerWants;
  /**
   * 愿意比市场价多出多少（2026-11-18 用户定：开价不超过市场价，客人就不会不满意）：
   * 心理价位 = 市场价 × 风格加成 × (1 + 这个范围里随机的一个数)，所以最低就是市场价。快速出售按下限算，必定成交。
   * 黑市中间人例外：不看市场价，只按基准价的 MIDDLEMAN.basePct 收。
   */
  premium: [number, number];
  patience: number;
  /** 成交后识破假卡的概率（ppm） */
  detect: { low_fake: number; high_fake: number };
}> = {
  resident: { name: '下层区居民', ppm: 190_000, mvp: true, wants: { kind: 'card', rarities: ['N', 'R'], tagChance: 500_000 }, premium: [0, 0.1], patience: 4, detect: { low_fake: 300_000, high_fake: 100_000 } },
  // 2026-11-17 加：学生钱少（几乎只肯出市场价）、耐心好，看到闪卡这类特殊风格愿意多给
  student: { name: '学生', ppm: 100_000, mvp: true, wants: { kind: 'card', rarities: ['N', 'R'], tagChance: 300_000, styleBonus: 1.6 }, premium: [0, 0.05], patience: 5, detect: { low_fake: 100_000, high_fake: 0 } },
  // 2026-11-17 加：上层区来的观光客，不太懂行，给钱爽快
  tourist: { name: '观光客', ppm: 100_000, mvp: true, wants: { kind: 'card', rarities: ['N', 'R', 'SR'], tagChance: 400_000 }, premium: [0.05, 0.3], patience: 3, detect: { low_fake: 100_000, high_fake: 20_000 } },
  // 收藏家收 SR 以上的卡，封壳的不限稀有度但要评分够高（见 COLLECTOR）
  collector: { name: '收藏家', ppm: 120_000, mvp: true, wants: { kind: 'card', rarities: SR_UP, tagChance: 500_000 }, premium: [0.1, 0.35], patience: 2, detect: { low_fake: 800_000, high_fake: 500_000 } },
  // 2026-11-17 加：点名要某一张卡，找到了出价很高
  nostalgic: { name: '怀旧老顾客', ppm: 80_000, mvp: true, wants: { kind: 'card', rarities: ALL, tagChance: 0, template: true }, premium: [0.3, 0.7], patience: 3, detect: { low_fake: 500_000, high_fake: 200_000 } },
  rich: { name: '上层区富人', ppm: 100_000, mvp: true, wants: { kind: 'card', rarities: SR_UP, tagChance: 500_000 }, premium: [0.2, 0.5], patience: 3, detect: { low_fake: 100_000, high_fake: 50_000 } },
  // 2026-11-17 加：炒卡客只收 SR 以上、几乎不肯多给，没耐心
  speculator: { name: '炒卡客', ppm: 80_000, mvp: true, wants: { kind: 'card', rarities: SR_UP, tagChance: 300_000 }, premium: [0, 0.08], patience: 2, detect: { low_fake: 600_000, high_fake: 300_000 } },
  // 2026-11-17 加：开箱主播买没拆的卡包回去直播开箱，按卡包价加价收
  streamer: { name: '开箱主播', ppm: 80_000, mvp: true, wants: { kind: 'pack' }, premium: [0.1, 0.3], patience: 3, detect: { low_fake: 0, high_fake: 0 } },
  middleman: { name: '黑市中间人', ppm: 100_000, mvp: true, wants: { kind: 'card', rarities: ALL, tagChance: 0 }, premium: [0, 0], patience: 3, detect: { low_fake: 0, high_fake: 0 } },
  // 2026-11-17 加：大藏家，高级顾客。不按出现率抽（ppm 0），只在珍藏柜展示分够高时按 GRAND_COLLECTOR 的几率来（见下）。
  // 只要 UR 以上，出价是市场价的 1.9–2.6 倍，耐心少、识假很强
  grand: { name: '大藏家', ppm: 0, mvp: false, wants: { kind: 'card', rarities: ['UR', 'LR', 'MR'], tagChance: 0 }, premium: [0.9, 1.6], patience: 2, detect: { low_fake: 950_000, high_fake: 700_000 } },
  // 2026-11-18 用户定：电话批发的货由送货员送到柜台，占当天一个顾客名额，在柜台货到付款（收货 / 拒收）。
  // 不按出现率抽，只在有待送的订单时来；不买东西，wants 只是占位
  courier: { name: '货郎七号（送货）', ppm: 0, mvp: false, wants: { kind: 'pack' }, premium: [0, 0], patience: 3, detect: { low_fake: 0, high_fake: 0 } },
  // 卡贩不按这里的 ppm 抽（mvp: false 不进抽签）：点了科技树 G2 才来，出现率是 TECH_NODES 里 G2 的 dealerPpm。ppm 留着让这张表合计 100%，wants 只是占位
  dealer: { name: '卡贩', ppm: 30_000, mvp: false, wants: { kind: 'card', rarities: ALL, tagChance: 0 }, premium: [0, 0.1], patience: 3, detect: { low_fake: 0, high_fake: 0 } },
  undercover: { name: '便衣治安员', ppm: 20_000, mvp: false, wants: { kind: 'card', rarities: ALL, tagChance: 0 }, premium: [0, 0.1], patience: 3, detect: { low_fake: 0, high_fake: 0 } },
};

export const COUNTER = {
  /**
   * 每个营业日几位顾客。2026-11-17 改：学深空当铺，营业日由玩家自己推进——开门时这几位一次到店，
   * 接待完（或请走）就能打烊，马上进入下一天。不再按悉尼时间分早中晚。
   */
  customersPerDay: 10,
  /**
   * 每个营业日实际来几位：按这张表随机（ppm），平均正好 customersPerDay。
   * 2026-11-17 用户要求每天客人不固定、中位 10 位；顾客一位一位进门，处理完下一位才来。科技树客流节点、特殊事件在这个基础上加人。
   */
  customersPerDayDist: { 8: 100_000, 9: 200_000, 10: 400_000, 11: 200_000, 12: 100_000 } as Record<number, number>,
  /** 开价 ≤ 心理价位 × 这个数算"高出不多"，扣 1 点耐心；再高扣 2 点 */
  counterThreshold: 1.15,
  /** 需求从玩家库存里出的概率（ppm），其余从全卡池出 */
  demandHitPpm: 600_000,
  /** 卖假卡被识破扣的信誉 */
  fakeCaughtRepLoss: 5,
  /** 柜台台面最多摆几样（只影响界面，不进经济模拟；2026-11-17 用户要求台面能摆很多张） */
  tableSlots: 8,
};

/**
 * 收藏家收什么（2026-11-17 模拟调参：原来只收封壳卡，保守玩家碰不到两成多的顾客，周收入中位太低）：
 * 没封壳的卡要 rawMinRarity 及以上；封壳卡不限稀有度，但评分要 ≥ gradedMinGrade。
 */
/** 黑市中间人：什么卡都收，不看市场价，只按稀有度基准价的 basePct 收（不问来路） */
export const MIDDLEMAN = { basePct: 0.4 };

export const COLLECTOR = { rawMinRarity: 'SR' as Rarity, gradedMinGrade: 9 };

/**
 * 大藏家（2026-11-17 用户定）：珍藏柜展示分 ≥ minScore 时，每位进门的顾客有 min(maxPpm, 展示分 × ppmPerPoint) 的几率换成大藏家。
 * 没解锁珍藏柜（展示分 0）就碰不到。
 */
// 2026-11-17 模拟调参：初值 300 / 60,000 时每天 5 包的玩家每季来 15 次、周净赚翻倍，降到 100 / 15,000
export const GRAND_COLLECTOR = { minScore: 20, ppmPerPoint: 100, maxPpm: 15_000 };

export const REPUTATION = { start: 50, min: 0, max: 100 };

// ---------- 房租、店铺、破产、抵押（DESIGN 7） ----------
export const RENT = {
  /** 第 n 周摊位费 = base × growth^(n−1)，四舍五入到整数 */
  // 2026-11-17 模拟调参：1,000 → 2,500，把保守玩家的破产率拉到约 15%。
  // 同日再调（新手任务上线，用户选"接受新手保护"）：第一周的任务奖励让破产几乎消失（11.6% → 0.9%），
  // 把压力挪到第 2–4 周：2,500 → 3,800，涨幅 1.25 → 1.22
  base: 3800,
  growth: 1.22,
  /** 每几个营业日扣一次（营业日由玩家打烊推进，2026-11-17 改） */
  everyDays: 7,
  /** 涨到第几周封顶（软赛季下周数不清零，2026-11-17 定） */
  capWeek: 8,
  /** 每周日悉尼时间几点扣 */
  dueWeekday: 0,
  dueHour: 20,
  graceHours: 24,
};
/** 2026-11-17 模拟调参：15,000 → 40,000，买店率约 70%；同日房租调高后 40,000 → 31,000，买店率回到约 70% */
export const SHOP_PRICE = 31_000;
export const PAWN = { loanPct: 0.5, redeemPct: 0.6, days: 7 };

export const PLAYER = {
  /** 开局信用点（DESIGN 9.1） */
  startCredits: 1500,
  /** 破产重开信用点（DESIGN 7） */
  restartCredits: 1200,
  /** 开局信誉（DESIGN 6） */
  startReputation: REPUTATION.start,
};

export const SEASON = { weeks: 8 };

/**
 * 珍藏柜（DESIGN 8.1、FR-INV-6、FR-INV-11，2026-11-17 用户定）：开局没有，要花信用点解锁、升级；科技树 S1 再 +2 格。
 * 珍藏柜是店的门面：其他玩家和 AI 顾客都看得到。按柜里的卡算"展示分"（只看公开的稀有度和风格），
 * 展示分越高，顾客的预算和心理价位越高，到一定分数耐心 +1。
 */
export const SHOWCASE = {
  /** levels[n] = 第 n 级：升到这一级的价格、格数。第 0 级 = 没解锁 */
  levels: [
    { price: 0, slots: 0 },
    // 2026-11-17 模拟调参：2,000 / 8,000 / 25,000 → 1,000 / 4,000 / 12,000（原价每天 2 包的玩家买店率从 72% 掉到 33%）
    { price: 1000, slots: 3 },
    { price: 4000, slots: 5 },
    { price: 12000, slots: 8 },
  ],
  /** 每张卡的展示分 = rarityScore × 风格倍数（STYLE[style].mult），四舍五入 */
  rarityScore: { N: 0, R: 1, SR: 3, SSR: 8, UR: 20, LR: 50, MR: 120 } as Record<Rarity, number>,
  /** 每多少展示分，顾客预算和心理价位 +1%（2026-11-17 模拟调参：10 → 5） */
  pointsPerPct: 5,
  /** 预算和心理价位最多加多少（2026-11-17 模拟调参：15% → 20%） */
  maxPriceBonus: 0.2,
  /** 展示分到这个数，每位顾客耐心 +patienceBonus */
  patienceAt: 40,
  patienceBonus: 1,
};

// ---------- 卡册（DESIGN 4.5，2026-11-17 用户定） ----------
// 卡要放进卡册才算收好；所有卡册的格数加起来就是库存上限。卡册满了，新开的卡只能散放在桌面上（最多 LOOSE.slots 张），
// 再满就不能拆新包。散放的卡每过一个营业日有 LOOSE.wearPpm 的概率品相掉 1 分（隐藏属性，送评才知道）。
// 没拆的卡包和珍藏柜不占卡册格子。
export const BINDER_KINDS = ['basic', 'grid', 'humidor', 'leather'] as const;
export type BinderKind = (typeof BINDER_KINDS)[number];

export const BINDERS: Record<BinderKind, {
  name: string;
  price: number;
  slots: number;
  /** 放在里面的卡卖给收藏家时，心理价位乘 (1 + collectorBonus) */
  collectorBonus: number;
  /** 放在里面的卡卖给任何顾客时，心理价位乘 (1 + allBonus) */
  allBonus: number;
  /** 拥有这种卡册时，每个营业日多来几位收藏家（不叠加：有一本就算） */
  extraCollectors: number;
  /** 给玩家看的效果说明 */
  effect: string;
}> = {
  basic: { name: '简易卡册', price: 200, slots: 27, collectorBonus: 0, allBonus: 0, extraCollectors: 0, effect: '防磨损' },
  grid: { name: '九宫格活页册', price: 1000, slots: 90, collectorBonus: 0, allBonus: 0, extraCollectors: 0, effect: '防磨损' },
  humidor: { name: '防潮收藏册', price: 4000, slots: 180, collectorBonus: 0.05, allBonus: 0, extraCollectors: 0, effect: '防磨损；里面的卡卖给收藏家，心理价位 +5%' },
  leather: { name: '典藏皮面册', price: 15000, slots: 360, collectorBonus: 0, allBonus: 0.05, extraCollectors: 1, effect: '防磨损；里面的卡卖给任何顾客，心理价位 +5%；每个营业日多来 1 位收藏家' },
};

/** 开局送的卡册 */
export const STARTER_BINDER: BinderKind = 'basic';

/** 卡册一页几格（3 × 3），只影响显示 */
export const BINDER_PAGE_SIZE = 9;

export const LOOSE = {
  /** 桌面最多散放几张 */
  slots: 20,
  /** 每过一个营业日，每张散放的卡品相掉 1 分的概率（ppm） */
  wearPpm: 100_000,
};

// ---------- 任务栏 / 新手指引（2026-11-17 用户定） ----------
// 右上角的任务栏：一条一条带新玩家上手，做完点"领取"拿信用点。进度从已有的流水和库存里数，不另记计数。
// 以后科技树上线，玩家可以在任务栏里追踪节点的解锁条件。
/** rentPaid 按时交租次数、middlemanSales 和中间人成交次数、inspections 放大镜查验次数（科技树里程碑，TECH-TREE 3.0） */
export type QuestMetric = 'packsBought' | 'packsOpened' | 'sales' | 'daysEnded' | 'collected' | 'showcaseLevel' | 'showcaseCards' | 'binders' | 'rentPaid' | 'middlemanSales' | 'inspections';
/** tab：点任务时跳到哪一页 */
export type QuestTab = 'shop' | 'packs' | 'counter' | 'inventory' | 'collection';

export const QUESTS: Array<{ id: string; title: string; hint: string; tab: QuestTab; metric: QuestMetric; target: number; reward: number }> = [
  { id: 'buy_pack', title: '进第一批货', hint: '到"进货"页，用电脑订一包卡', tab: 'packs', metric: 'packsBought', target: 1, reward: 100 },
  { id: 'open_pack', title: '拆开一包', hint: '在"进货"页的"我的卡包"里拆一包', tab: 'packs', metric: 'packsOpened', target: 1, reward: 100 },
  { id: 'first_sale', title: '第一笔生意', hint: '到"柜台"，把客人要的卡拖到台面上卖给他', tab: 'counter', metric: 'sales', target: 1, reward: 150 },
  { id: 'end_day', title: '打烊', hint: '客人都接待完，按"打烊"进入下一天', tab: 'counter', metric: 'daysEnded', target: 1, reward: 150 },
  { id: 'sales_5', title: '小有生意', hint: '在柜台一共成交 5 笔', tab: 'counter', metric: 'sales', target: 5, reward: 300 },
  { id: 'collect_10', title: '图鉴点亮 10 张', hint: '多开包，翻"图鉴"看看还差哪些', tab: 'collection', metric: 'collected', target: 10, reward: 300 },
  { id: 'unlock_showcase', title: '摆出门面', hint: '在"库存"页解锁珍藏柜', tab: 'inventory', metric: 'showcaseLevel', target: 1, reward: 300 },
  { id: 'showcase_card', title: '第一件展品', hint: '在"库存"页把一张好卡拖进珍藏柜', tab: 'inventory', metric: 'showcaseCards', target: 1, reward: 100 },
  { id: 'buy_binder', title: '添一本卡册', hint: '到"进货"页的"用品"买一本卡册', tab: 'packs', metric: 'binders', target: 2, reward: 200 },
  { id: 'week_one', title: '撑过第一周', hint: '营业满 7 天（打烊 7 次）', tab: 'counter', metric: 'daysEnded', target: 7, reward: 500 },
];
/** 任务栏里同时显示几条还没领奖的任务（能领奖的置顶且全部显示，不受这个数限制） */
export const QUEST_BAR = { visible: 3 };

/**
 * 科技树（docs/TECH-TREE.md，MVP 第一阶段 6 个节点，2026-11-18 上线）。
 * 节点用"蓝图"买：信用点按 BLUEPRINT.perCredit 单向换成蓝图，不能换回、不能兑金币。MVP 买节点时蓝图不够的部分自动用信用点换。
 * 永久保留：赛季末、破产都不清空。条件：前置节点全部点过 + 额外条件（里程碑 / 信誉，只在购买那一刻检查）。
 * 效果由 server/game/tech.ts 读这张表计算，路由里不写 if。
 */
export const BLUEPRINT = { perCredit: 1 };
export type TechBranch = 'counter' | 'appraisal' | 'goods' | 'phone' | 'store';
export const TECH_BRANCHES: Record<TechBranch, { name: string; contact: string }> = {
  counter: { name: '柜台', contact: '招牌匠阿灯' },
  appraisal: { name: '鉴定', contact: '退休鉴定师眼镜婆' },
  goods: { name: '进货', contact: '货郎七号' },
  phone: { name: '电话', contact: '接线员零号台' },
  store: { name: '店面', contact: '房东塔姆先生' },
};
export type TechEffect =
  | { kind: 'patience'; delta: number }
  | { kind: 'customersPerDay'; delta: number }
  | { kind: 'errataDetectPpm'; value: number }
  | { kind: 'storePacksPerDay'; delta: number }
  | { kind: 'showcaseSlots'; delta: number }
  | { kind: 'wholesaleDiscount'; value: number }
  | { kind: 'dealerPpm'; value: number }
  /** S2：每 7 个营业日信誉 +delta，涨到 cap 为止 */
  | { kind: 'weeklyRep'; delta: number; cap: number }
  /** S3a：巡查来的概率 × value */
  | { kind: 'patrolMult'; value: number }
  /** S3a：卖真卡给客人信誉 +delta，每个营业日最多 perDay 次 */
  | { kind: 'honestRep'; delta: number; perDay: number }
  /** S3b / S4b：藏匿室格数、放在里面的赃卡被查出的概率（取最好的） */
  | { kind: 'hideout'; slots: number; detectPpm: number }
  /** S3b：中间人按基准价的 value 收 */
  | { kind: 'middlemanPct'; value: number }
  /** S4a：每周（这一轮第 1–7、8–14……天）第一次被巡查查出赃卡，交出不扣信誉 */
  | { kind: 'patrolWaiver' };
export type TechCondition = { kind: 'metric'; metric: QuestMetric; target: number } | { kind: 'reputation'; min: number };
export interface TechNode {
  id: string; branch: TechBranch; tier: number; name: string;
  /** 前置：全部要点过 */
  requires: string[];
  /** 前置：这几个里点过任意一个就行（"C4 任一"） */
  anyOf?: string[];
  /** 二选一：和这个节点互斥，同一个玩家只能点一个 */
  exclusive?: string;
  price: number;
  conditions: TechCondition[]; effects: TechEffect[];
  /** 效果说明（"当前 → 点了之后"） */
  effect: string;
  /** 联系人的一句话 */
  flavor: string;
  /** 还没开放（第二、三阶段）：树上显示，不能点；conditionText 是之后的解锁条件说明 */
  soon?: 2 | 3;
  conditionText?: string;
}
/** 整棵树（docs/TECH-TREE.md 第 3 节）。MVP 只开放第一阶段 6 个，其他节点在树上显示"第 N 阶段开放" */
export const TECH_NODES: TechNode[] = [
  // ---- 柜台（招牌匠阿灯） ----
  { id: 'C1', branch: 'counter', tier: 1, name: '霓虹招牌', requires: [], price: 1500, conditions: [], effects: [{ kind: 'patience', delta: 1 }],
    effect: '所有顾客耐心 +1', flavor: '灯一亮，人就不急着走。' },
  { id: 'C2', branch: 'counter', tier: 2, name: '二号柜台', requires: ['C1'], price: 6000, conditions: [{ kind: 'metric', metric: 'sales', target: 10 }], effects: [{ kind: 'customersPerDay', delta: 1 }],
    effect: '每天多来 1 位顾客（货够卖才划算）', flavor: '多一张台面，多一个冤大头。' },
  { id: 'C3', branch: 'counter', tier: 3, name: '橱窗', requires: ['C2'], price: 8000, conditions: [], effects: [], soon: 2, conditionText: '成交 30 笔',
    effect: '2 个橱窗格：放进去的卡每天有 30% 概率按公开价 70% 自动卖出', flavor: '玻璃后面的卡，看着就比手里的值钱。' },
  { id: 'C4a', branch: 'counter', tier: 4, name: '流水摊', requires: ['C3'], exclusive: 'C4b', price: 12000, conditions: [], effects: [], soon: 2, conditionText: '成交 80 笔',
    effect: '每天顾客 +2，居民多来', flavor: '薄利多销，下层区讲的是量。' },
  { id: 'C4b', branch: 'counter', tier: 4, name: '会员制', requires: ['C3'], exclusive: 'C4a', price: 12000, conditions: [], effects: [], soon: 2, conditionText: '信誉 ≥ 60，卖出封壳卡 3 张',
    effect: '收藏家、富人多来，居民少来；顾客数不变', flavor: '没卡的别进来。' },
  { id: 'C5', branch: 'counter', tier: 5, name: '回头客', requires: ['P1'], anyOf: ['C4a', 'C4b'], price: 18000, conditions: [], effects: [], soon: 2, conditionText: '接待顾客 150 位',
    effect: '谈崩走掉的顾客 30% 第二天再来，耐心回满', flavor: '他还是想要那张卡。' },
  { id: 'C6', branch: 'counter', tier: 6, name: '下层区地标', requires: ['C5', 'S5'], price: 45000, conditions: [], effects: [], soon: 3, conditionText: '已买下店铺，信誉 ≥ 70，高分封壳 3 张',
    effect: '大藏家上门几率翻倍，成交开播报', flavor: '整条街都知道，好卡要往你这儿送。' },
  // ---- 鉴定（退休鉴定师眼镜婆） ----
  { id: 'A1', branch: 'appraisal', tier: 1, name: '好放大镜', requires: [], price: 1500, conditions: [], effects: [{ kind: 'errataDetectPpm', value: 900_000 }],
    effect: '放大镜认出错版 80% → 90%', flavor: '镜片是从报废的轨道望远镜上拆的。' },
  { id: 'A2', branch: 'appraisal', tier: 2, name: '冷光灯', requires: ['A1'], price: 4000, conditions: [], effects: [], soon: 2, conditionText: '放大镜 10 次',
    effect: '放大镜认出高仿 60% → 75%', flavor: '冷光下，高仿的油墨会发灰。' },
  { id: 'A3', branch: 'appraisal', tier: 3, name: '品相卡尺', requires: ['A2'], price: 7000, conditions: [], effects: [], soon: 2, conditionText: '放大镜 30 次，送评 3 张',
    effect: '放大镜看品相从两档变成一个估计分', flavor: '眼镜婆说：尺子不会骗人，但会看错。' },
  { id: 'A4a', branch: 'appraisal', tier: 4, name: '鉴定师执照', requires: ['A3', 'S3a'], exclusive: 'A4b', price: 12000, conditions: [], effects: [], soon: 3, conditionText: '信誉 ≥ 60，验真 10 张',
    effect: '可以给别的玩家代鉴定收费', flavor: '盖了评级社钢印的证，下层区没几张。' },
  { id: 'A4b', branch: 'appraisal', tier: 4, name: '黑眼', requires: ['A3', 'S3b'], exclusive: 'A4a', price: 12000, conditions: [], effects: [], soon: 2, conditionText: '中间人成交 10 次，放大镜 50 次',
    effect: '放大镜认出高仿 → 90%，还给一句来源提示', flavor: '她不看证书，只看手。' },
  { id: 'A5', branch: 'appraisal', tier: 5, name: '评级社关系', requires: [], anyOf: ['A4a', 'A4b'], price: 20000, conditions: [], effects: [], soon: 2, conditionText: '送评 15 张，高分封壳 1 张',
    effect: '送评费 −40%，可以加急', flavor: '排队？那是给别人准备的。' },
  // ---- 进货（货郎七号） ----
  { id: 'G1', branch: 'goods', tier: 1, name: '批发证', requires: [], price: 1500, conditions: [], effects: [{ kind: 'storePacksPerDay', delta: 1 }],
    effect: '电脑订货每天限购 5 → 6 包', flavor: '七号说：一张证，多一箱。' },
  { id: 'G2', branch: 'goods', tier: 2, name: '卡贩门路', requires: ['G1'], price: 4000, conditions: [{ kind: 'metric', metric: 'sales', target: 15 }], effects: [{ kind: 'dealerPpm', value: 180_000 }],
    effect: '解锁卡贩：有人来柜台卖卡给你（出现率 18%）', flavor: '有人急着出手，就有人收。' },
  { id: 'G3', branch: 'goods', tier: 3, name: '会员价', requires: ['G2'], price: 7000, conditions: [], effects: [], soon: 2, conditionText: '开包 40 包',
    effect: '正规卡包 9 折', flavor: '老客户，抹个零。' },
  { id: 'G4a', branch: 'goods', tier: 4, name: '厂商代理', requires: ['G3', 'S3a'], exclusive: 'G4b', price: 12000, conditions: [], effects: [], soon: 2, conditionText: '信誉 ≥ 60，开包 70 包，按时交租 3 次',
    effect: '每周一个预购箱（保证 SR 以上），新系列提前 1 天开卖', flavor: '出厂封条，一箱一码。' },
  { id: 'G4b', branch: 'goods', tier: 4, name: '夜班货车', requires: ['G3', 'S3b'], exclusive: 'G4a', price: 12000, conditions: [], effects: [], soon: 2, conditionText: '卡贩收卡 5 次，中间人成交 10 次',
    effect: '每周两次货车：便宜整箱买全未知的卡', flavor: '车牌是手写的。' },
  { id: 'G5', branch: 'goods', tier: 5, name: '直供', requires: [], anyOf: ['G4a', 'G4b'], price: 22000, conditions: [], effects: [], soon: 2, conditionText: '开包 120 包',
    effect: '限购再 +2，保底 10 包 → 8 包', flavor: '货从出厂直接到你柜台。' },
  // ---- 电话（接线员零号台） ----
  { id: 'P1', branch: 'phone', tier: 1, name: '零号台熟人', requires: [], price: 2000, conditions: [], effects: [{ kind: 'wholesaleDiscount', value: 0.75 }],
    effect: '电话批发每包 8 折 → 7.5 折', flavor: '零号台：老熟人了，给你转便宜的批发商。' },
  { id: 'P2', branch: 'phone', tier: 2, name: '熟客价', requires: ['P1'], price: 4000, conditions: [], effects: [], soon: 2, conditionText: '批发 5 盒',
    effect: '电话批发 7.5 折 → 7 折', flavor: '订得多了，零号台给你转的都是好说话的批发商。' },
  { id: 'P3a', branch: 'phone', tier: 3, name: '正规批发商', requires: ['P2', 'S3a'], exclusive: 'P3b', price: 8000, conditions: [], effects: [], soon: 2, conditionText: '信誉 ≥ 60，批发 15 盒',
    effect: '批发假卡率 5% → 1%，解锁治安局事件', flavor: '有执照的批发商，贵是贵点，货干净。' },
  { id: 'P3b', branch: 'phone', tier: 3, name: '黑市专线', requires: ['P2', 'S3b'], exclusive: 'P3a', price: 8000, conditions: [], effects: [], soon: 2, conditionText: '中间人成交 8 次，批发 15 盒',
    effect: '批发再便宜 1 折，但假卡更多，解锁黑市事件', flavor: '这个号码不在任何电话簿上。' },
  { id: 'P4', branch: 'phone', tier: 4, name: '线人', requires: [], anyOf: ['P3a', 'P3b'], price: 12000, conditions: [], effects: [], soon: 2, conditionText: '批发 30 盒',
    effect: '提前收到明天的空间站日报（20% 是假消息）', flavor: '消息比日报早半天，真不真自己判断。' },
  { id: 'P5', branch: 'phone', tier: 5, name: '大单热线', requires: ['P4', 'C3'], price: 20000, conditions: [], effects: [], soon: 3, conditionText: '批发 50 盒，完成委托 5 次',
    effect: '有人点名要货，开价不看市价', flavor: '有人点名要货，开价不看市价。' },
  // ---- 店面（房东塔姆先生） ----
  { id: 'S1', branch: 'store', tier: 1, name: '保险柜', requires: [], price: 1500, conditions: [], effects: [{ kind: 'showcaseSlots', delta: 2 }],
    effect: '珍藏柜额外 +2 格（要先解锁珍藏柜）', flavor: '塔姆先生对有保险柜的租客客气一点。' },
  { id: 'S2', branch: 'store', tier: 2, name: '装修', requires: ['S1'], price: 5000, conditions: [{ kind: 'metric', metric: 'rentPaid', target: 1 }], effects: [{ kind: 'weeklyRep', delta: 2, cap: 80 }],
    effect: '信誉每周自动 +2（最高 80）', flavor: '墙刷白了，客人也敢多待一会儿。' },
  { id: 'S3a', branch: 'store', tier: 3, name: '挂牌营业', requires: ['S2'], anyOf: ['C2', 'A2', 'G2', 'P2'], exclusive: 'S3b', price: 8000, conditions: [{ kind: 'reputation', min: 55 }, { kind: 'metric', metric: 'sales', target: 30 }], effects: [{ kind: 'patrolMult', value: 0.5 }, { kind: 'honestRep', delta: 1, perDay: 3 }],
    effect: '路线：正经店。巡查来的概率减半；卖真卡给客人信誉 +1（每天最多 +3）', flavor: '牌子挂出去，就得守规矩。' },
  { id: 'S3b', branch: 'store', tier: 3, name: '后门生意', requires: ['S2'], anyOf: ['C2', 'A2', 'G2', 'P2'], exclusive: 'S3a', price: 8000, conditions: [{ kind: 'metric', metric: 'middlemanSales', target: 5 }], effects: [{ kind: 'hideout', slots: 3, detectPpm: 200_000 }, { kind: 'middlemanPct', value: 0.5 }],
    effect: '路线：销赃窝点。藏匿室 3 格（里面的赃卡被巡查查出 70% → 20%）；中间人出价 40% → 50% 基准价', flavor: '后门不挂牌，熟人敲三下。' },
  { id: 'S4a', branch: 'store', tier: 4, name: '治安备案', requires: ['S3a'], price: 14000, conditions: [{ kind: 'reputation', min: 65 }, { kind: 'metric', metric: 'rentPaid', target: 3 }, { kind: 'metric', metric: 'inspections', target: 5 }], effects: [{ kind: 'patrolWaiver' }],
    effect: '每周第一次被巡查查出赃卡，交出不扣信誉', flavor: '备过案的店，治安局给一次面子。' },
  { id: 'S4b', branch: 'store', tier: 4, name: '地下仓', requires: ['S3b'], price: 14000, conditions: [{ kind: 'metric', metric: 'middlemanSales', target: 15 }], effects: [{ kind: 'hideout', slots: 6, detectPpm: 100_000 }],
    effect: '藏匿室 3 → 6 格，查出率 20% → 10%', flavor: '地板下面还有一层地板。' },
  { id: 'S5', branch: 'store', tier: 5, name: '隔壁铺面', requires: [], anyOf: ['S4a', 'S4b'], price: 24000, conditions: [], effects: [], soon: 3, conditionText: '已买下店铺',
    effect: '每天顾客 +3，橱窗格 +2', flavor: '塔姆先生把隔壁也租给你了。' },
];

/** 开包播报（FR-PACK-6）：开出这个稀有度及以上、或编号限定时全服播报 */
export const ANNOUNCE = { minRarity: 'UR' as Rarity };

/** 播报节流（FR-NOTIFY-3）：同一频道每分钟最多几条，多出来的合并成一条 */
export const NOTIFY = { perMinute: 5 };

/** 幂等记录保留多久（SRS 第 5 节 idempotency） */
export const IDEMPOTENCY = { ttlMs: 48 * 3600e3 };

/**
 * 卡贩（柜台收卡，DESIGN 4 / 6，2026-11-26 上线）：点了科技树 G2 卡贩门路才来，每位客人有 G2 的 dealerPpm 概率换成卡贩。
 * 每位带 cards 张（随机）摆上台面客人那一侧，卡按 packType 的稀有度概率随机抽（所有系列里抽）、风格和品相照开包；
 * 属性全未知：fakePpm 是假卡（低仿高仿各半）、stolenPpm 是赃物（赃物要等便衣和巡查才有后果）。
 * 卡贩心里的底价 = 市场价（未评级）× askPct 之间随机（急着脱手）；出价够底价就卖，不够就还价（底价 × counterUp 之间随机），
 * 耐心 patience 次用完就走。买来的卡带公开的"收"字（acquired = dealer），图鉴要送评封壳后才点亮。
 */
export const DEALER = { cards: [1, 3] as [number, number], packType: 'premium' as PackType, fakePpm: 250_000, stolenPpm: 400_000, askPct: [0.4, 0.8] as [number, number], counterUp: [1, 1.15] as [number, number], patience: 3 };

/**
 * 便衣和巡查（DESIGN 6、8.3，2026-11-26 上线）：让赃物有风险。
 * 便衣：每位普通客人有 undercoverPpm 概率是便衣，伪装成那一类客人（玩家看不出类型），开口有 tellPpm 概率露破绽。
 *   把赃卡卖给便衣：卡没收、不给钱，罚款 = max(fineMin, 市场价 × fineMult)（最多罚到 0），信誉 −bustRepLoss。卖别的卡给他照常成交。
 * 巡查：每次打烊后有 patrolPpm 概率来查店，库存和珍藏柜里每张赃卡有 detectPpm 概率被查出（抵押在房东那里、送评中的不查）。
 *   查出来二选一：交出（没收，信誉 −surrenderRepLoss）或打点（付这些卡市场价 × bribePct，卡留下）。处理完才能开门。
 * 举报卡贩：他的货里有赃物就对了，奖金 = 赃卡市场价合计 × reportBonusPct，信誉 +reportRepGain，赃卡没收；举报错了信誉 −falseReportRepLoss。
 * 藏匿室（科技树 S3b / S4b）以后接。
 */
export const POLICE = {
  undercoverPpm: 20_000, tellPpm: 500_000, fineMult: 1, fineMin: 100, bustRepLoss: 10,
  patrolPpm: 100_000, detectPpm: 700_000, surrenderRepLoss: 5, bribePct: 0.6,
  reportBonusPct: 0.3, reportRepGain: 3, falseReportRepLoss: 2,
};

/** 写接口限流（NFR-SEC-4）：每个玩家每秒最多几次写请求，超过回 429 */
export const RATE_LIMIT = { writesPerSecond: 5 };
/** 数据库备份（M7）：启动时备份一次，之后每几小时一次，备份目录里留最近几份 */
export const BACKUP = { everyHours: 24, keep: 14 };

// ---------- 金币兑换（DESIGN 11） ----------
export const EXCHANGE = {
  /** 多少信用点换 1 金币 */
  creditsPerCoin: 10,
  /** 每人每周最多兑多少金币（悉尼时间周一 00:00 重置） */
  weeklyCapCoins: 2000,
  /** pending 的兑换单每几分钟用同一个 key 重试一次；超过几小时还没结论就报警、停止自动重试（旺财只记得幂等 key 48 小时，SRS 6.3） */
  retryMinutes: 10,
  alertHours: 24,
};

// ---------- 科技树（TECH-TREE 7） ----------
export const TECH = {
  /** 1 信用点换多少蓝图 */
  blueprintsPerCredit: 1,
  /** 改换门庭（每赛季一次，蓝图全退）的价格，信用点 */
  respecPrice: 15_000,
};

// ---------- 会话（SRS FR-AUTH-3） ----------
export const SESSION = {
  /** 会话 token 有效期 */
  ttlMs: 24 * 3600e3,
};

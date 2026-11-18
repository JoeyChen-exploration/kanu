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
    // 黑市包（第二阶段）开的是已有卡包里的卡，具体从哪几种里抽到时再定
    composition: { N: 0, R: 0, SR: 0, SSR: 0, UR: 0, LR: 0, MR: 0 },
    fakePpm: 250_000,
    stolenPpm: 200_000,
    pity: false,
  },
};

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

/** 错版卡（2026-11-17 用户定）：开包时每张卡有 ppm 的概率是错版（印错字、印错色，隐藏属性）。
 *  放大镜能认出来；送评封壳后标签写"错版"，公开价再 × mult。没封壳的照旧按普通卡定价，不泄露 */
export const ERRATA = { ppm: 5_000, mult: 3 };

/** 电话（2026-11-17 用户定）：花信用点买，买了才能打给星港评级社送评；批发商的号码下一步开通 */
export const PHONE = {
  price: 2000,
  /** 一次电话最多寄几张卡去送评（2026-11-18 用户要求能一次放很多张；只是防误操作的上限） */
  gradingBatch: 20,
};

// ---------- 柜台顾客（DESIGN 6，SRS 8.5） ----------
export const CUSTOMER_TYPES = ['resident', 'student', 'tourist', 'collector', 'nostalgic', 'rich', 'speculator', 'streamer', 'middleman', 'grand', 'dealer', 'undercover'] as const;
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
export type QuestMetric = 'packsBought' | 'packsOpened' | 'sales' | 'daysEnded' | 'collected' | 'showcaseLevel' | 'showcaseCards' | 'binders';
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

/** 开包播报（FR-PACK-6）：开出这个稀有度及以上、或编号限定时全服播报 */
export const ANNOUNCE = { minRarity: 'UR' as Rarity };

/** 播报节流（FR-NOTIFY-3）：同一频道每分钟最多几条，多出来的合并成一条 */
export const NOTIFY = { perMinute: 5 };

/** 幂等记录保留多久（SRS 第 5 节 idempotency） */
export const IDEMPOTENCY = { ttlMs: 48 * 3600e3 };

// ---------- 金币兑换（DESIGN 11） ----------
export const EXCHANGE = {
  /** 多少信用点换 1 金币 */
  creditsPerCoin: 10,
  /** 每人每周最多兑多少金币（悉尼时间周一 00:00 重置） */
  weeklyCapCoins: 2000,
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

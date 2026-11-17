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
export const APPRAISAL = {
  /** 放大镜（看真伪或看品相各收一次）：fixed + 基准价 × pct */
  loupe: { fixed: 15, pct: 0.05 },
  /** 鉴定机构：max(min, 基准价 × 风格系数 × pct)，等 hours 小时 */
  lab: { min: 10, pct: 0.1, hours: 24 },
  /** 送评：max(min, 基准价 × 风格系数 × pct)，等 hours 小时 */
  grading: { min: 20, pct: 0.15, hours: 24 },
  /** 识破率（ppm）：肉眼看真伪 */
  eyeDetect: { low_fake: 500_000, high_fake: 0 },
  /** 识破率（ppm）：放大镜看真伪 */
  loupeDetect: { low_fake: 950_000, high_fake: 600_000 },
  /** 假卡送评被拒扣的信誉 */
  gradeRejectRepLoss: 5,
  /** 评级社查不查失窃登记表（DESIGN 5.2 待定项，先做成开关） */
  gradingChecksStolen: false,
};

// ---------- 柜台顾客（DESIGN 6，SRS 8.5） ----------
export const CUSTOMER_TYPES = ['resident', 'collector', 'rich', 'middleman', 'dealer', 'undercover'] as const;
export type CustomerType = (typeof CUSTOMER_TYPES)[number];

export const CUSTOMER: Record<CustomerType, {
  name: string;
  ppm: number;
  /** MVP 里有没有这类顾客（DESIGN 12：MVP 不含卡贩和便衣） */
  mvp: boolean;
  /** 心理价位的类型系数；中间人特殊，按基准价的固定比例收 */
  priceCoef: number;
  patience: number;
  /** 成交后识破假卡的概率（ppm） */
  detect: { low_fake: number; high_fake: number };
}> = {
  resident: { name: '下层区居民', ppm: 350_000, mvp: true, priceCoef: 0.8, patience: 4, detect: { low_fake: 300_000, high_fake: 100_000 } },
  // 收藏家收 SR 以上的卡，封壳的不限稀有度但要评分够高（见 COLLECTOR）
  collector: { name: '收藏家', ppm: 200_000, mvp: true, priceCoef: 1.2, patience: 2, detect: { low_fake: 800_000, high_fake: 500_000 } },
  rich: { name: '上层区富人', ppm: 150_000, mvp: true, priceCoef: 1.4, patience: 3, detect: { low_fake: 100_000, high_fake: 50_000 } },
  middleman: { name: '黑市中间人', ppm: 150_000, mvp: true, priceCoef: 0.4, patience: 3, detect: { low_fake: 0, high_fake: 0 } },
  dealer: { name: '卡贩', ppm: 100_000, mvp: false, priceCoef: 1, patience: 3, detect: { low_fake: 0, high_fake: 0 } },
  undercover: { name: '便衣治安员', ppm: 50_000, mvp: false, priceCoef: 1, patience: 3, detect: { low_fake: 0, high_fake: 0 } },
};

export const COUNTER = {
  /**
   * 每个营业日几位顾客。2026-11-17 改：学深空当铺，营业日由玩家自己推进——开门时这几位一次到店，
   * 接待完（或请走）就能打烊，马上进入下一天。不再按悉尼时间分早中晚。
   */
  customersPerDay: 6,
  /** 心理价位随机浮动范围 */
  floatMin: 0.85,
  floatMax: 1.25,
  /** 开价 ≤ 心理价位 × 这个数算"高出不多"，扣 1 点耐心；再高扣 2 点 */
  counterThreshold: 1.15,
  /** 需求从玩家库存里出的概率（ppm），其余从全卡池出 */
  demandHitPpm: 600_000,
  /** 卖假卡被识破扣的信誉 */
  fakeCaughtRepLoss: 5,
};

/**
 * 收藏家收什么（2026-11-17 模拟调参：原来只收封壳卡，保守玩家碰不到两成多的顾客，周收入中位太低）：
 * 没封壳的卡要 rawMinRarity 及以上；封壳卡不限稀有度，但评分要 ≥ gradedMinGrade。
 */
export const COLLECTOR = { rawMinRarity: 'SR' as Rarity, gradedMinGrade: 9 };

export const REPUTATION = { start: 50, min: 0, max: 100 };

// ---------- 房租、店铺、破产、抵押（DESIGN 7） ----------
export const RENT = {
  /** 第 n 周摊位费 = base × growth^(n−1)，四舍五入到整数 */
  // 2026-11-17 模拟调参：1,000 → 2,500，把保守玩家的破产率拉到约 15%
  base: 2500,
  growth: 1.25,
  /** 每几个营业日扣一次（营业日由玩家打烊推进，2026-11-17 改） */
  everyDays: 7,
  /** 涨到第几周封顶（软赛季下周数不清零，2026-11-17 定） */
  capWeek: 8,
  /** 每周日悉尼时间几点扣 */
  dueWeekday: 0,
  dueHour: 20,
  graceHours: 24,
};
/** 2026-11-17 模拟调参：15,000 → 40,000，买店率约 70%（整季租金约 49,600，越早买越省） */
export const SHOP_PRICE = 40_000;
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

/** 珍藏柜（DESIGN 8.1、FR-INV-6）：默认格数，科技树 S1 可扩 */
export const SHOWCASE = { slots: 3 };

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

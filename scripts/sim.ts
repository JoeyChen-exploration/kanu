// 经济模拟（DESIGN 9.5、SRS M1）：直接调用 game/ 的纯函数和 balance.ts 的数值，不起服务器。
// 用法：npm run sim [-- --seasons 1000 --seed 1]
//
// 现在只有"只走正规"策略：只开正规包、不鉴定、不送评、不点科技树、不兑金币。
// 顾客模型（MVP 的 9 类，按 balance.ts 的出现率重新归一，需求按 CUSTOMER[type].wants）：
//   要卡的：需求命中率（demandHitPpm）的概率对上玩家手里某张符合稀有度的卡，随机挑一张卖（学生对特殊风格加价）；
//           怀旧老顾客点名的那张也按命中率算；
//   开箱主播要没拆的卡包：这个策略买了就拆，手上没有卡包，卖不出；
//   中间人：按基准价 40% 收未鉴定卡，玩家库存超过 30 张时把最便宜的一张卖给他。
// 讨价还价：玩家按"市场价 × 顾客类型系数"开价；心理价位够就成交，不够就按心理价位的 90%–100% 成交。
// 开包：每天开 N 包，周五起留够这周的租金再开。整周守着租金不开包的打法开局就开不出包（1,500 < 第一周租金 2,500），注定破产，不列。
// 交租：钱不够先把最值钱的卡按市场价 50% 抵押（简化成不赎回），还不够就破产。
// 买店：交完租后手上有 SHOP_PRICE + 2,000 就买。
//
// 2026-11-17 定的目标（每天 2 包、周五起留租金）：破产率约 15%、买店率约 70%、每周交租前净赚中位约 10,000 信用点（约 1,000 金币）。
// 没算进去的：送评、鉴定、科技树、顾客的具体标签、抵押赎回、新闻和供需。
import {
  COUNTER, CUSTOMER, CUSTOMER_TYPES, EXCHANGE, GRAND_COLLECTOR, MIDDLEMAN, PACKS, PHONE, WHOLESALE, atLeast, type Grade, QUESTS, type QuestMetric, PLAYER, RARITY, RENT, SEASON, SHOP_PRICE, SHOWCASE,
  STORE, TECH_NODES, type CustomerType, type Rarity, type Style,
} from '@kanu/shared/balance';
import { openPack } from '../packages/server/src/game/cards.ts';
import { gradingFee, publicPrice, rentForWeek } from '../packages/server/src/game/price.ts';
import { between, chance, pickPpm, seeded, type Rng } from '../packages/server/src/game/rng.ts';
import { detectFake, rollCustomerCount } from '../packages/server/src/game/customers.ts';
import { gradeCard, inspect, rollErrata } from '../packages/server/src/game/appraisal.ts';
import { grandChancePpm, showcaseEffects, showcaseScore, showcaseSlots } from '../packages/server/src/game/showcase.ts';
import { techEffects } from '../packages/server/src/game/tech.ts';

interface Card {
  rarity: Rarity; style: Style; value: number;
  /** 隐藏属性（模拟里才看得到）：真伪、品相、错版 */
  auth: string; grade: string; misprint: boolean;
  /** 放大镜 / 拒评 / 被顾客识破后，玩家知道是假的（只卖给中间人） */
  knownFake?: boolean;
  /** 封壳了 */
  slab?: boolean;
}

const arg = (name: string, def: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : def;
};
const SEASONS = arg('seasons', 1000);
const SEED = arg('seed', 1);
// 调参用（不改 balance.ts 先试效果）：--per-day 每个营业日顾客数、--hit 需求命中率（0–1）、--only-main 1 只跑主策略
// --per-day：把每天的平均顾客数改成这个数（在随机分布上整体加减）
const PER_DAY_SHIFT = arg('per-day', COUNTER.customersPerDay) - COUNTER.customersPerDay;
COUNTER.demandHitPpm = Math.round(arg('hit', COUNTER.demandHitPpm / 1e6) * 1e6);
const ONLY_MAIN = arg('only-main', 0) === 1;
// --shop 买店价、--rent-base 第 1 周租金、--rent-growth 每周倍率
const SHOP = arg('shop', SHOP_PRICE);
// --start 开局信用点（估新手任务奖励的影响：任务奖励大多在第一周拿到，用"开局 + 全部奖励"当上限）
PLAYER.startCredits = arg('start', PLAYER.startCredits);
// --quests 0：不发新手任务奖励（默认发，和游戏一致）
const QUESTS_ON = arg('quests', 1) === 1;
/** 新手任务里"图鉴点亮几张"用的单独随机源 */
let questRng: Rng = seeded(SEED + 7919);
/** 交易策略里放大镜 / 送评 / 错版 / 识破假卡用的单独随机源（不打乱主随机序列） */
let aRng: Rng = seeded(SEED + 104729);
RENT.base = arg('rent-base', RENT.base);
RENT.growth = arg('rent-growth', RENT.growth);
// --price SR=800,SSR=2500：临时改某几档的基准价
const priceArg = process.argv.indexOf('--price');
if (priceArg >= 0) for (const kv of String(process.argv[priceArg + 1]).split(',')) { const [r, v] = kv.split('='); RARITY[r as Rarity].basePrice = Number(v); }

// 珍藏柜调参：--sc-prices 2000,8000,25000 各级价格、--sc-pts 每几分 +1%、--sc-cap 加成上限（0–1）
const scPrices = process.argv.indexOf('--sc-prices');
if (scPrices >= 0) String(process.argv[scPrices + 1]).split(',').forEach((v, i) => { if (SHOWCASE.levels[i + 1]) SHOWCASE.levels[i + 1]!.price = Number(v); });
SHOWCASE.pointsPerPct = arg('sc-pts', SHOWCASE.pointsPerPct);
SHOWCASE.maxPriceBonus = arg('sc-cap', SHOWCASE.maxPriceBonus);
// 大藏家调参：--grand-per 每分几 ppm、--grand-max 几率上限 ppm
GRAND_COLLECTOR.ppmPerPoint = arg('grand-per', GRAND_COLLECTOR.ppmPerPoint);
GRAND_COLLECTOR.maxPpm = arg('grand-max', GRAND_COLLECTOR.maxPpm);

const MVP_TYPES = CUSTOMER_TYPES.filter((t) => CUSTOMER[t].mvp);
const SHOP_BUFFER = 2000;
/** 珍藏柜策略：买完还要剩下这周租金 + 这么多 */
const SHOWCASE_BUFFER = 1000;
const MIDDLEMAN_STOCK = 30;

function sell(rng: Rng, card: Card, type: CustomerType, showcaseMult = 1): number {
  const w = CUSTOMER[type].wants;
  const bonus = w.kind === 'card' && w.styleBonus && card.style !== 'standard' ? w.styleBonus : 1;
  // 2026-11-18 出价规则：心理价位 = 市场价 × 风格加成 × (1 + premium 范围里随机) × 珍藏柜加成，最低就是市场价。
  // 玩家开价取 premium 范围的中间（玩家知道自己的展示分，开价跟着抬）；心理价位够就按开价成交，不够就按还价（心理价位的 90–100%）成交
  const [lo, hi] = CUSTOMER[type].premium;
  const base = card.value * bonus * showcaseMult;
  const ask = base * (1 + (lo + hi) / 2);
  const mind = base * (1 + between(rng, lo, hi));
  return Math.round(mind >= ask ? ask : mind * between(rng, 0.9, 1));
}

function takeRandom(rng: Rng, inv: Card[], ok: (c: Card) => boolean): Card | null {
  const idx = inv.flatMap((c, i) => (ok(c) ? [i] : []));
  if (!idx.length) return null;
  const i = idx[rng.int(idx.length)]!;
  return inv.splice(i, 1)[0]!;
}

interface SeasonResult {
  bankrupts: number;
  shopWeek: number | null;
  /** 每周交租前净赚：卖卡收入 − 卡包支出（珍藏柜花费另算） */
  weeklyNet: number[];
  endCredits: number;
  /** 珍藏柜：赛季末等级、每天展示分、花在珍藏柜上的钱、第几周解锁 */
  showcaseLevel: number;
  dailyScore: number[];
  showcaseSpent: number;
  showcaseWeek: number | null;
  /** 新手任务奖励一共领了多少；第一次破产在第几周 */
  questIncome: number;
  firstBankruptWeek: number | null;
  /** 大藏家：来了几次、成交几次、成交收入 */
  grandVisits: number;
  grandSales: number;
  grandIncome: number;
  /** 交易策略：批发几盒、送评几张（封壳 / 拒评）、被顾客识破几次、假卡卖给中间人几张、送评花了多少 */
  /** 科技树策略：点了几个节点、花了多少、第几周点满 MVP */
  tech?: { nodes: number; spent: number; doneWeek: number | null };
  trade?: { boxes: number; graded: number; slabs: number; rejected: number; caught: number; fakesToMiddleman: number; gradingSpent: number };
}

const cardScore = (c: Card) => showcaseScore([c]);

/**
 * 珍藏柜策略：off 不用；hoard 柜里的卡不卖（只当门面）；sell 柜里的卡有人要照样卖，第二天再补上。
 * 展示分按每天开门时柜里的卡算。
 */
type ShowcaseMode = 'off' | 'hoard' | 'sell';

/**
 * 科技树策略：只点对这种打法有用的节点，先留出这周和下周的租金 + 1,000 再点（柜台 C1 → C2 人人有用；珍藏柜打法加 S1；批发送评打法加 A1、P1；
 * 每天开不到限购的人不点 G1），每天最多点一个。
 */
const techOrder = (mode: ShowcaseMode, trade: boolean, packsPerDay: number) =>
  ['C1', 'C2', ...(mode !== 'off' ? ['S1'] : []), ...(trade ? ['A1', 'P1'] : []), ...(packsPerDay >= STORE.packsPerDay ? ['G1'] : [])];

function season(rng: Rng, packsPerDay: number, reserveFromDay: number, mode: ShowcaseMode, trade = false, tech = false): SeasonResult {
  const techOwned = new Set<string>();
  let techSpent = 0;
  let techDoneWeek: number | null = null;
  let fx = techEffects(techOwned);
  const useShowcase = mode !== 'off';
  // 交易策略（trade）：钱够就买电话，每天批发一盒；新卡都用放大镜看，看出假的只卖中间人；
  // SR 以上、估品相 9 分以上或认出错版的送评，第二天出结果。鉴定相关的随机数用单独的 aRng
  let phone = false;
  let gradingQueue: Array<{ card: Card; due: number }> = [];
  let dayIndex = 0;
  let boxes = 0, graded = 0, slabs = 0, rejected = 0, caught = 0, fakesToMiddleman = 0, gradingSpent = 0;
  let credits = PLAYER.startCredits;
  let week = 1; // 玩家自己的第几周，破产后从 1 重算
  let pity = 0;
  let shopWeek: number | null = null;
  let bankrupts = 0;
  let inv: Card[] = [];
  const weeklyNet: number[] = [];
  let firstBankruptWeek: number | null = null;
  // 珍藏柜：钱够（留出这周租金 + 缓冲）就解锁 / 升级；每天开门前把展示分最高的卡换进柜里
  let level = 0;
  let shelf: Card[] = [];
  let showcaseSpent = 0;
  let showcaseWeek: number | null = null;
  const dailyScore: number[] = [];
  let grandVisits = 0, grandSales = 0, grandIncome = 0;
  // 新手任务（balance.QUESTS）：达到进度就领奖（一个赛季只领一次，破产重来也不再领）。
  // 图鉴点亮张数用单独的随机源模拟（不打乱主随机序列，和不开任务的结果可比）
  const qstats: Record<QuestMetric, number> = { packsBought: 0, packsOpened: 0, sales: 0, daysEnded: 0, collected: 0, showcaseLevel: 0, showcaseCards: 0, binders: 1, rentPaid: 0, middlemanSales: 0, inspections: 0 };
  const claimed = new Set<string>();
  const seen = new Set<string>();
  let questIncome = 0;
  const payQuests = () => {
    if (!QUESTS_ON) return;
    for (const q of QUESTS) {
      if (claimed.has(q.id) || qstats[q.metric] < q.target) continue;
      claimed.add(q.id); credits += q.reward; questIncome += q.reward;
    }
  };
  const addCard = (c: { rarity: Rarity; style: Style; authenticity: string; grade: Grade }, reserve = 0) => {
    const card: Card = { rarity: c.rarity, style: c.style, value: publicPrice({ rarity: c.rarity, style: c.style, publicGrade: null }), auth: c.authenticity, grade: String(c.grade), misprint: rollErrata(aRng) };
    if (trade) {
      const look = inspect(aRng, { authenticity: card.auth, grade: card.grade, misprint: card.misprint }, fx.errataDetectPpm);
      if (look.looks === 'fake') card.knownFake = true;
      const good = ['9', '10', 'BL'].includes(look.gradeRange[0]) || look.errataFound;
      const fee = gradingFee(card.rarity, card.style);
      if (!card.knownFake && phone && atLeast(card.rarity, 'SR') && good && credits - fee >= reserve) {
        credits -= fee; gradingSpent += fee; graded += 1;
        gradingQueue.push({ card, due: dayIndex + 1 });
        return;
      }
    }
    inv.push(card);
  };
  const restock = () => {
    const slots = showcaseSlots(level, fx.showcaseSlots);
    const pool = [...shelf, ...inv].sort((a, b) => cardScore(b) - cardScore(a) || b.value - a.value);
    shelf = pool.slice(0, slots).filter((c) => cardScore(c) > 0);
    const kept = new Set(shelf);
    inv = pool.filter((c) => !kept.has(c));
  };

  /** 电话批发：订单哪天下的（没有就 null）；今天送货员占了几个顾客名额 */
  let orderedDay: number | null = null;
  let courierToday = 0;
  for (let w = 1; w <= SEASON.weeks; w += 1) {
    let income = 0, spent = 0;
    for (let day = 0; day < 7; day += 1) {
      const reserve = shopWeek || day < reserveFromDay ? 0 : rentForWeek(week);
      dayIndex += 1;
      if (tech) {
        const next = techOrder(mode, trade, packsPerDay).map((id) => TECH_NODES.find((n) => n.id === id)!).find((n) => !techOwned.has(n.id)
          && n.requires.every((r) => techOwned.has(r)) && n.conditions.every((c) => c.kind !== 'metric' || qstats[c.metric] >= c.target));
        if (next && credits - next.price >= (shopWeek ? 0 : rentForWeek(week) + rentForWeek(week + 1)) + 1000) {
          credits -= next.price; techSpent += next.price; techOwned.add(next.id); fx = techEffects(techOwned);
          if (techOwned.size === techOrder(mode, trade, packsPerDay).length) techDoneWeek ??= w;
        }
      }
      if (trade) {
        // 评级社出结果：真卡封壳按分定价（错版 ×），假卡拒评、知道是假的
        const back = gradingQueue.filter((g) => g.due <= dayIndex);
        gradingQueue = gradingQueue.filter((g) => g.due > dayIndex);
        for (const { card } of back) {
          const r = gradeCard(aRng, { authenticity: card.auth, grade: card.grade, misprint: card.misprint });
          if (r.kind === 'slab') {
            slabs += 1; card.slab = true;
            card.value = publicPrice({ rarity: card.rarity, style: card.style, publicGrade: (r.slab.score === 'BL' ? 'BL' : Number(r.slab.score)) as Grade, publicErrata: r.slab.errata });
          } else { rejected += 1; card.knownFake = true; }
          inv.push(card);
        }
        const keep = reserve + 1000;
        if (!phone && credits - PHONE.price >= keep) { credits -= PHONE.price; spent += PHONE.price; phone = true; }
        const box = Math.round(PACKS.themed.price * fx.wholesaleDiscount) * WHOLESALE.boxPacks;
        // 隔日送达：昨天订的今天送货员来柜台（占一个顾客名额），钱够就收货付款，不够就拒收
        if (orderedDay !== null && dayIndex >= orderedDay + WHOLESALE.deliveryDays) {
          orderedDay = null; courierToday = 1;
          if (credits - box >= keep) {
            credits -= box; spent += box; boxes += 1;
            for (let p = 0; p < WHOLESALE.boxPacks; p += 1) {
              const r = openPack(rng, { packType: 'themed', pityCount: pity, serialAvailable: () => true, fakePpm: WHOLESALE.fakePpm });
              pity = r.pityCount;
              for (const c of r.cards) addCard(c, keep);
            }
          }
        }
        if (phone && orderedDay === null && credits - box >= keep) orderedDay = dayIndex;
      }
      const n = Math.max(0, Math.min(packsPerDay, Math.floor((credits - reserve) / PACKS.themed.price)));
      for (let p = 0; p < n; p += 1) {
        credits -= PACKS.themed.price; spent += PACKS.themed.price;
        const r = openPack(rng, { packType: 'themed', pityCount: pity, serialAvailable: () => true });
        pity = r.pityCount;
        for (const c of r.cards) addCard(c);
        // 图鉴：这包是 4 种主题包里随机一种，每张卡是这个稀有度里随机一张
        const series = questRng.int(4);
        for (const c of r.cards) seen.add(`${series}-${c.rarity}-${questRng.int(Math.max(1, PACKS.themed.composition[c.rarity]))}`);
      }
      if (n > 0) { qstats.packsBought += 1; qstats.packsOpened += n; qstats.collected = seen.size; }
      if (useShowcase) {
        const next = SHOWCASE.levels[level + 1];
        const keep = (shopWeek ? 0 : rentForWeek(week)) + SHOWCASE_BUFFER;
        if (next && credits - next.price >= keep) {
          credits -= next.price; showcaseSpent += next.price; level += 1;
          showcaseWeek ??= w;
        }
        restock();
      }
      const score = showcaseScore(shelf);
      dailyScore.push(score);
      const mult = showcaseEffects(score).priceMult;
      // 照卖：柜里的卡放回可卖的池子，今天卖掉的明天再补
      if (mode === 'sell') { inv.push(...shelf); shelf = []; }
      const todayCustomers = Math.max(0, rollCustomerCount(rng, PER_DAY_SHIFT + fx.customersPerDay) - courierToday);
      courierToday = 0;
      for (let k = 0; k < todayCustomers; k += 1) {
        // 珍藏柜展示分够高时，有几率换成大藏家（和服务器同一个函数）
        const grand = grandChancePpm(score);
        const type: CustomerType = grand > 0 && chance(rng, grand) ? 'grand' : pickPpm(rng, MVP_TYPES, (t) => CUSTOMER[t].ppm);
        if (type === 'grand') grandVisits += 1;
        let card: Card | null = null;
        let price = 0;
        const wants = CUSTOMER[type].wants;
        if (type === 'middleman') {
          const fakeIdx = inv.findIndex((c) => c.knownFake);
          if (fakeIdx >= 0) { card = inv.splice(fakeIdx, 1)[0]!; fakesToMiddleman += 1; }
          else if (inv.length > MIDDLEMAN_STOCK) { inv.sort((a, b) => a.value - b.value); card = inv.shift()!; }
          if (card) price = Math.round(RARITY[card.rarity].basePrice * MIDDLEMAN.basePct);
        } else if (wants.kind === 'card' && chance(rng, COUNTER.demandHitPpm)) {
          card = takeRandom(rng, inv, (c) => wants.rarities.includes(c.rarity) && !c.knownFake);
          if (card) price = sell(rng, card, type, mult);
          // 没看出来的假卡：顾客可能当场识破，退款、卡退回（信誉在模拟里不算）
          if (card && !card.slab && card.auth !== 'real' && detectFake(aRng, type, card.auth, false)) {
            price = 0; caught += 1; card.knownFake = true; inv.push(card);
          }
          if (card && type === 'grand') { grandSales += 1; grandIncome += price; }
        }
        credits += price; income += price;
        if (price > 0) qstats.sales += 1;
      }
      // 打烊后把剩下的好卡放回柜里（柜里的卡交租时不能抵押，破产时留下）
      if (mode === 'sell') restock();
      qstats.daysEnded += 1;
      qstats.showcaseLevel = level;
      qstats.showcaseCards = shelf.length;
      payQuests();
    }
    weeklyNet.push(income - spent);

    if (!shopWeek) {
      const due = rentForWeek(week);
      inv.sort((a, b) => b.value - a.value);
      while (credits < due && inv.length) credits += Math.round(inv.shift()!.value * 0.5);
      // 珍藏柜里的卡不能抵押；破产时珍藏柜和柜里的卡都留下
      if (credits < due) {
        bankrupts += 1; credits = PLAYER.restartCredits; inv = []; week = 1;
        firstBankruptWeek ??= w;
      } else {
        credits -= due; week += 1;
      }
    }
    if (!shopWeek && credits >= SHOP + SHOP_BUFFER) { credits -= SHOP; shopWeek = w; }
  }
  return { bankrupts, shopWeek, weeklyNet, endCredits: credits, showcaseLevel: level, dailyScore, showcaseSpent, showcaseWeek, grandVisits, grandSales, grandIncome, questIncome, firstBankruptWeek,
    tech: tech ? { nodes: techOwned.size, spent: techSpent, doneWeek: techDoneWeek } : undefined,
    trade: trade ? { boxes, graded, slabs, rejected, caught, fakesToMiddleman, gradingSpent } : undefined };
}

const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]!; };
const fmt = (n: number) => Math.round(n).toLocaleString('en-US');

console.log(`卡奴经济模拟：只走正规，${SEASONS} 个赛季 × ${SEASON.weeks} 周，种子 ${SEED}\n`);
const MODE_LABEL: Record<ShowcaseMode, string> = { off: '', hoard: '，珍藏柜（柜里的卡不卖）', sell: '，珍藏柜（柜里的卡照卖）' };
const VARIANTS = ([
  [2, 'off', false, false], [2, 'off', false, true], [2, 'off', true, false], [2, 'off', true, true], [2, 'sell', false, false], [2, 'sell', false, true], [2, 'hoard', false, false],
  ...(ONLY_MAIN ? [] : [[5, 'off', false, false], [5, 'off', false, true], [5, 'off', true, false], [5, 'sell', false, false], [5, 'hoard', false, false]]),
]) as unknown as ReadonlyArray<readonly [number, ShowcaseMode, boolean, boolean]>;
for (const [packsPerDay, mode, trade, tech] of VARIANTS) {
  const reserveFromDay = 5;
  const label = `周五起才留租金${MODE_LABEL[mode]}${trade ? '，电话批发 + 放大镜 + 送评' : ''}${tech ? '，科技树（只点这种打法用得上的节点）' : ''}`;
  const useShowcase = mode !== 'off';
  const rng = seeded(SEED);
  questRng = seeded(SEED + 7919);
  aRng = seeded(SEED + 104729);
  const rs = Array.from({ length: SEASONS }, () => season(rng, packsPerDay, reserveFromDay, mode, trade, tech));
  const nets = rs.flatMap((r) => r.weeklyNet);
  const shopWeeks = rs.flatMap((r) => (r.shopWeek ? [r.shopWeek] : []));
  const bankruptRate = rs.filter((r) => r.bankrupts > 0).length / SEASONS;

  console.log(`## 每天 ${packsPerDay} 包，${label}`);
  console.log(`破产率（一季至少破产一次）  ${(bankruptRate * 100).toFixed(1)}%`);
  console.log(`买店率                      ${((shopWeeks.length / SEASONS) * 100).toFixed(1)}%`);
  if (shopWeeks.length) console.log(`买店周数 P25 / 中位 / P75     第 ${pct(shopWeeks, 0.25)} / ${pct(shopWeeks, 0.5)} / ${pct(shopWeeks, 0.75)} 周`);
  console.log(`每周交租前净赚 中位 / 平均  ${fmt(pct(nets, 0.5))} / ${fmt(nets.reduce((s, v) => s + v, 0) / nets.length)} 信用点`);
  console.log(`  折合金币 中位 / 平均      ${fmt(pct(nets, 0.5) / EXCHANGE.creditsPerCoin)} / ${fmt(nets.reduce((s, v) => s + v, 0) / nets.length / EXCHANGE.creditsPerCoin)}（目标：中位约 1,000）`);
  console.log(`  P10 / P90                 ${fmt(pct(nets, 0.1))} / ${fmt(pct(nets, 0.9))}`);
  console.log(`赛季末信用点 中位           ${fmt(pct(rs.map((r) => r.endCredits), 0.5))}`);
  const firstWeeks = rs.flatMap((r) => (r.firstBankruptWeek ? [r.firstBankruptWeek] : []));
  if (firstWeeks.length) {
    const byWeek = Array.from({ length: SEASON.weeks }, (_, i) => firstWeeks.filter((x) => x === i + 1).length);
    console.log(`第一次破产在第几周（占全部赛季） ${byWeek.map((n, i) => `${i + 1}:${((n / SEASONS) * 100).toFixed(1)}%`).join(' ')}`);
  }
  if (trade) {
    const avg = (k: 'boxes' | 'graded' | 'slabs' | 'rejected' | 'caught' | 'fakesToMiddleman' | 'gradingSpent') => rs.reduce((x, r) => x + (r.trade?.[k] ?? 0), 0) / SEASONS;
    console.log(`交易 每季平均：批发 ${avg('boxes').toFixed(1)} 盒，送评 ${avg('graded').toFixed(1)} 张（封壳 ${avg('slabs').toFixed(1)}、拒评 ${avg('rejected').toFixed(1)}，花 ${fmt(avg('gradingSpent'))}），假卡被顾客识破 ${avg('caught').toFixed(1)} 次、卖给中间人 ${avg('fakesToMiddleman').toFixed(1)} 张`);
  }
  if (tech) {
    const t = rs.map((r) => r.tech!);
    const done = t.flatMap((x) => (x.doneWeek ? [x.doneWeek] : []));
    console.log(`科技树 每季平均点 ${(t.reduce((a, x) => a + x.nodes, 0) / SEASONS).toFixed(1)} 个、花 ${fmt(t.reduce((a, x) => a + x.spent, 0) / SEASONS)}；点完这种打法要的节点的 ${((done.length / SEASONS) * 100).toFixed(0)}%（中位第 ${done.length ? pct(done, 0.5) : '-'} 周）`);
  }
  if (QUESTS_ON) console.log(`新手任务奖励 平均             ${fmt(rs.reduce((s, r) => s + r.questIncome, 0) / SEASONS)} 信用点`);
  if (useShowcase) {
    const levels = rs.map((r) => r.showcaseLevel);
    const unlockWeeks = rs.flatMap((r) => (r.showcaseWeek ? [r.showcaseWeek] : []));
    const scores = rs.flatMap((r) => r.dailyScore);
    const lastWeekScores = rs.flatMap((r) => r.dailyScore.slice(-7));
    const bonus = (s: number) => Math.round((showcaseEffects(s).priceMult - 1) * 100);
    console.log(`珍藏柜 解锁率               ${((unlockWeeks.length / SEASONS) * 100).toFixed(1)}%（解锁周 中位 第 ${unlockWeeks.length ? pct(unlockWeeks, 0.5) : '-'} 周）`);
    console.log(`  赛季末等级分布            ${SHOWCASE.levels.map((_, lv) => `${lv} 级 ${((levels.filter((x) => x === lv).length / SEASONS) * 100).toFixed(0)}%`).join(' / ')}`);
    console.log(`  展示分 中位（全季 / 最后一周）  ${pct(scores, 0.5)} / ${pct(lastWeekScores, 0.5)}，P90 ${pct(lastWeekScores, 0.9)}`);
    console.log(`  预算加成 中位（最后一周）  +${bonus(pct(lastWeekScores, 0.5))}%，P90 +${bonus(pct(lastWeekScores, 0.9))}%；耐心 +1 的天数 ${((scores.filter((s) => s >= SHOWCASE.patienceAt).length / scores.length) * 100).toFixed(0)}%`);
    console.log(`  花在珍藏柜上 中位          ${fmt(pct(rs.map((r) => r.showcaseSpent), 0.5))} 信用点`);
    const visits = rs.reduce((s, r) => s + r.grandVisits, 0);
    const sales = rs.reduce((s, r) => s + r.grandSales, 0);
    const gIncome = rs.reduce((s, r) => s + r.grandIncome, 0);
    console.log(`大藏家 每季来访 平均 ${(visits / SEASONS).toFixed(1)} 次，成交 ${(sales / SEASONS).toFixed(1)} 次（${visits ? ((sales / visits) * 100).toFixed(0) : 0}%），每次成交平均 ${fmt(sales ? gIncome / sales : 0)}；一季至少来一次的 ${((rs.filter((r) => r.grandVisits > 0).length / SEASONS) * 100).toFixed(0)}%`);
  }
  console.log('');
}

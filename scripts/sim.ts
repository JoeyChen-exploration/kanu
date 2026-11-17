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
  COUNTER, CUSTOMER, CUSTOMER_TYPES, EXCHANGE, PACKS, PLAYER, RARITY, RENT, SEASON, SHOP_PRICE,
  type CustomerType, type Rarity, type Style,
} from '@kanu/shared/balance';
import { openPack } from '../packages/server/src/game/cards.ts';
import { publicPrice, rentForWeek } from '../packages/server/src/game/price.ts';
import { between, chance, pickPpm, seeded, type Rng } from '../packages/server/src/game/rng.ts';
import { rollCustomerCount } from '../packages/server/src/game/customers.ts';

interface Card { rarity: Rarity; style: Style; value: number }

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
RENT.base = arg('rent-base', RENT.base);
RENT.growth = arg('rent-growth', RENT.growth);
// --price SR=800,SSR=2500：临时改某几档的基准价
const priceArg = process.argv.indexOf('--price');
if (priceArg >= 0) for (const kv of String(process.argv[priceArg + 1]).split(',')) { const [r, v] = kv.split('='); RARITY[r as Rarity].basePrice = Number(v); }

const MVP_TYPES = CUSTOMER_TYPES.filter((t) => CUSTOMER[t].mvp);
const SHOP_BUFFER = 2000;
const MIDDLEMAN_STOCK = 30;

function sell(rng: Rng, card: Card, type: CustomerType): number {
  const w = CUSTOMER[type].wants;
  const bonus = w.kind === 'card' && w.styleBonus && card.style !== 'standard' ? w.styleBonus : 1;
  const ask = card.value * CUSTOMER[type].priceCoef * bonus;
  const mind = ask * between(rng, COUNTER.floatMin, COUNTER.floatMax);
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
  /** 每周交租前净赚：卖卡收入 − 卡包支出 */
  weeklyNet: number[];
  endCredits: number;
}

function season(rng: Rng, packsPerDay: number, reserveFromDay: number): SeasonResult {
  let credits = PLAYER.startCredits;
  let week = 1; // 玩家自己的第几周，破产后从 1 重算
  let pity = 0;
  let shopWeek: number | null = null;
  let bankrupts = 0;
  let inv: Card[] = [];
  const weeklyNet: number[] = [];

  for (let w = 1; w <= SEASON.weeks; w += 1) {
    let income = 0, spent = 0;
    for (let day = 0; day < 7; day += 1) {
      const reserve = shopWeek || day < reserveFromDay ? 0 : rentForWeek(week);
      const n = Math.max(0, Math.min(packsPerDay, Math.floor((credits - reserve) / PACKS.themed.price)));
      for (let p = 0; p < n; p += 1) {
        credits -= PACKS.themed.price; spent += PACKS.themed.price;
        const r = openPack(rng, { packType: 'themed', pityCount: pity, serialAvailable: () => true });
        pity = r.pityCount;
        for (const c of r.cards) inv.push({ rarity: c.rarity, style: c.style, value: publicPrice({ rarity: c.rarity, style: c.style, publicGrade: null }) });
      }
      const todayCustomers = rollCustomerCount(rng, PER_DAY_SHIFT);
      for (let k = 0; k < todayCustomers; k += 1) {
        const type = pickPpm(rng, MVP_TYPES, (t) => CUSTOMER[t].ppm);
        let card: Card | null = null;
        let price = 0;
        const wants = CUSTOMER[type].wants;
        if (type === 'middleman') {
          if (inv.length > MIDDLEMAN_STOCK) {
            inv.sort((a, b) => a.value - b.value);
            card = inv.shift()!;
            price = Math.round(RARITY[card.rarity].basePrice * CUSTOMER.middleman.priceCoef);
          }
        } else if (wants.kind === 'card' && chance(rng, COUNTER.demandHitPpm)) {
          card = takeRandom(rng, inv, (c) => wants.rarities.includes(c.rarity));
          if (card) price = sell(rng, card, type);
        }
        credits += price; income += price;
      }
    }
    weeklyNet.push(income - spent);

    if (!shopWeek) {
      const due = rentForWeek(week);
      inv.sort((a, b) => b.value - a.value);
      while (credits < due && inv.length) credits += Math.round(inv.shift()!.value * 0.5);
      if (credits < due) {
        bankrupts += 1; credits = PLAYER.restartCredits; inv = []; week = 1;
      } else {
        credits -= due; week += 1;
      }
    }
    if (!shopWeek && credits >= SHOP + SHOP_BUFFER) { credits -= SHOP; shopWeek = w; }
  }
  return { bankrupts, shopWeek, weeklyNet, endCredits: credits };
}

const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]!; };
const fmt = (n: number) => Math.round(n).toLocaleString('en-US');

console.log(`卡奴经济模拟：只走正规，${SEASONS} 个赛季 × ${SEASON.weeks} 周，种子 ${SEED}\n`);
for (const [packsPerDay, reserveFromDay, label] of (ONLY_MAIN ? [[2, 5, '周五起才留租金']] : [[2, 5, '周五起才留租金'], [5, 5, '周五起才留租金']]) as ReadonlyArray<readonly [number, number, string]>) {
  const rng = seeded(SEED);
  const rs = Array.from({ length: SEASONS }, () => season(rng, packsPerDay, reserveFromDay));
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
  console.log(`赛季末信用点 中位           ${fmt(pct(rs.map((r) => r.endCredits), 0.5))}\n`);
}

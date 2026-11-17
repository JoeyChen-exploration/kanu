// 柜台顾客（DESIGN 6、SRS FR-CTR-1～5）。纯函数：随机从 rng 来，玩家库存由调用方传进来。
// 心理价位、个人浮动是隐藏的，只能存库，不能发给玩家（NFR-SEC-2）。
import {
  COLLECTOR, COUNTER, CUSTOMER, CUSTOMER_TYPES, RARITIES, RARITY, atLeast,
  type CustomerType, type Rarity,
} from '@kanu/shared/balance';
import { between, chance, pickPpm, type Rng } from './rng.ts';

export const MVP_TYPES = CUSTOMER_TYPES.filter((t) => CUSTOMER[t].mvp);

/** 顾客想要什么：稀有度范围 + 可选的一个标签 */
export interface Demand {
  rarities: Rarity[];
  tag: string | null;
}

/** 玩家手上一张能拿来卖的卡（只需要公开信息 + 公开价） */
export interface SellableCard {
  id: number;
  rarity: Rarity;
  tags: string[];
  price: number;
}

export interface RolledCustomer {
  type: CustomerType;
  demand: Demand;
  /** 个人浮动 0.85–1.25（隐藏） */
  float: number;
  patience: number;
  /** 给玩家看的预算区间：故意模糊，不等于心理价位 */
  budgetLow: number;
  budgetHigh: number;
}

/** 这个营业日来几位顾客（COUNTER.customersPerDayDist，平均 customersPerDay）；bonus 是科技树和事件额外加的人 */
export function rollCustomerCount(rng: Rng, bonus = 0): number {
  const counts = Object.keys(COUNTER.customersPerDayDist).map(Number).sort((a, b) => a - b);
  return pickPpm(rng, counts, (n) => COUNTER.customersPerDayDist[n]!) + bonus;
}

/** 每类顾客收哪些稀有度 */
export function rarityClass(type: CustomerType): Rarity[] {
  switch (type) {
    case 'resident': return ['N', 'R'];
    case 'rich': return RARITIES.filter((r) => atLeast(r, 'SR'));
    case 'collector': return RARITIES.filter((r) => atLeast(r, COLLECTOR.rawMinRarity));
    default: return [...RARITIES];
  }
}

export function matches(card: SellableCard, d: Demand): boolean {
  return d.rarities.includes(card.rarity) && (d.tag === null || card.tags.includes(d.tag));
}

/** 心理价位（隐藏）：中间人按基准价的固定比例收；其他按 公开价 × 类型系数 × 个人浮动 */
export function mindPrice(type: CustomerType, float: number, card: SellableCard): number {
  if (type === 'middleman') return Math.round(RARITY[card.rarity].basePrice * CUSTOMER.middleman.priceCoef);
  return Math.round(card.price * CUSTOMER[type].priceCoef * float);
}

/** 快速出售价：按浮动下限算，所以心理价位一定够，必定成交；只用公开信息，不泄露心理价位 */
export function quickPrice(type: CustomerType, card: SellableCard): number {
  if (type === 'middleman') return mindPrice(type, 1, card);
  return Math.round(card.price * CUSTOMER[type].priceCoef * COUNTER.floatMin);
}

/**
 * 生成一位顾客（FR-CTR-3）。需求有 demandHitPpm 的概率从玩家库存里出（说成"标签 + 稀有度"，哪张合适由玩家挑），
 * 其余从全卡池的标签里随便出。allTags 是当前系列所有标签。
 */
export function rollCustomer(rng: Rng, input: { inventory: SellableCard[]; allTags: string[]; typicalPrice: (rarities: Rarity[]) => number }): RolledCustomer {
  const type = pickPpm(rng, MVP_TYPES, (t) => CUSTOMER[t].ppm);
  const rarities = rarityClass(type);
  const pool = input.inventory.filter((c) => rarities.includes(c.rarity));
  let tag: string | null = null;
  let refPrice: number;
  if (type !== 'middleman' && pool.length && chance(rng, COUNTER.demandHitPpm)) {
    const card = pool[rng.int(pool.length)]!;
    if (card.tags.length && rng.int(2) === 0) tag = card.tags[rng.int(card.tags.length)]!;
    refPrice = card.price;
  } else {
    if (type !== 'middleman' && input.allTags.length && rng.int(2) === 0) tag = input.allTags[rng.int(input.allTags.length)]!;
    refPrice = input.typicalPrice(rarities);
  }
  const float = between(rng, COUNTER.floatMin, COUNTER.floatMax);
  const coef = type === 'middleman' ? 1 : CUSTOMER[type].priceCoef;
  // 预算区间用参考价算、再取整，和心理价位不是同一个数
  const round = (n: number) => Math.max(5, Math.round(n / 5) * 5);
  const budgetLow = round(refPrice * coef * 0.7);
  const budgetHigh = round(refPrice * coef * 1.1);
  return { type, demand: { rarities, tag }, float, patience: CUSTOMER[type].patience, budgetLow, budgetHigh };
}

export type OfferOutcome =
  | { kind: 'deal'; price: number }
  | { kind: 'counter'; counterPrice: number; patience: number }
  | { kind: 'too_high'; patience: number }
  | { kind: 'left' };

/** 出价判定（FR-CTR-4，DESIGN 6 的第 3 步） */
export function evaluateOffer(rng: Rng, input: { price: number; mind: number; patience: number }): OfferOutcome {
  const { price, mind, patience } = input;
  if (price <= mind) return { kind: 'deal', price };
  if (price <= mind * COUNTER.counterThreshold) {
    const left = patience - 1;
    if (left <= 0) return { kind: 'left' };
    return { kind: 'counter', counterPrice: Math.max(1, Math.round(mind * between(rng, 0.9, 1))), patience: left };
  }
  const left = patience - 2;
  if (left <= 0) return { kind: 'left' };
  return { kind: 'too_high', patience: left };
}

/** 成交后识破假卡（FR-CTR-5）：真卡、或者已验真的卡不会被识破 */
export function detectFake(rng: Rng, type: CustomerType, authenticity: string, certified: boolean): boolean {
  if (authenticity === 'real' || certified) return false;
  const d = CUSTOMER[type].detect;
  return chance(rng, authenticity === 'low_fake' ? d.low_fake : d.high_fake);
}

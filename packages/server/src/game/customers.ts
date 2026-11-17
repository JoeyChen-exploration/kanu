// 柜台顾客（DESIGN 6、SRS FR-CTR-1～5）。纯函数：随机从 rng 来，玩家库存由调用方传进来。
// 心理价位、个人浮动是隐藏的，只能存库，不能发给玩家（NFR-SEC-2）。
// 2026-11-17：顾客一位一位进门（上一位走了才生成下一位，需求参照当时的库存）；顾客种类扩到 9 类；
// 怀旧老顾客点名要某一张卡，开箱主播要没拆的卡包。
import {
  COUNTER, CUSTOMER, CUSTOMER_TYPES, RARITY,
  type CustomerType, type Rarity,
} from '@kanu/shared/balance';
import { between, chance, pickPpm, type Rng } from './rng.ts';

export const MVP_TYPES = CUSTOMER_TYPES.filter((t) => CUSTOMER[t].mvp);

/** 顾客想要什么（存库时序列化成 JSON） */
export type Demand =
  | { kind: 'card'; rarities: Rarity[]; tag: string | null; templateId: string | null; templateName: string | null }
  | { kind: 'pack'; seriesId: string | null; seriesName: string | null };

/** 玩家手上一张能拿来卖的卡（只需要公开信息 + 公开价） */
export interface SellableCard {
  id: number;
  templateId: string;
  rarity: Rarity;
  tags: string[];
  style: string;
  price: number;
}

/** 玩家手上一包没拆的卡包 */
export interface SellablePack {
  id: number;
  seriesId: string;
  /** 这种卡包的电脑订货价 */
  price: number;
}

export interface TemplateInfo { id: string; name: string; rarity: Rarity; tags: string[] }
export interface SeriesInfo { id: string; name: string; price: number }

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

export function matchesCard(card: SellableCard, d: Demand): boolean {
  if (d.kind !== 'card') return false;
  if (d.templateId) return card.templateId === d.templateId;
  return d.rarities.includes(card.rarity) && (d.tag === null || card.tags.includes(d.tag));
}

export function matchesPack(pack: SellablePack, d: Demand): boolean {
  return d.kind === 'pack' && (d.seriesId === null || d.seriesId === pack.seriesId);
}

const styleMult = (type: CustomerType, style: string) => {
  const w = CUSTOMER[type].wants;
  return w.kind === 'card' && w.styleBonus && style !== 'standard' ? w.styleBonus : 1;
};

/** 卡的心理价位（隐藏）：中间人按基准价的固定比例收；其他按 公开价 × 类型系数 × 风格加成 × 个人浮动 */
export function mindPrice(type: CustomerType, float: number, card: SellableCard): number {
  if (type === 'middleman') return Math.round(RARITY[card.rarity].basePrice * CUSTOMER.middleman.priceCoef);
  return Math.round(card.price * CUSTOMER[type].priceCoef * styleMult(type, card.style) * float);
}

/** 卡包的心理价位（隐藏）：电脑订货价 × 类型系数 × 个人浮动 */
export function mindPricePack(type: CustomerType, float: number, pack: SellablePack): number {
  return Math.round(pack.price * CUSTOMER[type].priceCoef * float);
}

/** 快速出售价：按浮动下限算，所以心理价位一定够，必定成交；只用公开信息，不泄露心理价位 */
export function quickPrice(type: CustomerType, card: SellableCard): number {
  if (type === 'middleman') return mindPrice(type, 1, card);
  return mindPrice(type, COUNTER.floatMin, card);
}
export const quickPricePack = (type: CustomerType, pack: SellablePack) => mindPricePack(type, COUNTER.floatMin, pack);

/**
 * 生成一位顾客（FR-CTR-3）。需求有 demandHitPpm 的概率从玩家当时的库存里出（说成"标签 + 稀有度"、或点名某张卡、或某种卡包，
 * 哪张合适由玩家挑），其余从全部卡牌 / 卡包里随便出。
 */
export function rollCustomer(rng: Rng, input: {
  inventory: SellableCard[];
  packs: SellablePack[];
  templates: TemplateInfo[];
  series: SeriesInfo[];
  typicalPrice: (rarities: Rarity[]) => number;
  /** 指定类型（比如卡册效果带来的额外收藏家）；不传就按出现率抽 */
  forceType?: CustomerType;
  /** 珍藏柜展示分的效果：预算和心理价位（float）一起乘 priceMult，耐心加 patienceBonus */
  showcase?: { priceMult: number; patienceBonus: number };
}): RolledCustomer {
  const type = input.forceType ?? pickPpm(rng, MVP_TYPES, (t) => CUSTOMER[t].ppm);
  const wants = CUSTOMER[type].wants;
  const hit = chance(rng, COUNTER.demandHitPpm);
  let demand: Demand;
  let refPrice: number;

  if (wants.kind === 'pack') {
    const own = hit && input.packs.length ? input.packs[rng.int(input.packs.length)]! : null;
    // 一半的主播不挑卡包种类
    const pickSeries = rng.int(2) === 0;
    const s = own ? input.series.find((x) => x.id === own.seriesId) ?? null : input.series[rng.int(input.series.length)] ?? null;
    demand = pickSeries && s ? { kind: 'pack', seriesId: s.id, seriesName: s.name } : { kind: 'pack', seriesId: null, seriesName: null };
    refPrice = (s?.price ?? input.series[0]?.price ?? 300) * CUSTOMER[type].priceCoef;
  } else if (wants.template) {
    const pool = input.inventory.filter((c) => wants.rarities.includes(c.rarity));
    const own = hit && pool.length ? pool[rng.int(pool.length)]! : null;
    const tpl = own ? input.templates.find((x) => x.id === own.templateId)! : input.templates[rng.int(input.templates.length)]!;
    demand = { kind: 'card', rarities: [tpl.rarity], tag: null, templateId: tpl.id, templateName: tpl.name };
    refPrice = (own?.price ?? input.typicalPrice([tpl.rarity])) * CUSTOMER[type].priceCoef;
  } else {
    const pool = input.inventory.filter((c) => wants.rarities.includes(c.rarity));
    const own = type !== 'middleman' && hit && pool.length ? pool[rng.int(pool.length)]! : null;
    let tag: string | null = null;
    if (chance(rng, wants.tagChance)) {
      const tags = own ? own.tags : [...new Set(input.templates.flatMap((x) => x.tags))];
      if (tags.length) tag = tags[rng.int(tags.length)]!;
    }
    demand = { kind: 'card', rarities: wants.rarities, tag, templateId: null, templateName: null };
    const ref = own?.price ?? input.typicalPrice(wants.rarities);
    refPrice = type === 'middleman' ? ref * CUSTOMER.middleman.priceCoef : ref * CUSTOMER[type].priceCoef;
  }

  const fx = input.showcase ?? { priceMult: 1, patienceBonus: 0 };
  // 珍藏柜加成直接乘进个人浮动（隐藏），心理价位跟着涨；快速出售价仍按浮动下限算，不吃加成
  const float = between(rng, COUNTER.floatMin, COUNTER.floatMax) * fx.priceMult;
  refPrice *= fx.priceMult;
  // 预算区间用参考价算、再取整，和心理价位不是同一个数
  const round = (n: number) => Math.max(5, Math.round(n / 5) * 5);
  return { type, demand, float, patience: CUSTOMER[type].patience + fx.patienceBonus, budgetLow: round(refPrice * 0.7), budgetHigh: round(refPrice * 1.1) };
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

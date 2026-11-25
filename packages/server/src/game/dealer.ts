// 卡贩（柜台收卡，DESIGN 4 / 6）：纯函数，随机源由调用方传入。
// 卡贩带来的卡属性全未知（假卡、赃物都有可能）；他心里有个底价，玩家出价够就卖，不够就还价，耐心用完就走。
import { DEALER, RARITIES, type Rarity } from '@kanu/shared/balance';
import { between, chance, type Rng } from './rng.ts';
import { rollGrade, rollRarity, rollStyle, type Authenticity, type Origin } from './cards.ts';
import type { Grade, Style } from '@kanu/shared/balance';

export interface DealerCard { templateId: string; rarity: Rarity; style: Style; grade: Grade; authenticity: Authenticity; origin: Origin }

/** 卡贩带几张卡、都是什么（templates：每个稀有度能抽的卡牌模板，所有系列一起） */
export function rollDealerCards(rng: Rng, templates: Partial<Record<Rarity, string[]>>): DealerCard[] {
  const [lo, hi] = DEALER.cards;
  const n = lo + rng.int(hi - lo + 1);
  const out: DealerCard[] = [];
  for (let i = 0; i < n; i += 1) {
    let rarity = rollRarity(rng, DEALER.packType);
    // 这个稀有度没有卡（比如只有典藏包有 MR）就往下降
    while (!templates[rarity]?.length && rarity !== 'N') rarity = RARITIES[RARITIES.indexOf(rarity) - 1]!;
    const pool = templates[rarity] ?? [];
    if (!pool.length) continue;
    const templateId = pool[rng.int(pool.length)]!;
    const fake = chance(rng, DEALER.fakePpm);
    out.push({
      templateId, rarity,
      style: rollStyle(rng, rarity, { allowSerial: false }),
      grade: rollGrade(rng),
      authenticity: fake ? (rng.int(2) === 0 ? 'low_fake' : 'high_fake') : 'real',
      origin: chance(rng, DEALER.stolenPpm) ? 'stolen' : 'unknown',
    });
  }
  return out;
}

/** 卡贩心里的底价：市场价（未评级的公开价）× askPct 之间随机，至少 1 */
export function dealerAsk(rng: Rng, marketPrice: number): number {
  return Math.max(1, Math.round(marketPrice * between(rng, DEALER.askPct[0], DEALER.askPct[1])));
}

export type DealerOutcome =
  | { kind: 'deal' }
  | { kind: 'counter'; counterPrice: number; patience: number }
  | { kind: 'leave' };

/** 玩家出价收卡：≥ 底价成交；不够就还价（底价往上加一点），耐心减 1，用完就走 */
export function evaluateDealerOffer(rng: Rng, input: { price: number; ask: number; patience: number }): DealerOutcome {
  if (input.price >= input.ask) return { kind: 'deal' };
  const left = input.patience - 1;
  if (left <= 0) return { kind: 'leave' };
  return { kind: 'counter', counterPrice: Math.max(input.ask, Math.round(input.ask * between(rng, DEALER.counterUp[0], DEALER.counterUp[1]))), patience: left };
}

// 开包：稀有度、外层风格、真实品相、真伪、来源（DESIGN 3、4、5.2；SRS FR-PACK-1～5、9）。
// 纯函数：所有随机从 rng 来，编号限定还剩不剩由调用方查库后传进来。
import {
  atLeast, GRADE, GRADES, PACKS, PITY, RARITIES, RARITY, STYLE, STYLES,
  type Grade, type PackType, type Rarity, type Style,
} from '@kanu/shared/balance';
import { chance, pickPpm, type Rng } from './rng.ts';

export type Authenticity = 'real' | 'low_fake' | 'high_fake';
export type Origin = 'legit' | 'unknown' | 'stolen';

/** 一张新开出来的卡的全部属性。真伪、品相、来源都是隐藏属性，只能存库，不能原样发给玩家 */
export interface RolledCard {
  rarity: Rarity;
  /** 在该稀有度的模板列表里的下标，调用方据此换成模板 id */
  templateIndex: number;
  style: Style;
  grade: Grade;
  authenticity: Authenticity;
  origin: Origin;
}

export function rollRarity(rng: Rng, packType: PackType): Rarity {
  const odds = PACKS[packType].odds;
  return pickPpm(rng, RARITIES, (r) => odds[r]);
}

/**
 * 外层风格。稀有度不够的受限风格按标准框处理（DESIGN 3.4）；
 * 编号限定发完了、或者明确不许出（保底），也按标准框。
 */
export function rollStyle(rng: Rng, rarity: Rarity, opts: { allowSerial: boolean }): Style {
  const style = pickPpm(rng, STYLES, (s) => STYLE[s].ppm);
  const min = STYLE[style].minRarity;
  if (min && !atLeast(rarity, min)) return 'standard';
  if (style === 'serial' && !opts.allowSerial) return 'standard';
  return style;
}

export function rollGrade(rng: Rng): Grade {
  return pickPpm(rng, GRADES, (g) => GRADE[g]!.ppm);
}

/**
 * 四个分项（居中、边角、边缘、表面），只在送评封壳时生成、展示用。
 * 黑标四项全 10；普通 10 分至少有一项不是 10；其余围着总分 ±1 浮动（0.5 一档）。
 */
export function rollSubgrades(rng: Rng, grade: Grade): [number, number, number, number] {
  if (grade === 'BL') return [10, 10, 10, 10];
  const steps = [-1, -0.5, 0, 0.5, 1];
  const sub = [0, 1, 2, 3].map(() => Math.min(10, Math.max(1, grade + steps[rng.int(steps.length)]!))) as [number, number, number, number];
  // 返回值写明 boolean：否则 TS 会把 x === 10 推断成类型守卫，把 sub 收窄成全 10
  if (grade === 10 && sub.every((x): boolean => x === 10)) sub[rng.int(4)] = 9.5;
  return sub;
}

export interface OpenPackInput {
  packType: PackType;
  /** 开这包之前，连续多少包（计保底的卡包）没出 SSR 及以上 */
  pityCount: number;
  /** 这种卡包（系列）里每个稀有度有几张模板；不传就用 PACKS[packType].composition */
  templateCounts?: Record<Rarity, number>;
  /** 覆盖这包每张卡的假卡率（ppm）：电话批发不保证正品时用（DESIGN 4） */
  fakePpm?: number;
  /** 某张模板的编号限定还有没有剩（调用方查 serials 表） */
  serialAvailable: (rarity: Rarity, templateIndex: number) => boolean;
}

export interface OpenPackResult {
  cards: RolledCard[];
  /** 开完这包之后的保底计数 */
  pityCount: number;
  pityTriggered: boolean;
}

function rollCard(rng: Rng, input: OpenPackInput, rarity: Rarity, allowSerial: boolean): RolledCard {
  const counts = input.templateCounts ?? PACKS[input.packType].composition;
  const templateIndex = rng.int(counts[rarity]);
  const style = rollStyle(rng, rarity, { allowSerial: allowSerial && input.serialAvailable(rarity, templateIndex) });
  const grade = rollGrade(rng);
  const pack = PACKS[input.packType];
  let authenticity: Authenticity = 'real';
  if (chance(rng, input.fakePpm ?? pack.fakePpm)) authenticity = rng.int(2) === 0 ? 'low_fake' : 'high_fake';
  let origin: Origin = 'legit';
  if (input.packType === 'black') origin = chance(rng, pack.stolenPpm) ? 'stolen' : 'unknown';
  return { rarity, templateIndex, style, grade, authenticity, origin };
}

export function openPack(rng: Rng, input: OpenPackInput): OpenPackResult {
  const pack = PACKS[input.packType];
  const cards = Array.from({ length: pack.cards }, () => rollCard(rng, input, rollRarity(rng, input.packType), true));

  if (!pack.pity) return { cards, pityCount: input.pityCount, pityTriggered: false };

  const hit = cards.some((c) => atLeast(c.rarity, PITY.rarity));
  if (hit) return { cards, pityCount: 0, pityTriggered: false };
  if (input.pityCount + 1 < PITY.packs) return { cards, pityCount: input.pityCount + 1, pityTriggered: false };

  // 保底：随机换掉一张，换成 SSR，风格照常随机但不出编号限定（FR-PACK-4）
  cards[rng.int(cards.length)] = rollCard(rng, input, PITY.rarity, false);
  return { cards, pityCount: 0, pityTriggered: true };
}

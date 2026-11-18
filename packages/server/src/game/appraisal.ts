// 鉴定（DESIGN 5，2026-11-17 用户重定）。纯函数：随机从 rng 来，卡的隐藏属性由调用方传进来。
// - 放大镜：柜台上的道具，拖到卡上查验（学深空当铺）。一次查三样：看起来真不真、品相大概几分（相邻两档）、是不是错版。
//   结论只给玩家自己看，不改卡价；每张卡只查一次，结论存库不再变。
// - 送评（星港评级社，在电话里）：真卡封壳，评分就是真实品相，错版公开认定；假卡拒评。
import { APPRAISAL, ERRATA, GRADES, type Grade } from '@kanu/shared/balance';
import { rollSubgrades } from './cards.ts';
import { chance, type Rng } from './rng.ts';

const isFake = (a: string) => a === 'low_fake' || a === 'high_fake';

/** 开包时这张卡是不是错版（隐藏属性） */
export const rollErrata = (rng: Rng): boolean => chance(rng, ERRATA.ppm);

const ORDER = GRADES.map(String);

/** 放大镜估品相：缩到相邻两档（如 "8–9"），真实分随机落在上档或下档；黑标和 10 分是 "10–黑标" */
export function loupeGrade(rng: Rng, grade: string): [string, string] {
  const i = ORDER.indexOf(grade);
  const lowFirst = i === 0 ? true : i === ORDER.length - 1 ? false : rng.int(2) === 0;
  const lo = lowFirst ? i : i - 1;
  return [ORDER[lo]!, ORDER[lo + 1]!];
}

/** 放大镜查验的结论（只给主人看）。looks：fake 看出是假的 / looks_real 看起来是真的（漏看也这么说） */
export interface Inspection {
  looks: 'fake' | 'looks_real';
  gradeRange: [string, string];
  /** 认出是错版（错版没认出来、或者不是错版，都是 false） */
  errataFound: boolean;
}

/** 放大镜查验：对假卡也照样估品相、找错版，估品相本身不暴露真假 */
/** errataDetectPpm：放大镜认出错版的概率（科技树 A1 好放大镜会提高） */
export function inspect(rng: Rng, card: { authenticity: string; grade: string; misprint: boolean }, errataDetectPpm: number = APPRAISAL.errataDetect): Inspection {
  const looks = isFake(card.authenticity) && chance(rng, APPRAISAL.loupeDetect[card.authenticity as 'low_fake' | 'high_fake']) ? 'fake' : 'looks_real';
  const gradeRange = loupeGrade(rng, card.grade);
  const errataFound = card.misprint && chance(rng, errataDetectPpm);
  return { looks, gradeRange, errataFound };
}

/** 送评：真卡封壳，分数就是真实品相（不再随机），四个分项展示用；错版公开认定。假卡拒评 */
export interface Slab { score: string; subgrades: { centering: number; corners: number; edges: number; surface: number }; errata: boolean }
export type GradingResult = { kind: 'slab'; slab: Slab } | { kind: 'rejected' };

export function gradeCard(rng: Rng, card: { authenticity: string; grade: string; misprint: boolean }): GradingResult {
  if (isFake(card.authenticity)) return { kind: 'rejected' };
  const g: Grade = card.grade === 'BL' ? 'BL' : (Number(card.grade) as Grade);
  const [centering, corners, edges, surface] = rollSubgrades(rng, g);
  return { kind: 'slab', slab: { score: card.grade, subgrades: { centering, corners, edges, surface }, errata: card.misprint } };
}

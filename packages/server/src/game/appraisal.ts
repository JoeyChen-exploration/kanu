// 鉴定（DESIGN 5，SRS FR-APPR-1～5）。纯函数：随机从 rng 来，卡的隐藏属性由调用方传进来。
// 两条独立的线：真伪鉴定（肉眼、放大镜、鉴定机构）和品相评级（肉眼估、放大镜估、送评）。
// 一条线的结果不能泄露另一条线的属性：估品相对假卡也照样出一个数，看真伪不提品相。
import { APPRAISAL, GRADES, type Grade } from '@kanu/shared/balance';
import { chance, type Rng } from './rng.ts';

export type Authenticity = 'real' | 'low_fake' | 'high_fake';

/** 肉眼 / 放大镜看真伪的结论：看出是假的，或者"看起来是真的"（漏看时也这么说，FR-APPR-2） */
export type AuthLook = 'fake' | 'looks_real';

const isFake = (a: string) => a === 'low_fake' || a === 'high_fake';

/** 肉眼看真伪：只能看出一部分低仿 */
export function eyeAuth(rng: Rng, authenticity: string): AuthLook {
  if (!isFake(authenticity)) return 'looks_real';
  return chance(rng, APPRAISAL.eyeDetect[authenticity as 'low_fake' | 'high_fake']) ? 'fake' : 'looks_real';
}

/** 放大镜看真伪：低仿 95%、高仿 60% 识破，漏看时说"看起来是真的" */
export function loupeAuth(rng: Rng, authenticity: string): AuthLook {
  if (!isFake(authenticity)) return 'looks_real';
  return chance(rng, APPRAISAL.loupeDetect[authenticity as 'low_fake' | 'high_fake']) ? 'fake' : 'looks_real';
}

/** 鉴定机构：100% 准。假卡告诉玩家；真卡查失窃登记表，赃物当场没收；干净的真卡拿到公开的"已验真" */
export type LabVerdict = 'verified' | 'fake' | 'stolen';
export function labVerdict(authenticity: string, origin: string): LabVerdict {
  if (isFake(authenticity)) return 'fake';
  return origin === 'stolen' ? 'stolen' : 'verified';
}

const ORDER = GRADES.map(String);
const idx = (g: string) => ORDER.indexOf(g);

/** 肉眼估品相：只给大致范围（差 1–3 / 中 4–6 / 好 7–10，黑标算好） */
export type EyeBand = 'low' | 'mid' | 'high';
export function eyeGrade(grade: string): EyeBand {
  const i = idx(grade);
  if (i <= idx('3')) return 'low';
  if (i <= idx('6')) return 'mid';
  return 'high';
}

/** 放大镜估品相：缩到相邻两档（如 "8–9"），真实分随机落在上档或下档；黑标和 10 分是 "10–黑标" */
export function loupeGrade(rng: Rng, grade: string): [string, string] {
  const i = idx(grade);
  const lowFirst = i === 0 ? true : i === ORDER.length - 1 ? false : rng.int(2) === 0;
  const lo = lowFirst ? i : i - 1;
  return [ORDER[lo]!, ORDER[lo + 1]!];
}

/** 送评：真卡封壳，评分就是真实品相（不再随机），四个分项围着总分上下浮动；黑标四项全 10。假卡拒评 */
export const SUBGRADES = ['centering', 'corners', 'edges', 'surface'] as const;
export type Slab = { score: string; subgrades: Record<(typeof SUBGRADES)[number], number> };
export type GradingResult = { kind: 'slab'; slab: Slab } | { kind: 'rejected' };

export function gradeCard(rng: Rng, authenticity: string, grade: string): GradingResult {
  if (isFake(authenticity)) return { kind: 'rejected' };
  if (grade === 'BL') return { kind: 'slab', slab: { score: 'BL', subgrades: { centering: 10, corners: 10, edges: 10, surface: 10 } } };
  const n = Number(grade);
  const sub = () => Math.max(1, Math.min(10, n + rng.int(3) - 1));
  const subgrades = { centering: sub(), corners: sub(), edges: sub(), surface: sub() };
  // 10 分不能四项全 10（那是黑标）
  if (n === 10 && Object.values(subgrades).every((x) => x === 10)) subgrades.surface = 9;
  return { kind: 'slab', slab: { score: grade, subgrades } };
}

/** 评分是不是一种合法的品相 */
export const isGrade = (g: string): g is `${Grade}` => ORDER.includes(g);

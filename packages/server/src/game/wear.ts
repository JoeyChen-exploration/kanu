// 散放磨损（DESIGN 4.5）：纯函数。品相是隐藏属性，磨损只在服务器里改，玩家看到的只是"散放了几天"。
import { LOOSE, type Grade } from '@kanu/shared/balance';
import { chance, type Rng } from './rng.ts';

/** 品相掉 1 分：黑标 → 10，n → n − 1，最低 1 */
export function gradeDown(grade: string): string {
  if (grade === 'BL') return '10';
  const n = Number(grade);
  return String(Math.max(1, n - 1));
}

/** 过一个营业日：按 LOOSE.wearPpm 的概率掉 1 分；返回新的品相（没变就原样返回） */
export function wearOnce(rng: Rng, grade: string): string {
  return chance(rng, LOOSE.wearPpm) ? gradeDown(grade) : grade;
}

export type { Grade };

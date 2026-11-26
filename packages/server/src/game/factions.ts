// 派系（DESIGN 8.4）：纯函数。关系值、等级、加减、治安对巡查和便衣的影响。
import { FACTIONS, type FactionId } from '@kanu/shared/balance';

export type FactionValues = Record<FactionId | 'police', number>;
export type Tier = 'hostile' | 'stranger' | 'known' | 'ally';
export const TIER_NAMES: Record<Tier, string> = { hostile: '敌对', stranger: '陌生', known: '熟脸', ally: '盟友' };

export function tierOf(value: number): Tier {
  if (value >= FACTIONS.allyMin) return 'ally';
  if (value >= FACTIONS.knownMin) return 'known';
  if (value <= FACTIONS.hostileMax) return 'hostile';
  return 'stranger';
}

const clamp = (v: number) => Math.max(FACTIONS.min, Math.min(FACTIONS.max, v));

/** 按 FACTIONS.deltas[kind] × times 加减（夹在 min～max） */
export function applyFaction(values: FactionValues, kind: keyof typeof FACTIONS.deltas, times = 1): FactionValues {
  const d = FACTIONS.deltas[kind] ?? {};
  const out = { ...values };
  for (const k of Object.keys(d) as Array<FactionId | 'police'>) out[k] = clamp(out[k] + (d[k] ?? 0) * times);
  return out;
}

/** 治安关系对巡查和便衣出现频率的倍数：最差 1 + span，最好 1 − span */
export const policeMult = (police: number) => 1 - (clamp(police) / FACTIONS.max) * FACTIONS.policeSpan;

// 派系（DESIGN 8.4）的读写：关系值存在 players.rep_*，每次变动写 events_log。只能在事务里调用。
// rep_police 是隐藏的治安关系：只写日志，绝不放进给玩家的响应。
import { FACTIONS } from '@kanu/shared/balance';
import type { Repo } from './db/index.ts';
import { applyFaction, policeMult, type FactionValues } from './game/factions.ts';

export function factionValues(repo: Repo, userId: string): FactionValues {
  const p = repo.getPlayer(userId)!;
  return { guild: p.rep_guild, black: p.rep_black, collectors: p.rep_collectors, police: p.rep_police };
}

/** 按 FACTIONS.deltas[kind] 加减 times 次；day 记进日志（每天上限按它数） */
export function bumpFaction(repo: Repo, userId: string, kind: keyof typeof FACTIONS.deltas, now: number, day: number, times = 1, extra: Record<string, unknown> = {}) {
  if (times <= 0) return;
  const before = factionValues(repo, userId);
  const after = applyFaction(before, kind, times);
  repo.setFactions(userId, after);
  repo.logEvent(userId, now, `faction_${kind}`, { day, times, before, after, ...extra });
}

/** 正规商会盟友：电脑订货打折、多买几包 */
export const guildAlly = (repo: Repo, userId: string) => factionValues(repo, userId).guild >= FACTIONS.allyMin;

/** 治安关系对巡查、便衣频率的倍数 */
export const policeMultOf = (repo: Repo, userId: string) => policeMult(factionValues(repo, userId).police);

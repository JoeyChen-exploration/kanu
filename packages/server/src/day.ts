// 打烊结算（FR-CTR-2、FR-RENT-1～3）：打烊、欠租交上后、破产重开后都走这一步。只能在事务里调用。
// 顺序：桌面散卡磨损 → 进入下一天 → 过了赎回期的抵押卡归房东 → 评级社出结果 → 黑市追杀（DESIGN 8.4）→ 巡查（DESIGN 8.3）。
import type { AppraisalOutcome, PatrolView, RentStatus } from '@kanu/shared/types';
import { FACTIONS, PLAYER, POLICE, RENT, REPUTATION, SHOP_PRICE } from '@kanu/shared/balance';
import { chance } from './game/rng.ts';
import { vendettaOf, type Vendetta } from './game/factions.ts';
import { techEffects } from './game/tech.ts';
import { runDay } from './game/rent.ts';
import { bribeCost, rollPatrol, withDetect } from './game/police.ts';
import { factionValues, policeMultOf } from './factions.ts';
import type { Deps } from './app.ts';
import { nextRent } from './game/rent.ts';
import { settleAppraisals } from './routes/appraisal.ts';

export function finishDay(deps: Deps, userId: string, now: number, extra: Record<string, unknown> = {}): { day: number; appraisals: AppraisalOutcome[]; forfeited: number; patrol: PatrolView | null; patrolClean: boolean; vendetta: Vendetta | 'hit' | null } {
  const { repo } = deps;
  const player = repo.getPlayer(userId)!;
  const tech = techEffects(repo.techOwned(userId));
  // 科技树 S2 装修：每 7 个营业日（这一轮第 7、14……天打烊时）信誉 +weeklyRep，涨到 weeklyRepCap 为止
  if (tech.weeklyRep && runDay(player.game_day, player.run_start_day) % RENT.everyDays === 0 && player.reputation < tech.weeklyRepCap) {
    const rep = Math.min(tech.weeklyRepCap, REPUTATION.max, player.reputation + tech.weeklyRep);
    repo.setCreditsReputation(userId, player.credits, rep);
    repo.logEvent(userId, now, 'weekly_rep', { day: player.game_day, from: player.reputation, to: rep });
  }
  const worn = deps.binders!.wear(userId);
  repo.advanceDay(userId);
  const day = player.game_day + 1;
  // 抵押超过赎回期（due_day 那天打烊后）：卡归房东，从玩家这里删掉
  let forfeited = 0;
  for (const p of repo.activePawns(userId)) {
    if (p.due_day < day) {
      repo.setPawnStatus(p.id, 'forfeited');
      repo.deleteCard(p.card_id);
      forfeited += 1;
    }
  }
  repo.logEvent(userId, now, 'day_end', { day: player.game_day, worn, forfeited, ...extra });
  const appraisals = settleAppraisals(deps, userId, day, now);
  // 黑市追杀（DESIGN 8.4）：关系到底以后每次打烊掷一次，被"清理"等同破产（珍藏柜保留）。破产重开那次不算
  let vendetta: Vendetta | 'hit' | null = extra.bankrupt ? null : vendettaOf(repo.getPlayer(userId)!.rep_black);
  if (vendetta === 'hunted' && chance(deps.rng, FACTIONS.vendetta.hitPpm)) {
    const before = repo.getPlayer(userId)!;
    const wiped = repo.wipeForRestart(userId);
    repo.restartRun(userId, PLAYER.restartCredits, day);
    repo.setFactions(userId, { ...factionValues(repo, userId), black: FACTIONS.vendetta.afterHit });
    repo.logCredits(userId, now, PLAYER.restartCredits - before.credits, 'black_hit', PLAYER.restartCredits, { ...wiped });
    repo.logEvent(userId, now, 'black_hit', { day, ...wiped, owned: before.shop_owned === 1, blackAfter: FACTIONS.vendetta.afterHit });
    vendetta = 'hit';
  }
  // 巡查：每次打烊都掷一次（不管有没有赃卡，免得"来没来巡查"本身泄露你手上有没有赃物）
  let patrol: PatrolView | null = null;
  let patrolClean = false;
  if (vendetta !== 'hit' && !repo.pendingPatrol(userId)) {
    // 藏匿室（S3b / S4b）里的赃卡按低查出率算；正经店（S3a）巡查来得少
    const stolen = withDetect(repo.stolenCards(userId), tech.hideoutDetectPpm);
    // 隐藏的治安关系（DESIGN 8.4）也乘进去
    const found = rollPatrol(deps.rng, stolen, tech.patrolMult * policeMultOf(repo, userId) * repo.newsEffects().policeMult);
    if (found && found.length) {
      const bribe = bribeCost(found.map((id) => repo.cardView(id)?.price ?? 0));
      const id = repo.insertPatrol({ ownerId: userId, day, cards: found, bribe, now });
      repo.logEvent(userId, now, 'patrol_found', { patrol: id, cards: found, bribe });
      patrol = patrolView(deps, userId);
    } else if (found) {
      patrolClean = true;
      repo.logEvent(userId, now, 'patrol_clean', { day });
    }
  }
  return { day, appraisals, forfeited, patrol, patrolClean, vendetta };
}

/** 等处理的巡查（查出的赃卡只给公开信息） */
export function patrolView(deps: Deps, userId: string): PatrolView | null {
  const p = deps.repo.pendingPatrol(userId);
  if (!p) return null;
  const cards = (JSON.parse(p.cards) as number[]).flatMap((id) => { const c = deps.repo.cardView(id); return c ? [c] : []; });
  return { id: p.id, cards, bribe: p.bribe, surrenderRepLoss: patrolWaived(deps, userId, p.day) ? 0 : POLICE.surrenderRepLoss };
}

/** 科技树 S4a 治安备案：这次巡查所在的那一周（这一轮第 1–7、8–14……天）还没用过免扣信誉，就免 */
export function patrolWaived(deps: Deps, userId: string, patrolDay: number): boolean {
  const { repo } = deps;
  if (!techEffects(repo.techOwned(userId)).patrolWaiver) return false;
  const p = repo.getPlayer(userId)!;
  const week = Math.ceil(runDay(patrolDay, p.run_start_day) / RENT.everyDays);
  const from = p.run_start_day + (week - 1) * RENT.everyDays;
  return repo.countEventsInDays(userId, 'patrol_waived', from, from + RENT.everyDays - 1) === 0;
}

/** 房租状态：欠租、下次交租（FR-RENT-6） */
export function rentStatus(deps: Deps, userId: string): RentStatus {
  const p = deps.repo.getPlayer(userId)!;
  const owned = p.shop_owned === 1;
  return {
    owned,
    arrears: p.rent_due > 0 ? { amount: p.rent_due, week: p.rent_week } : null,
    next: owned ? null : nextRent(p.game_day, p.run_start_day),
    shopPrice: SHOP_PRICE,
  };
}

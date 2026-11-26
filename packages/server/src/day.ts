// 打烊结算（FR-CTR-2、FR-RENT-1～3）：打烊、欠租交上后、破产重开后都走这一步。只能在事务里调用。
// 顺序：桌面散卡磨损 → 进入下一天 → 过了赎回期的抵押卡归房东 → 评级社出结果 → 巡查（DESIGN 8.3）。
import type { AppraisalOutcome, PatrolView, RentStatus } from '@kanu/shared/types';
import { POLICE, SHOP_PRICE } from '@kanu/shared/balance';
import { bribeCost, rollPatrol } from './game/police.ts';
import type { Deps } from './app.ts';
import { nextRent } from './game/rent.ts';
import { settleAppraisals } from './routes/appraisal.ts';

export function finishDay(deps: Deps, userId: string, now: number, extra: Record<string, unknown> = {}): { day: number; appraisals: AppraisalOutcome[]; forfeited: number; patrol: PatrolView | null; patrolClean: boolean } {
  const { repo } = deps;
  const player = repo.getPlayer(userId)!;
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
  // 巡查：每次打烊都掷一次（不管有没有赃卡，免得"来没来巡查"本身泄露你手上有没有赃物）
  let patrol: PatrolView | null = null;
  let patrolClean = false;
  if (!repo.pendingPatrol(userId)) {
    const found = rollPatrol(deps.rng, repo.stolenCards(userId));
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
  return { day, appraisals, forfeited, patrol, patrolClean };
}

/** 等处理的巡查（查出的赃卡只给公开信息） */
export function patrolView(deps: Deps, userId: string): PatrolView | null {
  const p = deps.repo.pendingPatrol(userId);
  if (!p) return null;
  const cards = (JSON.parse(p.cards) as number[]).flatMap((id) => { const c = deps.repo.cardView(id); return c ? [c] : []; });
  return { id: p.id, cards, bribe: p.bribe, surrenderRepLoss: POLICE.surrenderRepLoss };
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

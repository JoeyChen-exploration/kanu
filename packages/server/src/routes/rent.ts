// 房租、抵押、破产、买店（DESIGN 7，FR-RENT-2～6）。写操作都要幂等 key，信用点和卡的变动在一个事务里，写 events_log。
//   GET  /api/rent                 房租状态、抵押中的卡、能抵押的卡（珍藏柜、送评中的不能抵押）
//   POST /api/rent/pawn {cardId}   抵押一张：按市场价 50% 拿钱，7 个营业日内按 60% 赎回
//   POST /api/rent/pawn-all        欠租时一键抵押：从市场价最低的开始，凑够欠的租就停
//   POST /api/rent/redeem/:id      赎回
//   POST /api/rent/pay             欠租时交租：交上就进入下一天
//   POST /api/rent/bankrupt {confirm: true}  从头开始：只留珍藏柜的卡，用 1,200 信用点重开
//   POST /api/shop/buy             买下店铺，不再交租
import type { FastifyInstance } from 'fastify';
import { PAWN, PLAYER, SHOP_PRICE } from '@kanu/shared/balance';
import type { CardView, PawnView, RentActionResponse, RentResponse } from '@kanu/shared/types';
import { ApiError, fail, idempotencyKey, type Deps } from '../app.ts';
import { autoPawnPlan, pawnQuote } from '../game/rent.ts';
import { finishDay, rentStatus } from '../day.ts';

export function registerRentRoutes(app: FastifyInstance, deps: Deps, now: () => number) {
  const { repo } = deps;

  /** 能抵押的卡：在库存里（卡册或桌面），珍藏柜和送评中的不行；市场价 0 的不收 */
  const pawnable = (ownerId: string): CardView[] =>
    repo.sellableCards(ownerId).filter((c) => c.location === 'inventory' && pawnQuote(c.price).loan > 0);

  const pawnViews = (ownerId: string): PawnView[] => {
    const cards = new Map(repo.pawnedCards(ownerId).map((c) => [c.id, c]));
    return repo.activePawns(ownerId).flatMap((p) => {
      const card = cards.get(p.card_id);
      return card ? [{ id: p.id, card, loan: p.loan, redeem: p.redeem, dueDay: p.due_day }] : [];
    });
  };

  const action = (ownerId: string, extra: Partial<RentActionResponse> = {}): RentActionResponse =>
    ({ ok: true, credits: repo.getPlayer(ownerId)!.credits, rent: rentStatus(deps, ownerId), ...extra });

  /** 幂等写操作的公共外壳 */
  const write = <T>(req: { user?: { id: string } | null; headers: Record<string, unknown> }, reply: Parameters<typeof fail>[0], fn: (userId: string, t: number) => T) => {
    if (!req.user) return fail(reply, 401, 'unauthorized', '请重新打开卡奴登录');
    const key = idempotencyKey(req as never);
    if (!key) return fail(reply, 400, 'missing_idempotency_key', '请求缺少幂等 key，请刷新后再试');
    const userId = req.user.id;
    return repo.db.transaction((): T => {
      const replay = repo.getIdempotent<T>(userId, key);
      if (replay) return replay;
      const t = now();
      if (!repo.getPlayer(userId)) throw new ApiError(401, 'unauthorized', '请重新打开卡奴登录');
      const response = fn(userId, t);
      repo.putIdempotent(userId, key, response, t);
      return response;
    })();
  };

  /** 抵押一张卡（事务内） */
  const pawnOne = (userId: string, card: CardView, t: number) => {
    const player = repo.getPlayer(userId)!;
    const { loan, redeem } = pawnQuote(card.price);
    repo.setLocation(card.id, 'pawned');
    repo.placeCard(card.id, null, null);
    repo.insertPawn({ ownerId: userId, cardId: card.id, loan, redeem, day: player.game_day, dueDay: player.game_day + PAWN.days, now: t });
    const credits = player.credits + loan;
    repo.setCreditsPity(userId, credits, player.pity_count);
    repo.logCredits(userId, t, loan, 'pawn', credits, { card: card.id, redeem });
    return loan;
  };

  app.get('/api/rent', async (req, reply) => {
    if (!req.user) return fail(reply, 401, 'unauthorized', '请重新打开卡奴登录');
    const userId = req.user.id;
    const player = repo.getPlayer(userId);
    if (!player) return fail(reply, 401, 'unauthorized', '请重新打开卡奴登录');
    const response: RentResponse = {
      ok: true, credits: player.credits, day: player.game_day, rent: rentStatus(deps, userId), pawns: pawnViews(userId),
      pawnable: pawnable(userId).sort((a, b) => a.price - b.price || a.id - b.id).map((card) => ({ card, ...pawnQuote(card.price) })),
    };
    return response;
  });

  app.post<{ Body: { cardId?: number } }>('/api/rent/pawn', async (req, reply) => write(req, reply, (userId, t) => {
    const card = pawnable(userId).find((c) => c.id === req.body?.cardId);
    if (!card) throw new ApiError(400, 'not_pawnable', '这张卡不能抵押（珍藏柜、送评中的卡不收）');
    pawnOne(userId, card, t);
    return action(userId, { cards: [card] });
  }));

  app.post('/api/rent/pawn-all', async (req, reply) => write(req, reply, (userId, t) => {
    const player = repo.getPlayer(userId)!;
    if (player.rent_due <= 0) throw new ApiError(400, 'no_arrears', '现在没有欠租');
    const need = player.rent_due - player.credits;
    if (need <= 0) throw new ApiError(400, 'enough', '钱已经够交租了，直接交租就行');
    const plan = autoPawnPlan(pawnable(userId), need);
    for (const c of plan.picks) pawnOne(userId, c, t);
    repo.logEvent(userId, t, 'pawn_all', { cards: plan.picks.length, total: plan.total, need });
    return action(userId, { cards: plan.picks, notEnough: !plan.enough });
  }));

  app.post<{ Params: { id: string } }>('/api/rent/redeem/:id', async (req, reply) => write(req, reply, (userId, t) => {
    const player = repo.getPlayer(userId)!;
    const pawn = repo.getPawn(userId, Number.parseInt(req.params.id, 10));
    if (!pawn || pawn.status !== 'active') throw new ApiError(404, 'not_found', '找不到这笔抵押（可能已经过期归房东了）');
    if (player.credits < pawn.redeem) throw new ApiError(400, 'insufficient_credits', `信用点不够：赎回要 ${pawn.redeem}，你有 ${player.credits}`);
    if (deps.binders!.space(userId).total < 1) throw new ApiError(400, 'no_space', '卡册和桌面都满了，先腾个位置再赎回');
    const credits = player.credits - pawn.redeem;
    repo.setCreditsPity(userId, credits, player.pity_count);
    repo.setPawnStatus(pawn.id, 'redeemed');
    repo.setLocation(pawn.card_id, 'inventory');
    deps.binders!.placeNew(userId, [pawn.card_id], player.game_day);
    repo.logCredits(userId, t, -pawn.redeem, 'redeem', credits, { card: pawn.card_id, pawn: pawn.id });
    const card = repo.sellableCards(userId).find((c) => c.id === pawn.card_id);
    return action(userId, { cards: card ? [card] : [] });
  }));

  app.post('/api/rent/pay', async (req, reply) => write(req, reply, (userId, t) => {
    const player = repo.getPlayer(userId)!;
    if (player.rent_due <= 0) throw new ApiError(400, 'no_arrears', '现在没有欠租');
    if (player.credits < player.rent_due) throw new ApiError(400, 'insufficient_credits', `还差 ${player.rent_due - player.credits} 信用点，先抵押几张卡`);
    const credits = player.credits - player.rent_due;
    repo.setCreditsPity(userId, credits, player.pity_count);
    repo.logCredits(userId, t, -player.rent_due, 'rent', credits, { week: player.rent_week, late: true });
    repo.setArrears(userId, 0, 0);
    const { day } = finishDay(deps, userId, t, { rentPaid: player.rent_due, week: player.rent_week });
    return action(userId, { day });
  }));

  app.post<{ Body: { confirm?: boolean } }>('/api/rent/bankrupt', async (req, reply) => write(req, reply, (userId, t) => {
    if (req.body?.confirm !== true) throw new ApiError(400, 'confirm', '从头开始要确认：珍藏柜以外的卡、信用点、店铺都会清空');
    const player = repo.getPlayer(userId)!;
    const wiped = repo.wipeForRestart(userId);
    // 欠租时（交租日打烊卡住了）：顺便把这一天结束，新一轮从明天开始；平时主动申请：今天就是新一轮第 1 天
    let day = player.game_day;
    if (player.rent_due > 0) {
      repo.setArrears(userId, 0, 0);
      day = finishDay(deps, userId, t, { bankrupt: true }).day;
    }
    repo.restartRun(userId, PLAYER.restartCredits, day);
    repo.logCredits(userId, t, PLAYER.restartCredits - player.credits, 'bankrupt', PLAYER.restartCredits, { ...wiped, arrears: player.rent_due });
    repo.logEvent(userId, t, 'bankrupt', { day, ...wiped, owned: player.shop_owned === 1 });
    return action(userId, { day });
  }));

  app.post('/api/shop/buy', async (req, reply) => write(req, reply, (userId, t) => {
    const player = repo.getPlayer(userId)!;
    if (player.shop_owned === 1) throw new ApiError(400, 'owned', '店铺已经是你的了');
    if (player.rent_due > 0) throw new ApiError(400, 'arrears', '先把欠的摊位费交了');
    const free = deps.config.devUnlimitedIds.has(userId);
    const cost = free ? 0 : SHOP_PRICE;
    if (player.credits < cost) throw new ApiError(400, 'insufficient_credits', `信用点不够：要 ${SHOP_PRICE}，你有 ${player.credits}`);
    const credits = player.credits - cost;
    repo.setCreditsPity(userId, credits, player.pity_count);
    repo.setShopOwned(userId, true);
    repo.logCredits(userId, t, -cost, free ? 'shop_test_free' : 'shop', credits, {});
    repo.logEvent(userId, t, 'shop_buy', { day: player.game_day });
    return action(userId);
  }));
}

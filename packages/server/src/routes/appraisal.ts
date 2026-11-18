// 鉴定（M3，DESIGN 5，2026-11-17 用户重定）：
//   GET  /api/cards/:id/appraisal   一张卡的放大镜结论、送评状态、送评费
//   POST /api/cards/:id/inspect     放大镜查验（柜台上的道具，拖到卡上）：免费，每张卡只查一次，结论存库不再变；
//                                   重复请求返回同一个结论（设成目标状态，不需要幂等 key）
//   GET  /api/phone                 电话：买了没有、价格、在评级社的卡
//   POST /api/phone/buy             买电话（要幂等 key）
//   POST /api/cards/:id/grade       打电话给星港评级社送评（要电话、要幂等 key、扣费）：卡送走不能卖，下次打烊出结果
// 结论只给主人看；卡价只看封壳后公开的评分和错版（FR-APPR-5）。
import { techEffects } from '../game/tech.ts';
import type { FastifyInstance } from 'fastify';
import { APPRAISAL, PACKS, PHONE, WHOLESALE, type PackType, type Rarity, type Style } from '@kanu/shared/balance';
import type {
  AppraisalOutcome, BuyPhoneResponse, CardAppraisalResponse, CardView, GradeBatchResponse, GradeResponse, InspectionView, PhoneResponse,
  WholesaleResponse,
} from '@kanu/shared/types';
import { ApiError, fail, idempotencyKey, type Deps } from '../app.ts';
import { gradeCard, inspect } from '../game/appraisal.ts';
import { gradingFee } from '../game/price.ts';

/** 这张卡的鉴定状态（只给主人） */
export function appraisalOf(repo: Deps['repo'], card: CardView): CardAppraisalResponse {
  const a = repo.appraisalsOf(card.id);
  const inspection = (a.get('inspect') as InspectionView | undefined) ?? null;
  const grading = (a.get('grading') as CardAppraisalResponse['grading'] | undefined) ?? null;
  const here = card.location === 'inventory' || card.location === 'showcase';
  return {
    ok: true, card, inspection, grading,
    gradingFee: gradingFee(card.rarity as Rarity, card.style as Style),
    canInspect: here && inspection === null,
    canGrade: here && !card.slab && !card.gradeRejected && grading === null,
  };
}

/**
 * 打烊时评级社出结果（FR-APPR-4）：真卡封壳（评分、分项、错版公开，点亮图鉴）；假卡拒评、打公开标记、扣信誉。
 * 回来的卡放回卡册或桌面。只能在事务里调用。
 */
export function settleAppraisals(deps: Deps, ownerId: string, day: number, now: number): AppraisalOutcome[] {
  const { repo } = deps;
  const out: AppraisalOutcome[] = [];
  for (const inst of repo.dueGrading(ownerId, day)) {
    const name = repo.cardView(inst.id)!.name;
    const r = gradeCard(deps.rng, { authenticity: inst.authenticity, grade: inst.grade, misprint: inst.misprint === 1 });
    if (r.kind === 'slab') {
      repo.setAppraisal(inst.id, 'grading', 'slab');
      repo.backFromGrading(inst.id, { slab: r.slab });
      repo.markCollected(ownerId, inst.template_id, inst.style, now);
      out.push({ cardId: inst.id, name, outcome: 'slab', score: r.slab.score, errata: r.slab.errata });
    } else {
      // 假卡拒评：不封壳、费用不退、打公开的拒评标记、扣信誉（DESIGN 5.2）
      repo.setAppraisal(inst.id, 'grading', 'rejected');
      repo.backFromGrading(inst.id, { rejected: true });
      const p = repo.getPlayer(ownerId)!;
      repo.setCreditsReputation(ownerId, p.credits, Math.max(0, p.reputation - APPRAISAL.gradeRejectRepLoss));
      out.push({ cardId: inst.id, name, outcome: 'rejected', score: null, errata: false });
    }
    deps.binders!.placeNew(ownerId, [inst.id], day);
    repo.logEvent(ownerId, now, 'grading_result', { card: inst.id, outcome: r.kind });
  }
  return out;
}

export function registerAppraisalRoutes(app: FastifyInstance, deps: Deps, now: () => number) {
  const { repo, rng } = deps;

  const ownCard = (ownerId: string, id: number) => {
    const inst = repo.ownedInstance(ownerId, id);
    if (!inst) throw new ApiError(404, 'not_found', '找不到这张卡');
    return { inst, card: repo.cardView(id)! };
  };

  app.get<{ Params: { id: string } }>('/api/cards/:id/appraisal', async (req, reply) => {
    if (!req.user) return fail(reply, 401, 'unauthorized', '请重新打开卡奴登录');
    const { card } = ownCard(req.user.id, Number.parseInt(req.params.id, 10));
    return appraisalOf(repo, card) satisfies CardAppraisalResponse;
  });

  app.post<{ Params: { id: string } }>('/api/cards/:id/inspect', async (req, reply) => {
    if (!req.user) return fail(reply, 401, 'unauthorized', '请重新打开卡奴登录');
    const userId = req.user.id;
    const cardId = Number.parseInt(req.params.id, 10);
    return repo.db.transaction((): CardAppraisalResponse => {
      const { inst, card } = ownCard(userId, cardId);
      const before = appraisalOf(repo, card);
      if (before.inspection) return before; // 只查一次：再拖上去还是同一个结论
      if (!before.canInspect) throw new ApiError(400, 'cannot_inspect', '这张卡在评级社，等它回来再看');
      const result = inspect(rng, { authenticity: inst.authenticity, grade: inst.grade, misprint: inst.misprint === 1 }, techEffects(repo.techOwned(userId)).errataDetectPpm);
      repo.putAppraisal(card.id, 'inspect', result, now());
      repo.logEvent(userId, now(), 'inspect', { card: card.id });
      return appraisalOf(repo, card);
    })();
  });

  app.get('/api/phone', async (req, reply) => {
    if (!req.user) return fail(reply, 401, 'unauthorized', '请重新打开卡奴登录');
    const player = repo.getPlayer(req.user.id);
    if (!player) return fail(reply, 401, 'unauthorized', '请重新打开卡奴登录');
    return {
      ok: true, owned: player.phone === 1, price: PHONE.price, day: player.game_day, grading: repo.gradingCards(req.user.id),
      wholesale: {
        leftToday: deps.config.devUnlimitedIds.has(req.user.id) ? WHOLESALE.perDay : Math.max(0, WHOLESALE.perDay - repo.wholesaleToday(req.user.id, player.game_day)),
        offers: wholesaleOffers(req.user.id),
        pending: pendingView(req.user.id),
      },
    } satisfies PhoneResponse;
  });

  const pendingView = (ownerId: string) => {
    const o = repo.pendingOrder(ownerId);
    return o ? { orderId: o.id, seriesName: o.series_name, packs: o.packs, price: o.price, arriveDay: o.ordered_day + WHOLESALE.deliveryDays } : null;
  };

  /** 批发商的报价：每种卡包一盒（DESIGN 4） */
  const wholesaleOffers = (ownerId: string) => repo.allSeries().map((s) => {
    const normal = PACKS[s.kind as PackType].price;
    const discount = techEffects(repo.techOwned(ownerId)).wholesaleDiscount;
    return { seriesId: s.id, name: s.name, kind: s.kind, packs: WHOLESALE.boxPacks, normalPrice: normal * WHOLESALE.boxPacks, boxPrice: Math.round(normal * discount) * WHOLESALE.boxPacks };
  });

  // 电话批发（DESIGN 4）：打给批发商订一盒。2026-11-18 用户定：只下单不扣钱，送货员作为下一位顾客来柜台，
  // 货到付款（counter.ts 的 /receive），拒收就取消。每个营业日 WHOLESALE.perDay 次；同时只能有一张没送到的订单
  app.post<{ Body: { seriesId?: unknown } }>('/api/phone/wholesale', async (req, reply) => {
    if (!req.user) return fail(reply, 401, 'unauthorized', '请重新打开卡奴登录');
    const key = idempotencyKey(req);
    if (!key) return fail(reply, 400, 'missing_idempotency_key', '请求缺少幂等 key，请刷新后再试');
    const userId = req.user.id;
    const seriesId = String(req.body?.seriesId ?? '');
    return repo.db.transaction((): WholesaleResponse => {
      const replay = repo.getIdempotent<WholesaleResponse>(userId, key);
      if (replay) return replay;
      const t = now();
      const player = repo.getPlayer(userId);
      if (!player) throw new ApiError(401, 'unauthorized', '请重新打开卡奴登录');
      if (player.phone !== 1) throw new ApiError(400, 'no_phone', '还没有电话，先买一部电话才能打给批发商');
      const offer = wholesaleOffers(userId).find((o) => o.seriesId === seriesId);
      if (!offer) throw new ApiError(400, 'bad_series', '批发商没有这种卡包');
      const free = deps.config.devUnlimitedIds.has(userId);
      if (!free && repo.wholesaleToday(userId, player.game_day) >= WHOLESALE.perDay) {
        throw new ApiError(400, 'wholesale_limit', '今天已经订过一盒了，打烊后明天再打');
      }
      if (repo.pendingOrder(userId)) throw new ApiError(400, 'order_pending', '上一盒还没送到，等送货员来了再订');
      const orderId = repo.insertOrder({ ownerId: userId, seriesId, packs: offer.packs, price: offer.boxPrice, day: player.game_day, now: t });
      repo.logEvent(userId, t, 'wholesale_order', { day: player.game_day, order: orderId, seriesId, price: offer.boxPrice });
      const response: WholesaleResponse = { ok: true, order: { orderId, seriesId, seriesName: offer.name, packs: offer.packs, price: offer.boxPrice } };
      repo.putIdempotent(userId, key, response, t);
      return response;
    })();
  });

  app.post('/api/phone/buy', async (req, reply) => {
    if (!req.user) return fail(reply, 401, 'unauthorized', '请重新打开卡奴登录');
    const key = idempotencyKey(req);
    if (!key) return fail(reply, 400, 'missing_idempotency_key', '请求缺少幂等 key，请刷新后再试');
    const userId = req.user.id;
    return repo.db.transaction((): BuyPhoneResponse => {
      const replay = repo.getIdempotent<BuyPhoneResponse>(userId, key);
      if (replay) return replay;
      const t = now();
      const player = repo.getPlayer(userId);
      if (!player) throw new ApiError(401, 'unauthorized', '请重新打开卡奴登录');
      if (player.phone === 1) throw new ApiError(400, 'owned', '已经有电话了');
      const free = deps.config.devUnlimitedIds.has(userId);
      const cost = free ? 0 : PHONE.price;
      if (player.credits < cost) throw new ApiError(400, 'insufficient_credits', `信用点不够：要 ${cost}，你有 ${player.credits}`);
      const credits = player.credits - cost;
      repo.setCreditsPity(userId, credits, player.pity_count);
      repo.setPhone(userId);
      repo.logCredits(userId, t, -cost, free ? 'phone_test_free' : 'phone', credits);
      const response: BuyPhoneResponse = { ok: true, credits };
      repo.putIdempotent(userId, key, response, t);
      return response;
    })();
  });

  // 一次寄好几张（2026-11-18 用户要求）：每张都能送才扣钱，一个事务里一起送走；有一张不行就整批不动，告诉玩家是哪张
  app.post<{ Body: { cardIds?: unknown } }>('/api/phone/grade', async (req, reply) => {
    if (!req.user) return fail(reply, 401, 'unauthorized', '请重新打开卡奴登录');
    const key = idempotencyKey(req);
    if (!key) return fail(reply, 400, 'missing_idempotency_key', '请求缺少幂等 key，请刷新后再试');
    const raw = Array.isArray(req.body?.cardIds) ? req.body.cardIds : [];
    const ids = [...new Set(raw.map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0))];
    if (ids.length === 0) return fail(reply, 400, 'no_cards', '先把要送评的卡放进电话');
    if (ids.length > PHONE.gradingBatch) return fail(reply, 400, 'too_many', `一次最多寄 ${PHONE.gradingBatch} 张`);
    const userId = req.user.id;
    return repo.db.transaction((): GradeBatchResponse => {
      const replay = repo.getIdempotent<GradeBatchResponse>(userId, key);
      if (replay) return replay;
      const t = now();
      const player = repo.getPlayer(userId);
      if (!player) throw new ApiError(401, 'unauthorized', '请重新打开卡奴登录');
      if (player.phone !== 1) throw new ApiError(400, 'no_phone', '还没有电话，先买一部电话才能打给评级社');
      const free = deps.config.devUnlimitedIds.has(userId);
      const checked = ids.map((id) => {
        const { card } = ownCard(userId, id);
        const st = appraisalOf(repo, card);
        if (!st.canGrade) throw new ApiError(400, 'cannot_grade', `「${card.name}」${card.slab ? '已经封壳了' : card.gradeRejected ? '被评级社拒评过' : '已经在评级社了'}，先拿出来再寄`);
        return { card, fee: free ? 0 : st.gradingFee };
      });
      const cost = checked.reduce((s, c) => s + c.fee, 0);
      if (player.credits < cost) throw new ApiError(400, 'insufficient_credits', `信用点不够：这批要 ${cost}，你有 ${player.credits}`);
      const credits = player.credits - cost;
      repo.setCreditsPity(userId, credits, player.pity_count);
      repo.logCredits(userId, t, -cost, free ? 'grading_test_free' : 'grading', credits, { cards: ids });
      for (const { card } of checked) {
        repo.putAppraisal(card.id, 'grading', 'pending', t);
        repo.sendToGrading(card.id, player.game_day + APPRAISAL.grading.days);
      }
      const response: GradeBatchResponse = { ok: true, credits, cost, cards: ids.map((id) => repo.cardView(id)!) };
      repo.putIdempotent(userId, key, response, t);
      return response;
    })();
  });

  app.post<{ Params: { id: string } }>('/api/cards/:id/grade', async (req, reply) => {
    if (!req.user) return fail(reply, 401, 'unauthorized', '请重新打开卡奴登录');
    const key = idempotencyKey(req);
    if (!key) return fail(reply, 400, 'missing_idempotency_key', '请求缺少幂等 key，请刷新后再试');
    const userId = req.user.id;
    const cardId = Number.parseInt(req.params.id, 10);
    return repo.db.transaction((): GradeResponse => {
      const replay = repo.getIdempotent<GradeResponse>(userId, key);
      if (replay) return replay;
      const t = now();
      const player = repo.getPlayer(userId);
      if (!player) throw new ApiError(401, 'unauthorized', '请重新打开卡奴登录');
      if (player.phone !== 1) throw new ApiError(400, 'no_phone', '还没有电话，先买一部电话才能打给评级社');
      const { card } = ownCard(userId, cardId);
      const st = appraisalOf(repo, card);
      if (!st.canGrade) throw new ApiError(400, 'cannot_grade', card.slab ? '这张卡已经封壳了' : card.gradeRejected ? '评级社拒评过这张卡' : '这张卡已经在评级社了');
      const free = deps.config.devUnlimitedIds.has(userId);
      const cost = free ? 0 : st.gradingFee;
      if (player.credits < cost) throw new ApiError(400, 'insufficient_credits', `信用点不够：要 ${cost}，你有 ${player.credits}`);
      const credits = player.credits - cost;
      repo.setCreditsPity(userId, credits, player.pity_count);
      repo.logCredits(userId, t, -cost, free ? 'grading_test_free' : 'grading', credits, { card: card.id });
      repo.putAppraisal(card.id, 'grading', 'pending', t);
      repo.sendToGrading(card.id, player.game_day + APPRAISAL.grading.days);
      const response: GradeResponse = { ok: true, credits, card: repo.cardView(card.id)! };
      repo.putIdempotent(userId, key, response, t);
      return response;
    })();
  });
}

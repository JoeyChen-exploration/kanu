// 鉴定（M3，DESIGN 5，2026-11-17 用户重定）：
//   GET  /api/cards/:id/appraisal   一张卡的放大镜结论、送评状态、送评费
//   POST /api/cards/:id/inspect     放大镜查验（柜台上的道具，拖到卡上）：免费，每张卡只查一次，结论存库不再变；
//                                   重复请求返回同一个结论（设成目标状态，不需要幂等 key）
//   GET  /api/phone                 电话：买了没有、价格、在评级社的卡
//   POST /api/phone/buy             买电话（要幂等 key）
//   POST /api/cards/:id/grade       打电话给星港评级社送评（要电话、要幂等 key、扣费）：卡送走不能卖，下次打烊出结果
// 结论只给主人看；卡价只看封壳后公开的评分和错版（FR-APPR-5）。
import type { FastifyInstance } from 'fastify';
import { APPRAISAL, PHONE, type Rarity, type Style } from '@kanu/shared/balance';
import type {
  AppraisalOutcome, BuyPhoneResponse, CardAppraisalResponse, CardView, GradeResponse, InspectionView, PhoneResponse,
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
      const result = inspect(rng, { authenticity: inst.authenticity, grade: inst.grade, misprint: inst.misprint === 1 });
      repo.putAppraisal(card.id, 'inspect', result, now());
      repo.logEvent(userId, now(), 'inspect', { card: card.id });
      return appraisalOf(repo, card);
    })();
  });

  app.get('/api/phone', async (req, reply) => {
    if (!req.user) return fail(reply, 401, 'unauthorized', '请重新打开卡奴登录');
    const player = repo.getPlayer(req.user.id);
    if (!player) return fail(reply, 401, 'unauthorized', '请重新打开卡奴登录');
    return { ok: true, owned: player.phone === 1, price: PHONE.price, day: player.game_day, grading: repo.gradingCards(req.user.id) } satisfies PhoneResponse;
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

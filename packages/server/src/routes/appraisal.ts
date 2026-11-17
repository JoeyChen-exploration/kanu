// 鉴定（M3，DESIGN 5，SRS FR-APPR-1～5）：
//   GET  /api/appraisal                 鉴定台：在鉴定机构、评级社里的卡
//   GET  /api/cards/:id/appraisal       一张卡做过的鉴定和结论、费用、还能做哪些
//   POST /api/cards/:id/appraise        { method } 做一次鉴定（要幂等 key）
//     肉眼 / 放大镜：马上出结论，只给主人看，不改价格；
//     鉴定机构 / 评级社：扣费，卡送走（不能卖），过 APPRAISAL.*.days 个营业日在打烊时出结果（settleAppraisals）。
// 每张卡每种方式最多做一次，结论存库不再变（FR-APPR-1）。一条线的结论不提另一条线的属性。
import type { FastifyInstance } from 'fastify';
import { APPRAISAL, type Rarity, type Style } from '@kanu/shared/balance';
import type {
  AppraisalDeskResponse, AppraisalMethod, AppraisalNotes, AppraisalOutcome, AppraiseResponse, CardAppraisalResponse, CardView,
} from '@kanu/shared/types';
import { ApiError, fail, idempotencyKey, type Deps } from '../app.ts';
import type { InstanceRow } from '../db/index.ts';
import { eyeAuth, eyeGrade, gradeCard, labVerdict, loupeAuth, loupeGrade } from '../game/appraisal.ts';
import { gradingFee, labFee, loupeFee } from '../game/price.ts';

const METHODS: AppraisalMethod[] = ['eye_auth', 'loupe_auth', 'lab', 'eye_grade', 'loupe_grade', 'grading'];
const isMethod = (m: string): m is AppraisalMethod => (METHODS as string[]).includes(m);

/** 这张卡的鉴定结论（只给主人） */
export function notesOf(repo: Deps['repo'], cardId: number): AppraisalNotes {
  const a = repo.appraisalsOf(cardId);
  const get = <T>(m: string) => (a.get(m) as T | undefined) ?? null;
  return {
    eyeAuth: get('eye_auth'), loupeAuth: get('loupe_auth'), lab: get('lab'),
    eyeGrade: get('eye_grade'), loupeGrade: get('loupe_grade'), grading: get('grading'),
  };
}

/** 现在还能做哪些鉴定 */
export function canOf(card: CardView, notes: AppraisalNotes): Record<AppraisalMethod, boolean> {
  const here = card.location === 'inventory' || card.location === 'showcase';
  return {
    eye_auth: here && notes.eyeAuth === null,
    loupe_auth: here && notes.loupeAuth === null,
    lab: here && notes.lab === null && !card.verified,
    eye_grade: here && notes.eyeGrade === null && !card.slab,
    loupe_grade: here && notes.loupeGrade === null && !card.slab,
    grading: here && notes.grading === null && !card.slab && !card.gradeRejected,
  };
}

const feesOf = (card: CardView) => ({
  loupe: loupeFee(card.rarity as Rarity),
  lab: labFee(card.rarity as Rarity, card.style as Style),
  grading: gradingFee(card.rarity as Rarity, card.style as Style),
});

/**
 * 打烊时出结果（FR-APPR-3、4）：到期的卡按真实属性出结论，回到卡册或桌面。
 * 鉴定机构：真卡已验真（点亮图鉴）、假卡告诉主人、赃物没收；评级社：真卡封壳（点亮图鉴）、假卡拒评扣信誉。
 * 只能在事务里调用。返回给主人看的结果。
 */
export function settleAppraisals(deps: Deps, ownerId: string, day: number, now: number): AppraisalOutcome[] {
  const { repo } = deps;
  const out: AppraisalOutcome[] = [];
  const due: InstanceRow[] = repo.dueAppraisals(ownerId, day);
  for (const inst of due) {
    const view = repo.cardView(inst.id)!;
    if (inst.location === 'lab') {
      const verdict = labVerdict(inst.authenticity, inst.origin);
      repo.setAppraisal(inst.id, 'lab', verdict === 'stolen' ? 'stolen' : verdict);
      if (verdict === 'stolen') {
        // 赃物当场没收（DESIGN 5.1：鉴定机构是个陷阱）
        repo.deleteCard(inst.id);
        repo.logEvent(ownerId, now, 'lab_confiscated', { card: inst.id, template: inst.template_id });
      } else {
        repo.backFromAway(inst.id, { verified: verdict === 'verified' });
        deps.binders!.placeNew(ownerId, [inst.id], day);
        if (verdict === 'verified') repo.markCollected(ownerId, inst.template_id, inst.style, now);
        repo.logEvent(ownerId, now, 'lab_result', { card: inst.id, verdict });
      }
      out.push({ cardId: inst.id, name: view.name, method: 'lab', outcome: verdict, score: null });
    } else {
      const r = gradeCard(deps.rng, inst.authenticity, inst.grade);
      if (r.kind === 'slab') {
        repo.setAppraisal(inst.id, 'grading', 'slab');
        repo.backFromAway(inst.id, { slab: r.slab });
        repo.markCollected(ownerId, inst.template_id, inst.style, now);
        out.push({ cardId: inst.id, name: view.name, method: 'grading', outcome: 'slab', score: r.slab.score });
      } else {
        // 假卡拒评：不封壳、费用不退、打公开的拒评标记、扣信誉（DESIGN 5.2）
        repo.setAppraisal(inst.id, 'grading', 'rejected');
        repo.backFromAway(inst.id, { rejected: true });
        const p = repo.getPlayer(ownerId)!;
        repo.setCreditsReputation(ownerId, p.credits, Math.max(0, p.reputation - APPRAISAL.gradeRejectRepLoss));
        out.push({ cardId: inst.id, name: view.name, method: 'grading', outcome: 'rejected', score: null });
      }
      deps.binders!.placeNew(ownerId, [inst.id], day);
      repo.logEvent(ownerId, now, 'grading_result', { card: inst.id, outcome: r.kind });
    }
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

  app.get('/api/appraisal', async (req, reply) => {
    if (!req.user) return fail(reply, 401, 'unauthorized', '请重新打开卡奴登录');
    const player = repo.getPlayer(req.user.id);
    if (!player) return fail(reply, 401, 'unauthorized', '请重新打开卡奴登录');
    return { ok: true, day: player.game_day, lab: repo.awayCards(req.user.id, 'lab'), grading: repo.awayCards(req.user.id, 'grading') } satisfies AppraisalDeskResponse;
  });

  app.get<{ Params: { id: string } }>('/api/cards/:id/appraisal', async (req, reply) => {
    if (!req.user) return fail(reply, 401, 'unauthorized', '请重新打开卡奴登录');
    const { card } = ownCard(req.user.id, Number.parseInt(req.params.id, 10));
    const notes = notesOf(repo, card.id);
    return { ok: true, card, notes, fees: feesOf(card), can: canOf(card, notes) } satisfies CardAppraisalResponse;
  });

  app.post<{ Params: { id: string }; Body: { method?: unknown } }>('/api/cards/:id/appraise', async (req, reply) => {
    if (!req.user) return fail(reply, 401, 'unauthorized', '请重新打开卡奴登录');
    const key = idempotencyKey(req);
    if (!key) return fail(reply, 400, 'missing_idempotency_key', '请求缺少幂等 key，请刷新后再试');
    const method = String(req.body?.method ?? '');
    if (!isMethod(method)) return fail(reply, 400, 'bad_method', '没有这种鉴定方式');
    const userId = req.user.id;
    const cardId = Number.parseInt(req.params.id, 10);
    return repo.db.transaction((): AppraiseResponse => {
      const replay = repo.getIdempotent<AppraiseResponse>(userId, key);
      if (replay) return replay;
      const t = now();
      const player = repo.getPlayer(userId);
      if (!player) throw new ApiError(401, 'unauthorized', '请重新打开卡奴登录');
      const { inst, card } = ownCard(userId, cardId);
      const before = notesOf(repo, card.id);
      if (!canOf(card, before)[method]) {
        throw new ApiError(400, 'cannot_appraise', card.location === 'lab' || card.location === 'grading' ? '这张卡还在外面，等结果回来' : '这张卡已经做过这种鉴定了，结论不会变');
      }
      const fees = feesOf(card);
      const price = method === 'loupe_auth' || method === 'loupe_grade' ? fees.loupe : method === 'lab' ? fees.lab : method === 'grading' ? fees.grading : 0;
      const cost = deps.config.devUnlimitedIds.has(userId) ? 0 : price;
      if (player.credits < cost) throw new ApiError(400, 'insufficient_credits', `信用点不够：要 ${cost}，你有 ${player.credits}`);
      const credits = player.credits - cost;
      if (cost > 0 || price > 0) {
        repo.setCreditsPity(userId, credits, player.pity_count);
        repo.logCredits(userId, t, -cost, cost ? `appraise_${method}` : `appraise_${method}_test_free`, credits, { card: card.id });
      }

      // 结论：只按这条线的属性算，不提另一条线
      if (method === 'eye_auth') repo.putAppraisal(card.id, method, eyeAuth(rng, inst.authenticity), t);
      else if (method === 'loupe_auth') repo.putAppraisal(card.id, method, loupeAuth(rng, inst.authenticity), t);
      else if (method === 'eye_grade') repo.putAppraisal(card.id, method, eyeGrade(inst.grade), t);
      else if (method === 'loupe_grade') repo.putAppraisal(card.id, method, loupeGrade(rng, inst.grade), t);
      else {
        // 鉴定机构 / 评级社：送走，打烊时出结果
        const days = method === 'lab' ? APPRAISAL.lab.days : APPRAISAL.grading.days;
        repo.putAppraisal(card.id, method, 'pending', t);
        repo.sendAway(card.id, method === 'lab' ? 'lab' : 'grading', player.game_day + days);
      }
      repo.logEvent(userId, t, 'appraise', { card: card.id, method });

      const after = repo.cardView(card.id)!;
      const notes = notesOf(repo, card.id);
      const response: AppraiseResponse = { ok: true, credits, card: after, notes, can: canOf(after, notes) };
      repo.putIdempotent(userId, key, response, t);
      return response;
    })();
  });
}

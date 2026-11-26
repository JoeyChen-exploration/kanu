// 巡查（DESIGN 8.3）：打烊后巡查查出赃卡，玩家二选一，处理完柜台才开门。
//   POST /api/patrol/:id/resolve { choice: 'surrender' | 'bribe' }（幂等）
//     surrender 交出：查出的赃卡没收，信誉 −surrenderRepLoss
//     bribe 打点：付查出那天定的打点费（市场价合计 × bribePct），卡留下
import type { FastifyInstance } from 'fastify';
import { POLICE, REPUTATION } from '@kanu/shared/balance';
import type { PatrolResolveResponse } from '@kanu/shared/types';
import { ApiError, fail, idempotencyKey, type Deps } from '../app.ts';
import { patrolWaived } from '../day.ts';

export function registerPoliceRoutes(app: FastifyInstance, deps: Deps, now: () => number) {
  const { repo } = deps;

  app.post<{ Params: { id: string }; Body: { choice?: string } }>('/api/patrol/:id/resolve', async (req, reply) => {
    if (!req.user) return fail(reply, 401, 'unauthorized', '请重新打开卡奴登录');
    const key = idempotencyKey(req);
    if (!key) return fail(reply, 400, 'missing_idempotency_key', '请求缺少幂等 key，请刷新后再试');
    const userId = req.user.id;
    const choice = req.body?.choice;
    if (choice !== 'surrender' && choice !== 'bribe') return fail(reply, 400, 'bad_choice', 'choice 是 surrender（交出）或 bribe（打点）');
    return repo.db.transaction((): PatrolResolveResponse => {
      const replay = repo.getIdempotent<PatrolResolveResponse>(userId, key);
      if (replay) return replay;
      const t = now();
      const p = repo.getPatrol(userId, Number.parseInt(req.params.id, 10));
      if (!p) throw new ApiError(404, 'not_found', '没有这次巡查');
      if (p.status !== 'pending') throw new ApiError(400, 'resolved', '这次巡查已经处理过了');
      const player = repo.getPlayer(userId)!;
      const cards = JSON.parse(p.cards) as number[];
      let credits = player.credits;
      let reputation = player.reputation;
      if (choice === 'surrender') {
        for (const id of cards) if (repo.ownedInstance(userId, id)) repo.deleteCard(id);
        // 科技树 S4a 治安备案：每周第一次交出不扣信誉
        if (patrolWaived(deps, userId, p.day)) repo.logEvent(userId, t, 'patrol_waived', { day: p.day, patrol: p.id });
        else reputation = Math.max(REPUTATION.min, reputation - POLICE.surrenderRepLoss);
        repo.setPatrolStatus(p.id, 'surrendered');
      } else {
        if (credits < p.bribe) throw new ApiError(400, 'insufficient_credits', `打点要 ${p.bribe} 信用点，你有 ${credits}，只能交出`);
        credits -= p.bribe;
        repo.logCredits(userId, t, -p.bribe, 'patrol_bribe', credits, { patrol: p.id, cards });
        repo.setPatrolStatus(p.id, 'bribed');
      }
      repo.setCreditsReputation(userId, credits, reputation);
      repo.logEvent(userId, t, 'patrol_resolved', { patrol: p.id, choice, cards, bribe: choice === 'bribe' ? p.bribe : 0 });
      const response: PatrolResolveResponse = { ok: true, choice, credits, reputation };
      repo.putIdempotent(userId, key, response, t);
      return response;
    })();
  });
}

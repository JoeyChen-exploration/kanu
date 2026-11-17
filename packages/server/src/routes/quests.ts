// 任务栏 / 新手指引（FR-UI-4，2026-11-17 用户定）：
//   GET  /api/quests              全部任务的进度（按 balance.QUESTS 的顺序）
//   POST /api/quests/:id/claim    领奖（要幂等 key）：做完了才能领，每条只能领一次，加信用点写流水
// 进度从已有的流水和库存里数（repo.questStats），不另记计数。
import type { FastifyInstance } from 'fastify';
import { QUESTS } from '@kanu/shared/balance';
import type { QuestClaimResponse, QuestView, QuestsResponse } from '@kanu/shared/types';
import { ApiError, fail, idempotencyKey, type Deps } from '../app.ts';

export function registerQuestRoutes(app: FastifyInstance, deps: Deps, now: () => number) {
  const { repo } = deps;

  const view = (ownerId: string): QuestView[] => {
    const stats = repo.questStats(ownerId);
    const claimed = repo.questClaims(ownerId);
    return QUESTS.map((q) => {
      const progress = Math.min(q.target, stats[q.metric]);
      return { id: q.id, title: q.title, hint: q.hint, tab: q.tab, progress, target: q.target, reward: q.reward, done: progress >= q.target, claimed: claimed.has(q.id) };
    });
  };

  app.get('/api/quests', async (req, reply) => {
    if (!req.user) return fail(reply, 401, 'unauthorized', '请重新打开卡奴登录');
    return { ok: true, quests: view(req.user.id) } satisfies QuestsResponse;
  });

  app.post<{ Params: { id: string } }>('/api/quests/:id/claim', async (req, reply) => {
    if (!req.user) return fail(reply, 401, 'unauthorized', '请重新打开卡奴登录');
    const key = idempotencyKey(req);
    if (!key) return fail(reply, 400, 'missing_idempotency_key', '请求缺少幂等 key，请刷新后再试');
    const userId = req.user.id;
    const quest = QUESTS.find((q) => q.id === req.params.id);
    if (!quest) return fail(reply, 404, 'not_found', '没有这个任务');
    return repo.db.transaction((): QuestClaimResponse => {
      const replay = repo.getIdempotent<QuestClaimResponse>(userId, key);
      if (replay) return replay;
      const t = now();
      const player = repo.getPlayer(userId);
      if (!player) throw new ApiError(401, 'unauthorized', '请重新打开卡奴登录');
      const current = view(userId).find((q) => q.id === quest.id)!;
      if (!current.done) throw new ApiError(400, 'not_done', `还没完成：${current.progress} / ${current.target}`);
      if (!repo.claimQuest(userId, quest.id, t)) throw new ApiError(400, 'claimed', '这个任务的奖励已经领过了');
      const credits = player.credits + quest.reward;
      repo.setCreditsPity(userId, credits, player.pity_count);
      repo.logCredits(userId, t, quest.reward, 'quest', credits, { quest: quest.id });
      const response: QuestClaimResponse = { ok: true, credits, reward: quest.reward, quests: view(userId) };
      repo.putIdempotent(userId, key, response, t);
      return response;
    })();
  });
}

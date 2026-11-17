// 珍藏柜（DESIGN 8.1、FR-INV-6、FR-INV-11）：
//   GET  /api/showcase           珍藏柜状态（等级、格数、展示分和效果）+ 柜里的卡
//   POST /api/showcase/upgrade   解锁 / 升一级（要幂等 key，扣信用点写流水）
// 放进 / 取出珍藏柜还是 POST /api/inventory/:id/showcase。
import type { FastifyInstance } from 'fastify';
import { SHOWCASE, type Rarity } from '@kanu/shared/balance';
import type { ShowcaseResponse, ShowcaseStatus, ShowcaseUpgradeResponse } from '@kanu/shared/types';
import { ApiError, fail, idempotencyKey, type Deps } from '../app.ts';
import { showcaseEffects, showcaseScore, showcaseSlots } from '../game/showcase.ts';

export function showcaseStatus(repo: Deps['repo'], ownerId: string): ShowcaseStatus {
  const level = repo.getPlayer(ownerId)?.showcase_level ?? 0;
  const cards = repo.showcaseCards(ownerId);
  const score = showcaseScore(cards.map((c) => ({ rarity: c.rarity as Rarity, style: c.style })));
  const fx = showcaseEffects(score);
  const nextSpec = SHOWCASE.levels[level + 1];
  return {
    level,
    slots: showcaseSlots(level),
    used: cards.length,
    score,
    priceBonusPct: Math.round((fx.priceMult - 1) * 100),
    patienceBonus: fx.patienceBonus,
    next: nextSpec ? { level: level + 1, price: nextSpec.price, slots: nextSpec.slots } : null,
  };
}

export function registerShowcaseRoutes(app: FastifyInstance, deps: Deps, now: () => number) {
  const { repo } = deps;

  app.get('/api/showcase', async (req, reply) => {
    if (!req.user) return fail(reply, 401, 'unauthorized', '请重新打开卡奴登录');
    return { ok: true, status: showcaseStatus(repo, req.user.id), cards: repo.showcaseCards(req.user.id) } satisfies ShowcaseResponse;
  });

  app.post('/api/showcase/upgrade', async (req, reply) => {
    if (!req.user) return fail(reply, 401, 'unauthorized', '请重新打开卡奴登录');
    const key = idempotencyKey(req);
    if (!key) return fail(reply, 400, 'missing_idempotency_key', '请求缺少幂等 key，请刷新后再试');
    const userId = req.user.id;
    return repo.db.transaction((): ShowcaseUpgradeResponse => {
      const replay = repo.getIdempotent<ShowcaseUpgradeResponse>(userId, key);
      if (replay) return replay;
      const t = now();
      const player = repo.getPlayer(userId);
      if (!player) throw new ApiError(401, 'unauthorized', '请重新打开卡奴登录');
      const next = SHOWCASE.levels[player.showcase_level + 1];
      if (!next) throw new ApiError(400, 'max_level', '珍藏柜已经是最高级了');
      const free = deps.config.devUnlimitedIds.has(userId);
      const cost = free ? 0 : next.price;
      if (player.credits < cost) throw new ApiError(400, 'insufficient_credits', `信用点不够：要 ${cost}，你有 ${player.credits}`);
      const credits = player.credits - cost;
      repo.setCreditsPity(userId, credits, player.pity_count);
      repo.setShowcaseLevel(userId, player.showcase_level + 1);
      repo.logCredits(userId, t, -cost, free ? 'showcase_test_free' : 'showcase', credits, { level: player.showcase_level + 1 });
      const response: ShowcaseUpgradeResponse = { ok: true, credits, status: showcaseStatus(repo, userId) };
      repo.putIdempotent(userId, key, response, t);
      return response;
    })();
  });
}

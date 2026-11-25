// 科技树（docs/TECH-TREE.md，MVP 6 个节点）：
//   GET  /api/tech               整棵树 + 自己的状态（点过没有、前置、条件进度）
//   POST /api/tech/buy {nodeId}  买节点（幂等）：校验前置和条件，蓝图不够的部分按 BLUEPRINT.perCredit 用信用点换，一个事务里扣钱、加节点、写流水
//   POST /api/tech/track {nodeId|null}  在任务栏里追踪这个节点的解锁条件
import type { FastifyInstance } from 'fastify';
import { BLUEPRINT, TECH_BRANCHES, TECH_NODES, type TechBranch, type TechNode } from '@kanu/shared/balance';
import type { TechBuyResponse, TechNodeView, TechResponse } from '@kanu/shared/types';
import { ApiError, fail, idempotencyKey, type Deps } from '../app.ts';
import { checkCondition, techBlock } from '../game/tech.ts';

export function techNodeViews(repo: Deps['repo'], ownerId: string): TechNodeView[] {
  const player = repo.getPlayer(ownerId)!;
  const owned = repo.techOwned(ownerId);
  const ctx = { stats: repo.questStats(ownerId), reputation: player.reputation };
  const byId = new Map(TECH_NODES.map((n) => [n.id, n]));
  return TECH_NODES.map((n: TechNode) => {
    const block = techBlock(n, owned, ctx);
    const ref = (r: string) => ({ id: r, name: byId.get(r)?.name ?? r, owned: owned.has(r) });
    return {
      id: n.id, branch: n.branch, branchName: TECH_BRANCHES[n.branch].name, tier: n.tier, name: n.name, price: n.price, effect: n.effect, flavor: n.flavor,
      requires: n.requires.map(ref), anyOf: (n.anyOf ?? []).map(ref), exclusive: n.exclusive ? ref(n.exclusive) : null,
      conditions: n.conditions.map((c) => checkCondition(c, ctx)),
      soon: n.soon ?? null, conditionText: n.conditionText ?? null,
      owned: owned.has(n.id), unlockable: block === null, tracked: player.tech_tracked === n.id,
    };
  });
}

export function registerTechRoutes(app: FastifyInstance, deps: Deps, now: () => number) {
  const { repo } = deps;
  const free = (id: string) => deps.config.devUnlimitedIds.has(id);

  const tree = (ownerId: string): TechResponse => {
    const player = repo.getPlayer(ownerId)!;
    const views = techNodeViews(repo, ownerId);
    return {
      ok: true, credits: player.credits, blueprints: player.blueprints,
      branches: (Object.keys(TECH_BRANCHES) as TechBranch[]).map((b) => ({ id: b, ...TECH_BRANCHES[b], nodes: views.filter((v) => v.branch === b) })),
    };
  };

  app.get('/api/tech', async (req, reply) => {
    if (!req.user) return fail(reply, 401, 'unauthorized', '请重新打开卡奴登录');
    return tree(req.user.id);
  });

  app.post<{ Body: { nodeId?: string } }>('/api/tech/buy', async (req, reply) => {
    if (!req.user) return fail(reply, 401, 'unauthorized', '请重新打开卡奴登录');
    const key = idempotencyKey(req);
    if (!key) return fail(reply, 400, 'missing_idempotency_key', '请求缺少幂等 key，请刷新后再试');
    const userId = req.user.id;
    const node = TECH_NODES.find((n) => n.id === req.body?.nodeId);
    if (!node) return fail(reply, 404, 'not_found', '没有这个节点');
    return repo.db.transaction((): TechBuyResponse => {
      const replay = repo.getIdempotent<TechBuyResponse>(userId, key);
      if (replay) return replay;
      const t = now();
      const player = repo.getPlayer(userId);
      if (!player) throw new ApiError(401, 'unauthorized', '请重新打开卡奴登录');
      const view = techNodeViews(repo, userId).find((v) => v.id === node.id)!;
      if (view.owned) throw new ApiError(400, 'owned', `「${node.name}」已经点过了`);
      if (view.soon) throw new ApiError(400, 'soon', `「${node.name}」第 ${view.soon} 阶段才开放`);
      if (view.exclusive?.owned) throw new ApiError(400, 'exclusive', `「${node.name}」和「${view.exclusive.name}」只能二选一`);
      const missing = view.requires.filter((r) => !r.owned);
      if (missing.length) throw new ApiError(400, 'requires', `要先点：${missing.map((r) => r.name).join('、')}`);
      if (view.anyOf.length && !view.anyOf.some((r) => r.owned)) throw new ApiError(400, 'requires', `要先点其中一个：${view.anyOf.map((r) => r.name).join(' / ')}`);
      const unmet = view.conditions.filter((c) => !c.met);
      if (unmet.length) throw new ApiError(400, 'conditions', `还没满足：${unmet.map((c) => `${c.text}（${c.current} / ${c.target}）`).join('、')}`);
      // 蓝图先用；不够的部分用信用点换（1 信用点 = perCredit 蓝图）
      const fromBlueprints = Math.min(player.blueprints, node.price);
      const converted = node.price - fromBlueprints;
      const creditCost = free(userId) ? 0 : Math.ceil(converted / BLUEPRINT.perCredit);
      if (player.credits < creditCost) throw new ApiError(400, 'insufficient_credits', `信用点不够：要 ${creditCost}，你有 ${player.credits}`);
      const credits = player.credits - creditCost;
      const blueprints = player.blueprints - fromBlueprints;
      repo.setCreditsPity(userId, credits, player.pity_count);
      repo.setBlueprints(userId, blueprints);
      repo.addTech(userId, node.id, t);
      if (player.tech_tracked === node.id) repo.setTechTracked(userId, null);
      if (creditCost > 0) repo.logCredits(userId, t, -creditCost, 'blueprints', credits, { node: node.id, blueprints: converted });
      repo.logEvent(userId, t, 'tech_buy', { node: node.id, price: node.price, fromBlueprints, converted });
      const response: TechBuyResponse = { ok: true, credits, blueprints, converted, node: techNodeViews(repo, userId).find((v) => v.id === node.id)! };
      repo.putIdempotent(userId, key, response, t);
      return response;
    })();
  });

  app.post<{ Body: { nodeId?: string | null } }>('/api/tech/track', async (req, reply) => {
    if (!req.user) return fail(reply, 401, 'unauthorized', '请重新打开卡奴登录');
    const id = req.body?.nodeId ?? null;
    if (id !== null && !TECH_NODES.some((n) => n.id === id)) return fail(reply, 404, 'not_found', '没有这个节点');
    repo.setTechTracked(req.user.id, id);
    return tree(req.user.id);
  });
}

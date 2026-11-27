// 派系（DESIGN 8.4）：
//   GET  /api/factions             三个派系的关系值、等级、奖励（隐藏的治安关系不返回）
//   POST /api/factions/registry    { cardId }（幂等）黑市盟友查一张卡在不在失窃登记表上，每周 FACTIONS.registryPerWeek 次
//   POST /api/factions/tribute     （幂等）黑市最后通牒以后交摆平费，黑市关系回到 FACTIONS.vendetta.tributeTo
import type { FastifyInstance } from 'fastify';
import { FACTIONS, RENT } from '@kanu/shared/balance';
import type { FactionsResponse, RegistryResponse, TributeResponse } from '@kanu/shared/types';
import { rentForWeek } from '../game/price.ts';
import { ApiError, fail, idempotencyKey, type Deps } from '../app.ts';
import { factionValues } from '../factions.ts';
import { TIER_NAMES, tierOf, vendettaOf } from '../game/factions.ts';
import { runDay } from '../game/rent.ts';

const PERKS: Record<string, Array<{ tier: 'known' | 'ally'; text: string }>> = {
  guild: [{ tier: 'ally', text: `电脑订货 ${Math.round(FACTIONS.guildAlly.storeDiscount * 100) / 10} 折，每天多买 ${FACTIONS.guildAlly.storePacks} 包` }],
  black: [
    { tier: 'known', text: '黑市卡包解锁' },
    { tier: 'ally', text: `失窃登记表副本：每周查 ${FACTIONS.registryPerWeek} 张卡是不是赃物` },
  ],
  collectors: [{ tier: 'ally', text: '每周高价收卡委托（以后开放）' }],
};

export function registerFactionRoutes(app: FastifyInstance, deps: Deps, now: () => number) {
  const { repo } = deps;

  /** 这周（按交租周期算）还能查几次；不是黑市盟友是 null */
  const registryLeft = (userId: string): number | null => {
    const p = repo.getPlayer(userId)!;
    if (p.rep_black < FACTIONS.allyMin) return null;
    const week = Math.ceil(runDay(p.game_day, p.run_start_day) / RENT.everyDays);
    const from = p.run_start_day + (week - 1) * RENT.everyDays;
    return Math.max(0, FACTIONS.registryPerWeek - repo.countEventsInDays(userId, 'registry_check', from, from + RENT.everyDays - 1));
  };

  /** 摆平费：这一轮当前周的摊位费 × tributeRentMult；没到最后通牒是 null */
  const tributeOf = (userId: string): number | null => {
    const p = repo.getPlayer(userId)!;
    const stage = vendettaOf(p.rep_black);
    if (stage !== 'ultimatum' && stage !== 'hunted') return null;
    const week = Math.max(1, Math.ceil(runDay(p.game_day, p.run_start_day) / RENT.everyDays));
    return Math.round(rentForWeek(week) * FACTIONS.vendetta.tributeRentMult);
  };

  app.get('/api/factions', async (req, reply) => {
    if (!req.user) return fail(reply, 401, 'unauthorized', '请重新打开卡奴登录');
    const v = factionValues(repo, req.user.id);
    const factions = FACTIONS.list.map((f) => {
      const value = v[f.id];
      const tier = tierOf(value);
      return {
        ...f, value, tier, tierName: TIER_NAMES[tier],
        perks: (PERKS[f.id] ?? []).map((p) => ({ ...p, active: value >= (p.tier === 'ally' ? FACTIONS.allyMin : FACTIONS.knownMin) })),
      };
    });
    const { min, max, hostileMax, knownMin, allyMin } = FACTIONS;
    return { ok: true, factions, thresholds: { min, max, hostileMax, knownMin, allyMin }, registryLeft: registryLeft(req.user.id),
      vendetta: (() => { const stage = vendettaOf(v.black); return stage ? { stage, tribute: tributeOf(req.user!.id), hitPct: FACTIONS.vendetta.hitPpm / 10_000 } : null; })(),
    } satisfies FactionsResponse;
  });

  app.post('/api/factions/tribute', async (req, reply) => {
    if (!req.user) return fail(reply, 401, 'unauthorized', '请重新打开卡奴登录');
    const key = idempotencyKey(req);
    if (!key) return fail(reply, 400, 'missing_idempotency_key', '请求缺少幂等 key，请刷新后再试');
    const userId = req.user.id;
    return repo.db.transaction((): TributeResponse => {
      const replay = repo.getIdempotent<TributeResponse>(userId, key);
      if (replay) return replay;
      const t = now();
      const cost = tributeOf(userId);
      if (cost === null) throw new ApiError(400, 'not_needed', '黑市还没找上门，用不着摆平');
      const p = repo.getPlayer(userId)!;
      if (p.credits < cost) throw new ApiError(400, 'insufficient_credits', `摆平要 ${cost} 信用点，你有 ${p.credits}`);
      const credits = p.credits - cost;
      repo.setCreditsPity(userId, credits, p.pity_count);
      const black = FACTIONS.vendetta.tributeTo;
      repo.setFactions(userId, { ...factionValues(repo, userId), black });
      repo.logCredits(userId, t, -cost, 'black_tribute', credits, { day: p.game_day, from: p.rep_black, to: black });
      const response: TributeResponse = { ok: true, credits, paid: cost, black };
      repo.putIdempotent(userId, key, response, t);
      return response;
    })();
  });

  app.post<{ Body: { cardId?: unknown } }>('/api/factions/registry', async (req, reply) => {
    if (!req.user) return fail(reply, 401, 'unauthorized', '请重新打开卡奴登录');
    const key = idempotencyKey(req);
    if (!key) return fail(reply, 400, 'missing_idempotency_key', '请求缺少幂等 key，请刷新后再试');
    const userId = req.user.id;
    const cardId = Number(req.body?.cardId);
    return repo.db.transaction((): RegistryResponse => {
      const replay = repo.getIdempotent<RegistryResponse>(userId, key);
      if (replay) return replay;
      const t = now();
      const left = registryLeft(userId);
      if (left === null) throw new ApiError(400, 'locked', `黑市关系要到盟友（${FACTIONS.allyMin}）才拿得到失窃登记表`);
      if (left <= 0) throw new ApiError(400, 'weekly_limit', `这周的 ${FACTIONS.registryPerWeek} 次已经查完了`);
      // 自己的卡（含藏匿室）和卡贩摆在台面上的货都能查
      const inst = Number.isInteger(cardId) ? repo.ownedInstance(userId, cardId) : undefined;
      if (!inst) throw new ApiError(404, 'not_found', '找不到这张卡');
      const player = repo.getPlayer(userId)!;
      const onRegistry = inst.origin === 'stolen';
      repo.logEvent(userId, t, 'registry_check', { day: player.game_day, card: cardId, onRegistry });
      const response: RegistryResponse = { ok: true, cardId, onRegistry, registryLeft: left - 1 };
      repo.putIdempotent(userId, key, response, t);
      return response;
    })();
  });
}

// 卡册（DESIGN 4.5）：
//   GET  /api/binders             我的卡册（各用了几格）、桌面散卡、用品店里能买的卡册
//   GET  /api/binders/:id?page=   翻某本卡册的一页（一页 9 格）
//   POST /api/binders/buy         { kind } 买一本卡册（要幂等 key），买完自动把桌面散卡收进去
//   POST /api/binders/organize    把桌面散卡收进有空位的卡册（设成目标状态，不要求幂等 key）
import type { FastifyInstance } from 'fastify';
import { BINDER_KINDS, BINDER_PAGE_SIZE, BINDERS, LOOSE, type BinderKind } from '@kanu/shared/balance';
import type { BinderPageResponse, BinderView, BindersResponse, BuyBinderResponse } from '@kanu/shared/types';
import { ApiError, fail, idempotencyKey, type Deps } from '../app.ts';

const isKind = (k: string): k is BinderKind => (BINDER_KINDS as readonly string[]).includes(k);

export function registerBinderRoutes(app: FastifyInstance, deps: Deps, now: () => number) {
  const { repo } = deps;
  const binders = deps.binders!;

  const view = (b: { id: number; kind: string; used: number }): BinderView => {
    const spec = BINDERS[b.kind as BinderKind];
    return { id: b.id, kind: b.kind, name: spec.name, slots: spec.slots, used: b.used, effect: spec.effect };
  };

  app.get('/api/binders', async (req, reply) => {
    if (!req.user) return fail(reply, 401, 'unauthorized', '请重新打开卡奴登录');
    const userId = req.user.id;
    const player = repo.getPlayer(userId);
    if (!player) return fail(reply, 401, 'unauthorized', '请重新打开卡奴登录');
    repo.db.transaction(() => binders.ensureStarter(userId, now(), player.game_day))();
    return {
      ok: true,
      binders: repo.bindersOf(userId).map(view),
      loose: { slots: LOOSE.slots, cards: repo.looseCards(userId).sort((a, b) => b.price - a.price) },
      catalog: BINDER_KINDS.map((k) => ({ kind: k, name: BINDERS[k].name, price: BINDERS[k].price, slots: BINDERS[k].slots, effect: BINDERS[k].effect })),
    } satisfies BindersResponse;
  });

  app.get<{ Params: { id: string }; Querystring: { page?: string } }>('/api/binders/:id', async (req, reply) => {
    if (!req.user) return fail(reply, 401, 'unauthorized', '请重新打开卡奴登录');
    const b = repo.bindersOf(req.user.id).find((x) => x.id === Number.parseInt(req.params.id, 10));
    if (!b) return fail(reply, 404, 'not_found', '找不到这本卡册');
    const pages = Math.max(1, Math.ceil(BINDERS[b.kind as BinderKind].slots / BINDER_PAGE_SIZE));
    const page = Math.min(pages, Math.max(1, Number.parseInt(req.query.page ?? '1', 10) || 1));
    return { ok: true, binder: view(b), page, pages, cards: repo.binderCards(b.id, page, BINDER_PAGE_SIZE) } satisfies BinderPageResponse;
  });

  app.post<{ Body: { kind?: unknown } }>('/api/binders/buy', async (req, reply) => {
    if (!req.user) return fail(reply, 401, 'unauthorized', '请重新打开卡奴登录');
    const key = idempotencyKey(req);
    if (!key) return fail(reply, 400, 'missing_idempotency_key', '请求缺少幂等 key，请刷新后再试');
    const kind = String(req.body?.kind ?? '');
    if (!isKind(kind)) return fail(reply, 400, 'bad_binder', '没有这种卡册');
    const userId = req.user.id;
    return repo.db.transaction((): BuyBinderResponse => {
      const replay = repo.getIdempotent<BuyBinderResponse>(userId, key);
      if (replay) return replay;
      const t = now();
      const player = repo.getPlayer(userId);
      if (!player) throw new ApiError(401, 'unauthorized', '请重新打开卡奴登录');
      const free = deps.config.devUnlimitedIds.has(userId);
      const cost = free ? 0 : BINDERS[kind].price;
      if (player.credits < cost) throw new ApiError(400, 'insufficient_credits', `信用点不够：要 ${cost}，你有 ${player.credits}`);
      const id = repo.insertBinder(userId, kind, t);
      const credits = player.credits - cost;
      repo.setCreditsPity(userId, credits, player.pity_count);
      repo.logCredits(userId, t, -cost, free ? 'binder_test_free' : 'binder', credits, { kind, binder: id });
      const { placed } = binders.autoFill(userId, player.game_day);
      const b = repo.bindersOf(userId).find((x) => x.id === id)!;
      const response: BuyBinderResponse = { ok: true, credits, binder: view(b), placed };
      repo.putIdempotent(userId, key, response, t);
      return response;
    })();
  });

  app.post('/api/binders/organize', async (req, reply) => {
    if (!req.user) return fail(reply, 401, 'unauthorized', '请重新打开卡奴登录');
    const userId = req.user.id;
    const player = repo.getPlayer(userId);
    if (!player) return fail(reply, 401, 'unauthorized', '请重新打开卡奴登录');
    const { placed } = repo.db.transaction(() => binders.autoFill(userId, player.game_day))();
    return { ok: true, placed };
  });
}

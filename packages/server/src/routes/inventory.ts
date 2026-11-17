// 库存、珍藏柜、图鉴（FR-INV-1、2、4、5、6）。返回的卡牌一律经过 toCardView，只有公开信息。
import type { FastifyInstance } from 'fastify';
import { RARITIES, SHOWCASE } from '@kanu/shared/balance';
import type { CardLocation, CollectionResponse, InventoryResponse } from '@kanu/shared/types';
import { fail, type Deps } from '../app.ts';

const PAGE_SIZE = 30;

export function registerInventoryRoutes(app: FastifyInstance, deps: Deps) {
  const { repo } = deps;

  app.get<{ Querystring: { rarity?: string; location?: string; page?: string } }>('/api/inventory', async (req, reply) => {
    if (!req.user) return fail(reply, 401, 'unauthorized', '请重新打开卡奴登录');
    const rarity = RARITIES.includes(req.query.rarity as never) ? req.query.rarity : undefined;
    const location = (['inventory', 'showcase'] as const).includes(req.query.location as CardLocation) ? (req.query.location as CardLocation) : undefined;
    const page = Math.max(1, Math.min(10_000, Number.parseInt(req.query.page ?? '1', 10) || 1));
    const { total, cards } = repo.inventory(req.user.id, { rarity, location, page, pageSize: PAGE_SIZE });
    return { ok: true, cards, total, page, pageSize: PAGE_SIZE } satisfies InventoryResponse;
  });

  // 放进 / 取出珍藏柜。设成目标状态，重复请求结果一样，所以不需要幂等 key
  app.post<{ Params: { id: string }; Body: { on?: unknown } }>('/api/inventory/:id/showcase', async (req, reply) => {
    if (!req.user) return fail(reply, 401, 'unauthorized', '请重新打开卡奴登录');
    const id = Number.parseInt(req.params.id, 10);
    const on = req.body?.on === true;
    return repo.db.transaction(() => {
      const card = repo.ownedInstance(req.user!.id, id);
      if (!card) return fail(reply, 404, 'not_found', '找不到这张卡');
      if (card.location !== 'inventory' && card.location !== 'showcase') return fail(reply, 400, 'busy', '这张卡现在不能动');
      if (on && card.location !== 'showcase' && repo.countLocation(req.user!.id, 'showcase') >= SHOWCASE.slots) {
        return fail(reply, 400, 'showcase_full', `珍藏柜只有 ${SHOWCASE.slots} 格，先取出一张`);
      }
      repo.setLocation(id, on ? 'showcase' : 'inventory');
      return { ok: true, card: repo.cardView(id) };
    })();
  });

  app.get('/api/collection', async (req, reply) => {
    if (!req.user) return fail(reply, 401, 'unauthorized', '请重新打开卡奴登录');
    const { owned, counts } = repo.collection(req.user.id);
    const templates = repo.allTemplates();
    const series = repo.allSeries().map((s) => {
      const cards = templates.filter((t) => t.series_id === s.id).map((t) => ({
        templateId: t.id,
        name: t.name,
        rarity: t.rarity,
        tags: JSON.parse(t.tags) as string[],
        owned: owned.has(t.id),
        count: counts.get(t.id) ?? 0,
      }));
      return { id: s.id, name: s.name, total: cards.length, owned: cards.filter((c) => c.owned).length, cards };
    });
    return { ok: true, series } satisfies CollectionResponse;
  });
}

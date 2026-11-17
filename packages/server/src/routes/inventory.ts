// 库存、珍藏柜、图鉴（FR-INV-1、2、4、5、6）。返回的卡牌一律经过 toCardView，只有公开信息。
import type { FastifyInstance } from 'fastify';
import { RARITIES, STYLE, stylesFor } from '@kanu/shared/balance';
import { showcaseSlots } from '../game/showcase.ts';
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
      const slots = showcaseSlots(repo.getPlayer(req.user!.id)?.showcase_level ?? 0);
      if (on && card.location !== 'showcase' && slots === 0) return fail(reply, 400, 'showcase_locked', '还没有珍藏柜，先在库存页解锁');
      if (on && card.location !== 'showcase' && repo.countLocation(req.user!.id, 'showcase') >= slots) {
        return fail(reply, 400, 'showcase_full', `珍藏柜只有 ${slots} 格，先取出一张或者升级珍藏柜`);
      }
      if (on === (card.location === 'showcase')) return { ok: true, card: repo.cardView(id) };
      if (on) {
        // 珍藏柜不占卡册格子：放进去时从卡册 / 桌面拿出来
        repo.placeCard(id, null, null);
        repo.setLocation(id, 'showcase');
      } else {
        // 取出来：放回有空位的卡册，满了散放在桌面；都放不下就不让取
        const player = repo.getPlayer(req.user!.id)!;
        if (deps.binders!.space(req.user!.id).total === 0) return fail(reply, 400, 'no_space', '卡册和桌面都满了，先卖掉几张或买本新卡册');
        repo.setLocation(id, 'inventory');
        deps.binders!.placeNew(req.user!.id, [id], player.game_day);
      }
      return { ok: true, card: repo.cardView(id) };
    })();
  });

  app.get('/api/collection', async (req, reply) => {
    if (!req.user) return fail(reply, 401, 'unauthorized', '请重新打开卡奴登录');
    const { owned, counts, ownedStyles, styleCounts } = repo.collection(req.user.id);
    const templates = repo.allTemplates();
    const series = repo.allSeries().map((s) => {
      const cards = templates.filter((t) => t.series_id === s.id).map((t) => {
        // 大师图鉴（DESIGN 3.6）：只列这个稀有度可能出的风格
        const styles = stylesFor(t.rarity).map((st) => ({
          style: st,
          name: STYLE[st].name,
          owned: ownedStyles.has(`${t.id}|${st}`),
          count: styleCounts.get(`${t.id}|${st}`) ?? 0,
        }));
        return {
          templateId: t.id,
          name: t.name,
          rarity: t.rarity,
          tags: JSON.parse(t.tags) as string[],
          owned: owned.has(t.id),
          count: counts.get(t.id) ?? 0,
          styles,
          master: styles.every((x) => x.owned),
        };
      });
      return {
        id: s.id, name: s.name, kind: s.kind, total: cards.length,
        owned: cards.filter((c) => c.owned).length, master: cards.filter((c) => c.master).length, cards,
      };
    });
    return { ok: true, series } satisfies CollectionResponse;
  });
}

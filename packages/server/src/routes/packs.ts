// 进货和拆包（DESIGN 4，2026-11-17 卡包重做；FR-PACK-1～6、9）：
//   GET  /api/store              电脑订货：5 种卡包、价格、爆率、本营业日还能买几包
//   POST /api/store/buy          购物车 { items: [{ seriesId, count }] }，正常价、保证正品；买来的卡包原封不动进库存
//   GET  /api/packs              库存里还没拆的卡包（按种类分组）
//   POST /api/packs/:id/open     拆一包：发卡、保底、编号限定、点亮图鉴、播报
// 写操作都在一个事务里、要求幂等 key，信用点变动写流水（DR-1、DR-2）。播报在事务提交之后再发。
import type { FastifyInstance } from 'fastify';
import { ANNOUNCE, PACKS, RARITIES, SERIAL_LIMIT, STORE, STYLE, atLeast, type PackType, type Rarity } from '@kanu/shared/balance';
import type { BuyPacksResponse, CardView, OpenPackResponse, SealedPacksResponse, StoreResponse } from '@kanu/shared/types';
import { ApiError, fail, idempotencyKey, type Deps } from '../app.ts';
import { dayKey } from '../db/index.ts';
import { openPack } from '../game/cards.ts';

const escapeMd = (s: string) => s.replace(/[\\*_`~|>]/g, '\\$&');

export function announcementFor(playerName: string, c: CardView): string | null {
  const serial = c.style === 'serial';
  if (!serial && !atLeast(c.rarity as Rarity, ANNOUNCE.minRarity)) return null;
  const style = c.style === 'standard' ? '' : `（${STYLE[c.style as keyof typeof STYLE].name}${serial ? ` ${String(c.serialNo).padStart(2, '0')}/${SERIAL_LIMIT}` : ''}）`;
  return `🎉 **${escapeMd(playerName)}** 开出了 ${c.rarity}「${escapeMd(c.name)}」${style}`;
}

export function registerPackRoutes(app: FastifyInstance, deps: Deps, now: () => number) {
  const { repo } = deps;
  const unlimited = (id: string) => deps.config.devUnlimitedIds.has(id);

  const leftToday = (userId: string) => {
    if (unlimited(userId)) return null;
    const player = repo.getPlayer(userId)!;
    return Math.max(0, STORE.packsPerDay - repo.packsOpenedToday(userId, dayKey(player.game_day)));
  };

  app.get('/api/store', async (req, reply) => {
    if (!req.user) return fail(reply, 401, 'unauthorized', '请重新打开卡奴登录');
    const templates = repo.allTemplates();
    const packs = repo.allSeries().map((s) => {
      const p = PACKS[s.kind];
      return {
        seriesId: s.id,
        name: s.name,
        kind: s.kind,
        kindName: p.name,
        price: p.price,
        cardCount: templates.filter((t) => t.series_id === s.id).length,
        odds: RARITIES.filter((r) => p.odds[r] > 0).map((r) => ({ rarity: r, percent: p.odds[r] / 10_000 })),
      };
    });
    return { ok: true, packs, packsLeftToday: leftToday(req.user.id) } satisfies StoreResponse;
  });

  // 购物车（2026-11-17）：{ items: [{ seriesId, count }] } 一次买好几种；也兼容只买一种的 { seriesId, count }
  app.post<{ Body: { items?: unknown; seriesId?: unknown; count?: unknown } }>('/api/store/buy', async (req, reply) => {
    if (!req.user) return fail(reply, 401, 'unauthorized', '请重新打开卡奴登录');
    const key = idempotencyKey(req);
    if (!key) return fail(reply, 400, 'missing_idempotency_key', '请求缺少幂等 key，请刷新后再试');
    const userId = req.user.id;
    const raw = Array.isArray(req.body?.items) ? req.body.items : [{ seriesId: req.body?.seriesId, count: req.body?.count ?? 1 }];
    const items = (raw as Array<{ seriesId?: unknown; count?: unknown }>).map((x) => ({ seriesId: String(x?.seriesId ?? ''), count: Number(x?.count ?? 0) }));
    if (!items.length || items.length > 10 || items.some((x) => !Number.isInteger(x.count) || x.count < 1 || x.count > 50)) {
      return fail(reply, 400, 'bad_count', '购物车里的数量不对');
    }

    return repo.db.transaction((): BuyPacksResponse => {
      const replay = repo.getIdempotent<BuyPacksResponse>(userId, key);
      if (replay) return replay;
      const t = now();
      const known = new Set(repo.allSeries().map((s) => s.id));
      const priced = items.map((x) => {
        const kind = repo.seriesKind(x.seriesId);
        if (!kind || !known.has(x.seriesId)) throw new ApiError(400, 'bad_pack', '没有这种卡包');
        return { ...x, price: PACKS[kind].price };
      });
      const player = repo.getPlayer(userId);
      if (!player) throw new ApiError(401, 'unauthorized', '请重新打开卡奴登录');
      const day = dayKey(player.game_day);
      const used = repo.packsOpenedToday(userId, day);
      const total = priced.reduce((n, x) => n + x.count, 0);
      // 测试账号（DEV_UNLIMITED_IDS，只在 DEV_AUTH=1 时有）：不限购、不扣钱
      const free = unlimited(userId);
      if (!free && used + total > STORE.packsPerDay) {
        throw new ApiError(400, 'daily_limit', `电脑订货每个营业日最多 ${STORE.packsPerDay} 包，今天还能买 ${Math.max(0, STORE.packsPerDay - used)} 包`);
      }
      const cost = free ? 0 : priced.reduce((n, x) => n + x.price * x.count, 0);
      if (player.credits < cost) throw new ApiError(400, 'insufficient_credits', `信用点不够：要 ${cost}，你有 ${player.credits}`);

      const packIds = priced.flatMap((x) => Array.from({ length: x.count }, () => repo.insertSealed(userId, x.seriesId, 'store', t)));
      const credits = player.credits - cost;
      repo.setCreditsPity(userId, credits, player.pity_count);
      for (let i = 0; i < total; i += 1) repo.bumpNormalPacks(userId, day);
      repo.logCredits(userId, t, -cost, free ? 'store_test_free' : 'store', credits, { items: priced.map(({ seriesId, count }) => ({ seriesId, count })), packs: packIds });
      const response: BuyPacksResponse = {
        ok: true, credits, packIds, packsLeftToday: free ? null : STORE.packsPerDay - used - total,
      };
      repo.putIdempotent(userId, key, response, t);
      return response;
    })();
  });

  app.get('/api/packs', async (req, reply) => {
    if (!req.user) return fail(reply, 401, 'unauthorized', '请重新打开卡奴登录');
    const groups = new Map<string, SealedPacksResponse['groups'][number]>();
    for (const p of repo.sealedByOwner(req.user.id)) {
      const g = groups.get(p.series_id) ?? { seriesId: p.series_id, name: p.name, kind: p.kind, ids: [] };
      g.ids.push(p.id);
      groups.set(p.series_id, g);
    }
    return { ok: true, groups: [...groups.values()] } satisfies SealedPacksResponse;
  });

  app.post<{ Params: { id: string } }>('/api/packs/:id/open', async (req, reply) => {
    if (!req.user) return fail(reply, 401, 'unauthorized', '请重新打开卡奴登录');
    const key = idempotencyKey(req);
    if (!key) return fail(reply, 400, 'missing_idempotency_key', '请求缺少幂等 key，请刷新后再试');
    const userId = req.user.id;
    const packId = Number.parseInt(req.params.id, 10);

    let toAnnounce: string[] = [];
    const result = repo.db.transaction((): OpenPackResponse => {
      const replay = repo.getIdempotent<OpenPackResponse>(userId, key);
      if (replay) return replay;
      const t = now();
      const player = repo.getPlayer(userId);
      if (!player) throw new ApiError(401, 'unauthorized', '请重新打开卡奴登录');
      const sealed = repo.getSealed(userId, packId);
      if (!sealed) throw new ApiError(404, 'not_found', '找不到这包卡（可能已经拆了）');
      const kind = repo.seriesKind(sealed.series_id) as PackType;
      // 卡册和桌面都放不下这一包了就不让拆（DESIGN 4.5）
      deps.binders!.ensureStarter(userId, t, player.game_day);
      const space = deps.binders!.space(userId);
      if (space.total < PACKS[kind].cards) {
        throw new ApiError(400, 'no_space', `卡册和桌面都快满了（还能放 ${space.total} 张，一包 ${PACKS[kind].cards} 张）。先卖点卡、或者买本新卡册`);
      }

      const byRarity = Object.fromEntries(RARITIES.map((r) => [r, repo.templatesFor(sealed.series_id, r)])) as Record<Rarity, ReturnType<typeof repo.templatesFor>>;
      const counts = Object.fromEntries(RARITIES.map((r) => [r, byRarity[r].length])) as Record<Rarity, number>;
      const rolled = openPack(deps.rng, {
        packType: kind,
        pityCount: player.pity_count,
        templateCounts: counts,
        serialAvailable: (r, i) => repo.serialLeft(byRarity[r][i]!.id, SERIAL_LIMIT),
      });

      const ids = rolled.cards.map((c) => {
        const tpl = byRarity[c.rarity][c.templateIndex]!;
        let style = c.style;
        let serialNo: number | null = null;
        if (style === 'serial') {
          // 事务里占号，保证不重号；刚好发完就按标准框（FR-PACK-5）
          serialNo = repo.takeSerial(tpl.id, SERIAL_LIMIT);
          if (serialNo === null) style = 'standard';
        }
        return repo.insertCard({ templateId: tpl.id, ownerId: userId, authenticity: c.authenticity, grade: String(c.grade), origin: c.origin, style, serialNo, now: t });
      });

      deps.binders!.placeNew(userId, ids, player.game_day);
      repo.deleteSealed(packId);
      repo.setCreditsPity(userId, player.credits, rolled.pityCount);
      repo.logEvent(userId, t, 'pack_open', { pack: packId, seriesId: sealed.series_id, source: sealed.source, cards: ids, pityTriggered: rolled.pityTriggered });

      const cards = ids.map((id) => repo.cardView(id)!);
      const response: OpenPackResponse = { ok: true, cards, pityCount: rolled.pityCount, pityTriggered: rolled.pityTriggered };
      repo.putIdempotent(userId, key, response, t);
      toAnnounce = cards.map((c) => announcementFor(player.display_name, c)).filter((s): s is string => s !== null);
      return response;
    })();

    for (const text of toAnnounce) deps.notifier.announce(text);
    return result;
  });
}

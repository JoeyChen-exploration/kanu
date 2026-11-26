// 进货和拆包（DESIGN 4，2026-11-17 卡包重做；FR-PACK-1～6、9）：
//   GET  /api/store              电脑订货：5 种卡包、价格、爆率、本营业日还能买几包
//   POST /api/store/buy          购物车 { items: [{ seriesId, count }] }，正常价、保证正品；买来的卡包原封不动进库存
//   GET  /api/packs              库存里还没拆的卡包（按种类分组）
//   POST /api/packs/:id/open     拆一包：发卡、保底、编号限定、点亮图鉴、播报
// 写操作都在一个事务里、要求幂等 key，信用点变动写流水（DR-1、DR-2）。播报在事务提交之后再发。
import { techEffects } from '../game/tech.ts';
import type { FastifyInstance } from 'fastify';
import { bumpFaction, guildAlly } from '../factions.ts';
import { ANNOUNCE, BLACK_MARKET, FACTIONS, PACKS, RARITIES, SERIAL_LIMIT, STORE, STYLE, WHOLESALE, atLeast, type PackType, type Rarity } from '@kanu/shared/balance';
import type { BlackBuyResponse, BlackMarketResponse, BuyPacksResponse, CardView, OpenPackResponse, SealedPacksResponse, StoreResponse } from '@kanu/shared/types';
import { ApiError, fail, idempotencyKey, type Deps } from '../app.ts';
import { dayKey } from '../db/index.ts';
import { openPack } from '../game/cards.ts';
import { rollErrata } from '../game/appraisal.ts';

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

  /** 电脑订货每天限购：基础值 + 科技树（G1 批发证） */
  const packsPerDay = (userId: string) => STORE.packsPerDay + techEffects(repo.techOwned(userId)).storePacksPerDay + (guildAlly(repo, userId) ? FACTIONS.guildAlly.storePacks : 0);
  /** 正规商会盟友（DESIGN 8.4）电脑订货打折 */
  const storePrice = (userId: string, price: number) => (guildAlly(repo, userId) ? Math.round(price * FACTIONS.guildAlly.storeDiscount) : price);

  const leftToday = (userId: string) => {
    if (unlimited(userId)) return null;
    const player = repo.getPlayer(userId)!;
    return Math.max(0, packsPerDay(userId) - repo.packsOpenedToday(userId, dayKey(player.game_day)));
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
        price: storePrice(req.user!.id, p.price),
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
        return { ...x, price: storePrice(userId, PACKS[kind].price) };
      });
      const player = repo.getPlayer(userId);
      if (!player) throw new ApiError(401, 'unauthorized', '请重新打开卡奴登录');
      const day = dayKey(player.game_day);
      const used = repo.packsOpenedToday(userId, day);
      const total = priced.reduce((n, x) => n + x.count, 0);
      // 测试账号（DEV_UNLIMITED_IDS，只在 DEV_AUTH=1 时有）：不限购、不扣钱
      const free = unlimited(userId);
      const limit = packsPerDay(userId);
      if (!free && used + total > limit) {
        throw new ApiError(400, 'daily_limit', `电脑订货每个营业日最多 ${limit} 包，今天还能买 ${Math.max(0, limit - used)} 包`);
      }
      const cost = free ? 0 : priced.reduce((n, x) => n + x.price * x.count, 0);
      if (player.credits < cost) throw new ApiError(400, 'insufficient_credits', `信用点不够：要 ${cost}，你有 ${player.credits}`);

      const packIds = priced.flatMap((x) => Array.from({ length: x.count }, () => repo.insertSealed(userId, x.seriesId, 'store', t)));
      const credits = player.credits - cost;
      repo.setCreditsPity(userId, credits, player.pity_count);
      for (let i = 0; i < total; i += 1) repo.bumpNormalPacks(userId, day);
      repo.logCredits(userId, t, -cost, free ? 'store_test_free' : 'store', credits, { items: priced.map(({ seriesId, count }) => ({ seriesId, count })), packs: packIds });
      const response: BuyPacksResponse = {
        ok: true, credits, packIds, packsLeftToday: free ? null : limit - used - total,
      };
      repo.putIdempotent(userId, key, response, t);
      return response;
    })();
  });

  // ---- 黑市（DESIGN 4）：解锁后每个营业日最多 BLACK_MARKET.perDay 包，和电脑订货分开算 ----
  const blackStatus = (userId: string) => {
    const player = repo.getPlayer(userId)!;
    const current = player.rep_black;
    const free = unlimited(userId);
    const used = repo.blackBoughtToday(userId, player.game_day);
    return { player, free, used, unlocked: free || current >= FACTIONS.knownMin, current };
  };

  app.get('/api/black', async (req, reply) => {
    if (!req.user) return fail(reply, 401, 'unauthorized', '请重新打开卡奴登录');
    const b = blackStatus(req.user.id);
    const p = PACKS.black;
    const response: BlackMarketResponse = {
      ok: true, unlocked: b.unlocked, progress: { current: Math.max(0, Math.min(b.current, FACTIONS.knownMin)), target: FACTIONS.knownMin },
      price: p.price, perDay: BLACK_MARKET.perDay, leftToday: b.free ? null : Math.max(0, BLACK_MARKET.perDay - b.used),
      odds: RARITIES.filter((r) => p.odds[r] > 0).map((r) => ({ rarity: r, percent: p.odds[r] / 10_000 })),
      fakePct: p.fakePpm / 10_000, stolenPct: p.stolenPpm / 10_000,
    };
    return response;
  });

  app.post<{ Body: { count?: unknown } }>('/api/black/buy', async (req, reply) => {
    if (!req.user) return fail(reply, 401, 'unauthorized', '请重新打开卡奴登录');
    const key = idempotencyKey(req);
    if (!key) return fail(reply, 400, 'missing_idempotency_key', '请求缺少幂等 key，请刷新后再试');
    const userId = req.user.id;
    const count = Number(req.body?.count ?? 1);
    if (!Number.isInteger(count) || count < 1 || count > 10) return fail(reply, 400, 'bad_count', '数量不对');
    return repo.db.transaction((): BlackBuyResponse => {
      const replay = repo.getIdempotent<BlackBuyResponse>(userId, key);
      if (replay) return replay;
      const t = now();
      const b = blackStatus(userId);
      if (!b.unlocked) throw new ApiError(400, 'locked', `黑市还不认识你：黑市关系要到熟脸（${FACTIONS.knownMin}，现在 ${b.current}）。多和黑市中间人做生意`);
      if (!b.free && b.used + count > BLACK_MARKET.perDay) throw new ApiError(400, 'daily_limit', `黑市每个营业日最多 ${BLACK_MARKET.perDay} 包，今天还能买 ${Math.max(0, BLACK_MARKET.perDay - b.used)} 包`);
      const cost = b.free ? 0 : PACKS.black.price * count;
      if (b.player.credits < cost) throw new ApiError(400, 'insufficient_credits', `信用点不够：要 ${cost}，你有 ${b.player.credits}`);
      const packIds = Array.from({ length: count }, () => repo.insertSealed(userId, BLACK_MARKET.seriesId, 'black', t));
      const credits = b.player.credits - cost;
      repo.setCreditsPity(userId, credits, b.player.pity_count);
      repo.logCredits(userId, t, -cost, b.free ? 'black_test_free' : 'black', credits, { day: b.player.game_day, count, packs: packIds });
      bumpFaction(repo, userId, 'blackPack', t, b.player.game_day, count);
      const response: BlackBuyResponse = { ok: true, credits, packIds, leftToday: b.free ? null : BLACK_MARKET.perDay - b.used - count };
      repo.putIdempotent(userId, key, response, t);
      return response;
    })();
  });

  app.get('/api/packs', async (req, reply) => {
    if (!req.user) return fail(reply, 401, 'unauthorized', '请重新打开卡奴登录');
    const groups = new Map<string, SealedPacksResponse['groups'][number]>();
    // 电话批发来的卡包单独一组（公开：批发商不保证正品）
    for (const p of repo.sealedByOwner(req.user.id)) {
      const wholesale = p.source === 'phone';
      const black = p.source === 'black';
      const k = `${p.series_id}|${wholesale ? 'w' : black ? 'b' : 's'}`;
      const g = groups.get(k) ?? { seriesId: p.series_id, name: p.name, kind: p.kind, ids: [], wholesale, ...(black ? { black } : {}) };
      g.ids.push(p.id);
      groups.set(k, g);
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

      // 黑市包（DESIGN 4）：所有系列这个稀有度的卡一起抽
      const all = kind === 'black' ? repo.allTemplates() : [];
      const byRarity = Object.fromEntries(RARITIES.map((r) => [r, kind === 'black' ? all.filter((x) => x.rarity === r) : repo.templatesFor(sealed.series_id, r)])) as Record<Rarity, ReturnType<typeof repo.templatesFor>>;
      const counts = Object.fromEntries(RARITIES.map((r) => [r, byRarity[r].length])) as Record<Rarity, number>;
      const rolled = openPack(deps.rng, {
        packType: kind,
        pityCount: player.pity_count,
        templateCounts: counts,
        serialAvailable: (r, i) => repo.serialLeft(byRarity[r][i]!.id, SERIAL_LIMIT),
        // 电话批发的卡包批发商不保证正品（DESIGN 4）
        ...(sealed.source === 'phone' ? { fakePpm: WHOLESALE.fakePpm } : {}),
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
        // 图鉴按公开的来源点亮：电脑订货的卡包保证正品，拆出来就点亮；其他来源（以后的电话批发）等送评封壳后点亮。
        // 错版（隐藏）在这里另外抽，不动 openPack 的随机序列
        return repo.insertCard({
          templateId: tpl.id, ownerId: userId, authenticity: c.authenticity, grade: String(c.grade), origin: c.origin, style, serialNo, now: t,
          collect: sealed.source === 'store', misprint: rollErrata(deps.rng),
          acquired: sealed.source === 'phone' ? 'wholesale' : sealed.source === 'black' ? 'black' : 'store',
        });
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

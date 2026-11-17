// POST /api/packs/open：开正规卡包（FR-PACK-1～6、9）。
// 一次开包的全部写操作在一个事务里：扣信用点、记限购、发卡、点亮图鉴、更新保底、写流水、存幂等结果（DR-1、DR-2）。
// 播报在事务提交之后再发，失败不影响开包。
import type { FastifyInstance } from 'fastify';
import { ANNOUNCE, PACKS, RARITIES, SERIAL_LIMIT, STYLE, atLeast, type Rarity } from '@kanu/shared/balance';
import type { CardView, OpenPackResponse } from '@kanu/shared/types';
import { ApiError, fail, idempotencyKey, type Deps } from '../app.ts';
import { openPack } from '../game/cards.ts';
import { sydneyDay } from '../time.ts';

const escapeMd = (s: string) => s.replace(/[\\*_`~|>]/g, '\\$&');

export function announcementFor(playerName: string, c: CardView): string | null {
  const serial = c.style === 'serial';
  if (!serial && !atLeast(c.rarity as Rarity, ANNOUNCE.minRarity)) return null;
  const style = c.style === 'standard' ? '' : `（${STYLE[c.style as keyof typeof STYLE].name}${serial ? ` ${String(c.serialNo).padStart(2, '0')}/${SERIAL_LIMIT}` : ''}）`;
  return `🎉 **${escapeMd(playerName)}** 开出了 ${c.rarity}「${escapeMd(c.name)}」${style}`;
}

export function registerPackRoutes(app: FastifyInstance, deps: Deps, now: () => number) {
  const { repo } = deps;

  app.post<{ Body: { packType?: unknown } }>('/api/packs/open', async (req, reply) => {
    if (!req.user) return fail(reply, 401, 'unauthorized', '请重新打开卡奴登录');
    const key = idempotencyKey(req);
    if (!key) return fail(reply, 400, 'missing_idempotency_key', '请求缺少幂等 key，请刷新后再试');
    const packType = req.body?.packType ?? 'normal';
    if (packType !== 'normal') return fail(reply, 400, 'bad_pack', '这种卡包还没开放');
    const userId = req.user.id;

    const replay = repo.getIdempotent<OpenPackResponse>(userId, key);
    if (replay) return replay;

    let toAnnounce: string[] = [];
    const result = repo.db.transaction((): OpenPackResponse => {
      const again = repo.getIdempotent<OpenPackResponse>(userId, key);
      if (again) return again;

      const t = now();
      const player = repo.getPlayer(userId);
      if (!player) throw new ApiError(401, 'unauthorized', '请重新打开卡奴登录');
      const pack = PACKS.normal;
      const day = sydneyDay(t);
      const used = repo.packsOpenedToday(userId, day);
      if (used >= pack.dailyLimit) throw new ApiError(400, 'daily_limit', `今天的正规卡包已经买满 ${pack.dailyLimit} 包了，明天再来`);
      if (player.credits < pack.price) throw new ApiError(400, 'insufficient_credits', `信用点不够：一包 ${pack.price}，你有 ${player.credits}`);

      const byRarity = Object.fromEntries(RARITIES.map((r) => [r, repo.templatesFor(deps.currentSeries, r)])) as Record<Rarity, ReturnType<typeof repo.templatesFor>>;
      const counts = Object.fromEntries(RARITIES.map((r) => [r, byRarity[r].length])) as Record<Rarity, number>;
      const rolled = openPack(deps.rng, {
        packType: 'normal',
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

      const credits = player.credits - pack.price;
      repo.setCreditsPity(userId, credits, rolled.pityCount);
      repo.bumpNormalPacks(userId, day);
      repo.logCredits(userId, t, -pack.price, 'pack', credits, { packType, cards: ids });
      if (rolled.pityTriggered) repo.logEvent(userId, t, 'pity', { cards: ids });

      const cards = ids.map((id) => repo.cardView(id)!);
      const response: OpenPackResponse = {
        ok: true,
        cards,
        credits,
        pityCount: rolled.pityCount,
        pityTriggered: rolled.pityTriggered,
        packsLeftToday: pack.dailyLimit - used - 1,
      };
      repo.putIdempotent(userId, key, response, t);
      toAnnounce = cards.map((c) => announcementFor(player.display_name, c)).filter((s): s is string => s !== null);
      return response;
    })();

    for (const text of toAnnounce) deps.notifier.announce(text);
    return result;
  });
}

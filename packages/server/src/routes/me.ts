// GET /api/me：玩家状态（SRS 6.1）：名字、信用点、信誉、周数、金币余额（FR-AUTH-7）、保底进度、今天还能开几包。
import { techEffects } from '../game/tech.ts';
import { rentStatus } from '../day.ts';
import { isAdmin } from './admin.ts';
import type { FastifyInstance } from 'fastify';
import { FACTIONS, STORE } from '@kanu/shared/balance';
import { guildAlly } from '../factions.ts';
import type { MeResponse } from '@kanu/shared/types';
import { fail, type Deps } from '../app.ts';
import { dayKey } from '../db/index.ts';

export function registerMeRoutes(app: FastifyInstance, deps: Deps, now: () => number) {
  app.get('/api/me', async (req, reply) => {
    if (!req.user) return fail(reply, 401, 'unauthorized', '请重新打开卡奴登录');
    const player = deps.repo.getPlayer(req.user.id);
    if (!player) return fail(reply, 401, 'unauthorized', '请重新打开卡奴登录');
    // 老玩家（卡册上线前建的档）第一次进来补一本开局卡册
    deps.repo.db.transaction(() => deps.binders!.ensureStarter(player.discord_id, now(), player.game_day))();
    const wallet = await deps.wallet.balance(req.user.id);
    const used = deps.repo.packsOpenedToday(req.user.id, dayKey(player.game_day));
    const body: MeResponse = {
      ok: true,
      user: { id: player.discord_id, name: player.display_name, avatar: player.avatar },
      credits: player.credits,
      reputation: player.reputation,
      weekNo: player.week_no,
      wallet,
      pityCount: player.pity_count,
      packsLeftToday: Math.max(0, STORE.packsPerDay + techEffects(deps.repo.techOwned(player.discord_id)).storePacksPerDay + (guildAlly(deps.repo, player.discord_id) ? FACTIONS.guildAlly.storePacks : 0) - used),
      gameDay: player.game_day,
      rent: rentStatus(deps, player.discord_id),
      devTools: deps.config.devUnlimitedIds.has(req.user.id),
      isAdmin: isAdmin(deps, req.user.id),
    };
    return body;
  });

  // 测试工具：直接把信用点设成某个数（只给测试账号用；DEV_AUTH 没开时 devUnlimitedIds 是空的，等于不存在）
  app.post<{ Body: { credits?: unknown } }>('/api/dev/credits', async (req, reply) => {
    if (!req.user || !deps.config.devUnlimitedIds.has(req.user.id)) return fail(reply, 404, 'not_found', '没有这个接口');
    const credits = Number(req.body?.credits);
    if (!Number.isInteger(credits) || credits < 0 || credits > 100_000_000) return fail(reply, 400, 'bad_credits', '信用点要是 0 到 1 亿之间的整数');
    const player = deps.repo.getPlayer(req.user.id);
    if (!player) return fail(reply, 401, 'unauthorized', '请重新打开卡奴登录');
    deps.repo.db.transaction(() => {
      deps.repo.setCreditsPity(req.user!.id, credits, player.pity_count);
      deps.repo.logCredits(req.user!.id, now(), credits - player.credits, 'dev_set', credits);
    })();
    return { ok: true, credits };
  });
}

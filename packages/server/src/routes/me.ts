// GET /api/me：玩家状态（SRS 6.1）。M0 只返回名字、信用点、信誉、周数和金币余额（FR-AUTH-7）。
import type { FastifyInstance } from 'fastify';
import type { MeResponse } from '@kanu/shared/types';
import { fail, type Deps } from '../app.ts';

export function registerMeRoutes(app: FastifyInstance, deps: Deps) {
  app.get('/api/me', async (req, reply) => {
    if (!req.user) return fail(reply, 401, 'unauthorized', '请重新打开卡奴登录');
    const player = deps.repo.getPlayer(req.user.id);
    if (!player) return fail(reply, 401, 'unauthorized', '请重新打开卡奴登录');
    const wallet = await deps.wallet.balance(req.user.id);
    const body: MeResponse = {
      ok: true,
      user: { id: player.discord_id, name: player.display_name, avatar: player.avatar },
      credits: player.credits,
      reputation: player.reputation,
      weekNo: player.week_no,
      wallet,
    };
    return body;
  });
}

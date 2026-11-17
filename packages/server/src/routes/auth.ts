// POST /api/auth/token：授权码 → Discord access token → 卡奴会话（FR-AUTH-2、3、5、6）
// POST /api/auth/dev-login：只在 DEV_AUTH=1 时可用，浏览器里不经过 Discord 直接登录（本机开发用）
import type { FastifyInstance } from 'fastify';
import type { AuthTokenResponse, SessionUser } from '@kanu/shared/types';
import { fail, type Deps } from '../app.ts';
import { AuthError } from '../auth/discord.ts';

export function registerAuthRoutes(app: FastifyInstance, deps: Deps, now: () => number) {
  const login = (user: SessionUser, accessToken: string | null): AuthTokenResponse => {
    deps.repo.db.transaction(() => {
      const player = deps.repo.ensurePlayer(user, now());
      deps.binders!.ensureStarter(user.id, now(), player.game_day);
    })();
    return { ok: true, accessToken, session: deps.sessions.issue(user, now()), user };
  };

  app.post<{ Body: { code?: unknown } }>('/api/auth/token', async (req, reply) => {
    const code = typeof req.body?.code === 'string' ? req.body.code : '';
    if (!code) return fail(reply, 400, 'bad_request', '缺少授权码');
    try {
      const { accessToken, user } = await deps.discord.exchange(code);
      return login(user, accessToken);
    } catch (e) {
      if (e instanceof AuthError) return fail(reply, e.code === 'wrong_guild' ? 403 : 401, e.code, e.message);
      req.log.error(e, 'auth exchange failed');
      return fail(reply, 502, 'discord_unreachable', '连不上 Discord，稍后再试');
    }
  });

  app.post<{ Body: { name?: unknown } }>('/api/auth/dev-login', async (req, reply) => {
    if (!deps.config.devAuth) return fail(reply, 404, 'not_found', '没有这个接口');
    const name = String(req.body?.name ?? '').trim().slice(0, 20);
    if (!name) return fail(reply, 400, 'bad_request', '起个名字');
    // 纯数字当 Discord ID 用，方便连本地旺财联调；其余加 dev- 前缀，不会和真 ID 撞
    const id = /^\d{17,20}$/.test(name) ? name : `dev-${name}`;
    return login({ id, name, avatar: null }, null);
  });
}

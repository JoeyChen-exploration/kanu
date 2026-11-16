// 用 Activity 拿到的授权码向 Discord 换 access token，再确认用户身份和服务器成员资格（SRS FR-AUTH-2、FR-AUTH-6）。
import type { SessionUser } from '@kanu/shared/types';

const API = 'https://discord.com/api/v10';

export class AuthError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export interface DiscordAuth {
  exchange(code: string): Promise<{ accessToken: string; user: SessionUser }>;
}

export function createDiscordAuth(opts: {
  clientId: string | null;
  clientSecret: string | null;
  guildId: string | null;
  fetchImpl?: typeof fetch;
}): DiscordAuth {
  const f = opts.fetchImpl ?? fetch;
  return {
    async exchange(code) {
      if (!opts.clientId || !opts.clientSecret) throw new AuthError('not_configured', '服务器还没配置 Discord 应用');
      const tokenRes = await f(`${API}/oauth2/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: opts.clientId,
          client_secret: opts.clientSecret,
          grant_type: 'authorization_code',
          code,
        }),
        signal: AbortSignal.timeout(8000),
      });
      const tok = (await tokenRes.json().catch(() => ({}))) as { access_token?: string };
      if (!tok.access_token) throw new AuthError('discord_token', 'Discord 登录失败，请重新打开');
      const auth = { authorization: `Bearer ${tok.access_token}` };

      const me = (await (await f(`${API}/users/@me`, { headers: auth, signal: AbortSignal.timeout(8000) })).json()) as {
        id?: string; username?: string; global_name?: string | null; avatar?: string | null;
      };
      if (!me.id) throw new AuthError('discord_user', '拿不到 Discord 用户信息');

      if (opts.guildId) {
        const guilds = (await (await f(`${API}/users/@me/guilds`, { headers: auth, signal: AbortSignal.timeout(8000) })).json()) as Array<{ id: string }>;
        if (!Array.isArray(guilds) || !guilds.some((g) => g.id === opts.guildId)) {
          throw new AuthError('wrong_guild', '卡奴只在本服务器开放');
        }
      }

      return {
        accessToken: tok.access_token,
        user: {
          id: me.id,
          name: me.global_name || me.username || '无名店主',
          avatar: me.avatar ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png?size=64` : null,
        },
      };
    },
  };
}

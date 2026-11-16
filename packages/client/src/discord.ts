// 登录（SRS FR-AUTH-1～3）。
// 在 Discord 里：SDK ready → authorize 拿授权码 → 服务器换会话 → authenticate。
// 在普通浏览器里（本机开发，服务器开了 DEV_AUTH=1）：走开发登录。
import type { AuthTokenResponse, ConfigResponse } from '@kanu/shared/types';
import { api, setSession } from './api.ts';

/** Discord 打开 Activity 时 URL 会带 frame_id */
export const insideDiscord = () => new URLSearchParams(window.location.search).has('frame_id');

export async function loginWithDiscord(cfg: ConfigResponse): Promise<AuthTokenResponse> {
  if (!cfg.clientId) throw new Error('服务器还没配置 Discord 应用');
  const { DiscordSDK } = await import('@discord/embedded-app-sdk');
  const sdk = new DiscordSDK(cfg.clientId);
  await sdk.ready();
  const { code } = await sdk.commands.authorize({
    client_id: cfg.clientId,
    response_type: 'code',
    state: '',
    prompt: 'none',
    scope: ['identify', 'guilds'],
  });
  const r = await api<AuthTokenResponse>('/auth/token', { method: 'POST', body: { code } });
  if (r.accessToken) await sdk.commands.authenticate({ access_token: r.accessToken });
  setSession(r.session);
  return r;
}

export async function devLogin(name: string): Promise<AuthTokenResponse> {
  const r = await api<AuthTokenResponse>('/auth/dev-login', { method: 'POST', body: { name } });
  setSession(r.session);
  return r;
}

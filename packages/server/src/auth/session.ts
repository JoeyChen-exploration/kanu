// 卡奴自己的会话 token：base64url(JSON) + "." + HMAC-SHA256，带过期时间（SRS FR-AUTH-3）。
// 服务器只认这里面的用户 id（FR-AUTH-4）。
import crypto from 'node:crypto';
import { SESSION } from '@kanu/shared/balance';
import type { SessionUser } from '@kanu/shared/types';

export interface SessionCodec {
  issue(user: SessionUser, now?: number): string;
  verify(token: string | undefined, now?: number): SessionUser | null;
}

export function createSessionCodec(secret: string): SessionCodec {
  const sign = (body: string) => crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return {
    issue(user, now = Date.now()) {
      const body = Buffer.from(JSON.stringify({ ...user, exp: now + SESSION.ttlMs })).toString('base64url');
      return `${body}.${sign(body)}`;
    },
    verify(token, now = Date.now()) {
      const [body, mac] = String(token || '').split('.');
      if (!body || !mac) return null;
      const want = Buffer.from(sign(body));
      const got = Buffer.from(mac);
      if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
      try {
        const data = JSON.parse(Buffer.from(body, 'base64url').toString());
        if (typeof data.exp !== 'number' || data.exp <= now || typeof data.id !== 'string') return null;
        return { id: data.id, name: String(data.name ?? ''), avatar: data.avatar ?? null };
      } catch {
        return null;
      }
    },
  };
}

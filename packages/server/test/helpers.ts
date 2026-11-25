// 测试用的应用组装：内存数据库、导入真实的系列内容、可复现的随机源、记录播报的假 notifier。
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { openDb } from '../src/db/index.ts';
import { createSessionCodec } from '../src/auth/session.ts';
import { AuthError, type DiscordAuth } from '../src/auth/discord.ts';
import { createWalletClient, type WalletClient } from '../src/wallet/client.ts';
import { importAllSeries } from '../src/content.ts';
import { seeded, type Rng } from '../src/game/rng.ts';
import type { Notifier } from '../src/notify/discord.ts';

export const NOW = 1_800_000_000_000;

export function setup(opts: { devAuth?: boolean; discord?: DiscordAuth; disabled?: boolean; rng?: Rng; now?: () => number; unlimited?: string; wallet?: WalletClient; rateLimit?: number; admin?: string } = {}) {
  const config = {
    ...loadConfig({ DEV_AUTH: opts.devAuth ? '1' : '0', SESSION_SECRET: 'test-secret', KANU_DISABLED: opts.disabled ? '1' : '0', DEV_UNLIMITED_IDS: opts.unlimited ?? '', RATE_LIMIT_PER_SECOND: String(opts.rateLimit ?? 0), ADMIN_USER_IDS: opts.admin ?? '' }),
    clientDist: '/nonexistent',
  };
  const repo = openDb(':memory:');
  importAllSeries(repo);
  const announced: string[] = [];
  const notifier: Notifier = { announce: (t) => { announced.push(t); }, flush: async () => {} };
  const discord: DiscordAuth = opts.discord ?? {
    exchange: async (code) => {
      if (code === 'bad') throw new AuthError('discord_token', 'Discord 登录失败，请重新打开');
      if (code === 'outsider') throw new AuthError('wrong_guild', '卡奴只在本服务器开放');
      return { accessToken: 'at-123', user: { id: '123456789012345678', name: '阿奴', avatar: null } };
    },
  };
  const app = buildApp({
    config,
    repo,
    sessions: createSessionCodec('test-secret'),
    discord,
    wallet: opts.wallet ?? createWalletClient({ mode: 'mock', port: null, secret: null, mockCoins: 321 }),
    rng: opts.rng ?? seeded(1),
    notifier,
    currentSeries: 'NEO',
    now: opts.now ?? (() => NOW),
  });
  return { app, repo, announced };
}

/** 登录并返回带会话的请求头 */
export async function login(app: ReturnType<typeof setup>['app']) {
  const { session } = (await app.inject({ method: 'POST', url: '/api/auth/token', payload: { code: 'good' } })).json();
  return { authorization: `Bearer ${session}` };
}

let keySeq = 0;
export const idem = () => ({ 'idempotency-key': `test-key-${++keySeq}-${Math.random().toString(36).slice(2)}` });

/** 递归找对象里有没有这些键（隐藏属性不能出现在任何响应里） */
export function findKeys(obj: unknown, keys: string[], path = '$'): string[] {
  if (Array.isArray(obj)) return obj.flatMap((v, i) => findKeys(v, keys, `${path}[${i}]`));
  if (obj && typeof obj === 'object') {
    return Object.entries(obj).flatMap(([k, v]) => [...(keys.includes(k) ? [`${path}.${k}`] : []), ...findKeys(v, keys, `${path}.${k}`)]);
  }
  return [];
}
export const HIDDEN_KEYS = ['authenticity', 'grade', 'origin', 'condition', 'mindPrice', 'mind_price', 'undercover', 'misprint'];

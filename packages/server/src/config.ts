// 读环境变量（SRS 第 10 节）。根目录的 .env 在启动时加载，不进 git。
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export interface Config {
  port: number;
  host: string;
  clientId: string | null;
  clientSecret: string | null;
  guildId: string | null;
  sessionSecret: string;
  devAuth: boolean;
  disabled: boolean;
  dbPath: string;
  wallet: { mode: 'mock' | 'live'; port: number | null; secret: string | null; mockCoins: number };
  clientDist: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const devAuth = env.DEV_AUTH === '1';
  const sessionSecret = env.SESSION_SECRET || (devAuth ? 'dev-only-secret' : '');
  if (!sessionSecret) throw new Error('缺 SESSION_SECRET（本机开发可以设 DEV_AUTH=1）');
  const mode = env.WALLET_MODE === 'live' ? 'live' : 'mock';
  return {
    port: Number(env.PORT || 4790),
    host: env.HOST || '127.0.0.1',
    clientId: env.DISCORD_CLIENT_ID || null,
    clientSecret: env.DISCORD_CLIENT_SECRET || null,
    guildId: env.GUILD_ID || null,
    sessionSecret,
    devAuth,
    disabled: env.KANU_DISABLED === '1',
    dbPath: path.resolve(ROOT, env.DB_PATH || './data/kanu.sqlite'),
    wallet: {
      mode,
      port: env.WANGCAI_CONTROL_PORT ? Number(env.WANGCAI_CONTROL_PORT) : null,
      secret: env.WANGCAI_CONTROL_SECRET || null,
      mockCoins: Number(env.DEV_WALLET_COINS ?? 500),
    },
    clientDist: path.resolve(ROOT, 'packages', 'client', 'dist'),
  };
}

export function loadEnvFile(): void {
  try {
    process.loadEnvFile(path.join(ROOT, '.env'));
  } catch {
    // 没有 .env 就用系统环境变量
  }
}

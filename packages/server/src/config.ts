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
  /** 本机测试用：把服务器时钟往后拨多少毫秒（只在 DEV_AUTH=1 时生效，比如半夜测柜台） */
  devTimeOffsetMs: number;
  /** 本机测试用：这些 Discord ID 开包不扣信用点、不限购（只在 DEV_AUTH=1 时生效，正式环境不开 DEV_AUTH 就自动失效） */
  devUnlimitedIds: Set<string>;
  dbPath: string;
  wallet: { mode: 'mock' | 'live'; port: number | null; secret: string | null; mockCoins: number };
  clientDist: string;
  botToken: string | null;
  announceChannelId: string | null;
  /** 正规卡包开哪个系列（content/series 里的 id） */
  currentSeries: string;
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
    devTimeOffsetMs: devAuth ? Number(env.DEV_TIME_OFFSET_HOURS || 0) * 3600e3 : 0,
    devUnlimitedIds: new Set(devAuth ? String(env.DEV_UNLIMITED_IDS || '').split(',').map((s) => s.trim()).filter(Boolean) : []),
    dbPath: path.resolve(ROOT, env.DB_PATH || './data/kanu.sqlite'),
    wallet: {
      mode,
      port: env.WANGCAI_CONTROL_PORT ? Number(env.WANGCAI_CONTROL_PORT) : null,
      secret: env.WANGCAI_CONTROL_SECRET || null,
      mockCoins: Number(env.DEV_WALLET_COINS ?? 500),
    },
    clientDist: path.resolve(ROOT, 'packages', 'client', 'dist'),
    botToken: env.DISCORD_BOT_TOKEN || null,
    announceChannelId: env.ANNOUNCE_CHANNEL_ID || null,
    currentSeries: env.CURRENT_SERIES || 'NEO',
  };
}

export function loadEnvFile(): void {
  try {
    process.loadEnvFile(path.join(ROOT, '.env'));
  } catch {
    // 没有 .env 就用系统环境变量
  }
}

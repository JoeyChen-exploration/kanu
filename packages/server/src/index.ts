// 卡奴服务器入口。
import { IDEMPOTENCY } from '@kanu/shared/balance';
import { loadConfig, loadEnvFile } from './config.ts';
import { openDb } from './db/index.ts';
import { createSessionCodec } from './auth/session.ts';
import { createDiscordAuth } from './auth/discord.ts';
import { createWalletClient } from './wallet/client.ts';
import { createDiscordNotifier } from './notify/discord.ts';
import { importAllSeries } from './content.ts';
import { cryptoRng } from './rng.ts';
import { buildApp } from './app.ts';

loadEnvFile();
const config = loadConfig();
const repo = openDb(config.dbPath);
const series = importAllSeries(repo);
if (!series.includes(config.currentSeries)) throw new Error(`CURRENT_SERIES=${config.currentSeries} 不在已导入的系列里（${series.join(', ')}）`);

const app = buildApp({
  config,
  repo,
  sessions: createSessionCodec(config.sessionSecret),
  discord: createDiscordAuth(config),
  wallet: createWalletClient(config.wallet),
  rng: cryptoRng,
  notifier: createDiscordNotifier({ botToken: config.botToken, channelId: config.announceChannelId }),
  currentSeries: config.currentSeries,
});

// 幂等记录只留 48 小时（SRS 第 5 节）。正式的定时任务框架在 M5 做，这里先每小时清一次
const pruneTimer = setInterval(() => repo.pruneIdempotency(Date.now() - IDEMPOTENCY.ttlMs), 3600e3);
pruneTimer.unref();

const shutdown = async () => {
  await app.close();
  repo.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: config.port, host: config.host });
app.log.info(`kanu listening on http://${config.host}:${config.port} wallet=${config.wallet.mode} devAuth=${config.devAuth} series=${series.join(',')}`);

// 卡奴服务器入口。
import { BACKUP, EXCHANGE, IDEMPOTENCY } from '@kanu/shared/balance';
import { loadConfig, loadEnvFile } from './config.ts';
import { openDb } from './db/index.ts';
import { createSessionCodec } from './auth/session.ts';
import { createDiscordAuth } from './auth/discord.ts';
import { createWalletClient } from './wallet/client.ts';
import { createDiscordNotifier } from './notify/discord.ts';
import { importAllSeries } from './content.ts';
import { cryptoRng } from './rng.ts';
import { buildApp } from './app.ts';
import { retryPendingExchanges } from './routes/exchange.ts';
import { runBackup } from './backup.ts';

loadEnvFile();
const config = loadConfig();
const repo = openDb(config.dbPath);
const series = importAllSeries(repo);
if (!series.includes(config.currentSeries)) throw new Error(`CURRENT_SERIES=${config.currentSeries} 不在已导入的系列里（${series.join(', ')}）`);

const wallet = createWalletClient(config.wallet);
const app = buildApp({
  config,
  repo,
  sessions: createSessionCodec(config.sessionSecret),
  discord: createDiscordAuth(config),
  wallet,
  rng: cryptoRng,
  notifier: createDiscordNotifier({ botToken: config.botToken, channelId: config.announceChannelId }),
  currentSeries: config.currentSeries,
  now: () => Date.now() + config.devTimeOffsetMs,
});
if (config.devTimeOffsetMs) app.log.warn(`开发时钟偏移 ${config.devTimeOffsetMs / 3600e3} 小时（DEV_TIME_OFFSET_HOURS）`);

// 幂等记录只留 48 小时（SRS 第 5 节）。正式的定时任务框架在 M5 做，这里先每小时清一次
const pruneTimer = setInterval(() => repo.pruneIdempotency(Date.now() - IDEMPOTENCY.ttlMs), 3600e3);
pruneTimer.unref();

// 金币兑换：pending 的兑换单每 EXCHANGE.retryMinutes 分钟用同一个 key 重试（FR-EXCH-4），启动时先补一次
const deps = { config, repo, wallet } as unknown as Parameters<typeof retryPendingExchanges>[0];
const retryExchanges = () => retryPendingExchanges(deps, Date.now() + config.devTimeOffsetMs, { error: (m) => app.log.error(m) })
  .catch((e: Error) => app.log.error(`[exchange] 重试失败：${e.message}`));
const exchangeTimer = setInterval(retryExchanges, EXCHANGE.retryMinutes * 60e3);
exchangeTimer.unref();

const shutdown = async () => {
  await app.close();
  repo.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: config.port, host: config.host });
void retryExchanges();

// 数据库备份（M7）：启动时一次，之后每 BACKUP.everyHours 小时一次
const backup = () => runBackup(repo, config.backupDir, Date.now())
  .then((r) => app.log.info(`[backup] ${r.file}${r.removed.length ? `，清掉旧备份 ${r.removed.length} 份` : ''}`))
  .catch((e: Error) => app.log.error(`[backup] 备份失败：${e.message}`));
const backupTimer = setInterval(backup, BACKUP.everyHours * 3600e3);
backupTimer.unref();
void backup();
app.log.info(`kanu listening on http://${config.host}:${config.port} wallet=${config.wallet.mode} devAuth=${config.devAuth} series=${series.join(',')}`);

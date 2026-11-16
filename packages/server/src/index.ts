// 卡奴服务器入口。
import { loadConfig, loadEnvFile } from './config.ts';
import { openDb } from './db/index.ts';
import { createSessionCodec } from './auth/session.ts';
import { createDiscordAuth } from './auth/discord.ts';
import { createWalletClient } from './wallet/client.ts';
import { buildApp } from './app.ts';

loadEnvFile();
const config = loadConfig();
const repo = openDb(config.dbPath);
const app = buildApp({
  config,
  repo,
  sessions: createSessionCodec(config.sessionSecret),
  discord: createDiscordAuth(config),
  wallet: createWalletClient(config.wallet),
});

const shutdown = async () => {
  await app.close();
  repo.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: config.port, host: config.host });
app.log.info(`kanu listening on http://${config.host}:${config.port} wallet=${config.wallet.mode} devAuth=${config.devAuth}`);

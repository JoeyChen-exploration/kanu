// 组装 Fastify 应用。依赖全部从外面传进来，测试可以换成假的。
import fs from 'node:fs';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { ApiError as ApiErrorBody, SessionUser } from '@kanu/shared/types';
import type { Config } from './config.ts';
import type { Repo } from './db/index.ts';
import type { SessionCodec } from './auth/session.ts';
import type { DiscordAuth } from './auth/discord.ts';
import type { WalletClient } from './wallet/client.ts';
import type { Rng } from './game/rng.ts';
import type { Notifier } from './notify/discord.ts';
import { registerAuthRoutes } from './routes/auth.ts';
import { registerMeRoutes } from './routes/me.ts';
import { registerPackRoutes } from './routes/packs.ts';
import { registerInventoryRoutes } from './routes/inventory.ts';
import { registerCounterRoutes } from './routes/counter.ts';
import { registerBinderRoutes } from './routes/binders.ts';
import { registerShowcaseRoutes } from './routes/showcase.ts';
import { registerQuestRoutes } from './routes/quests.ts';
import { registerAppraisalRoutes } from './routes/appraisal.ts';
import { registerTechRoutes } from './routes/tech.ts';
import { registerRentRoutes } from './routes/rent.ts';
import { registerExchangeRoutes } from './routes/exchange.ts';
import { registerAdminRoutes } from './routes/admin.ts';
import { registerPoliceRoutes } from './routes/police.ts';
import { registerFactionRoutes } from './routes/factions.ts';
import { registerNewsRoutes } from './routes/news.ts';
import { newsTick } from './news.ts';
import { createBinderService, type BinderService } from './binders.ts';

export interface Deps {
  config: Config;
  repo: Repo;
  sessions: SessionCodec;
  discord: DiscordAuth;
  wallet: WalletClient;
  /** 线上传 cryptoRng，测试传 seeded */
  rng: Rng;
  notifier: Notifier;
  /** 正规卡包开哪个系列 */
  currentSeries: string;
  now?: () => number;
  /** 空间站日报（DESIGN 8.2）：传了才会到点自动发新闻（线上传 cryptoRng；测试默认不开，免得打乱别的测试） */
  news?: { rng: Rng } | false;
  /** 卡册服务；不传就由 buildApp 用 repo 和 rng 建一个 */
  binders?: BinderService;
}

export const fail = (reply: FastifyReply, status: number, code: string, message: string) =>
  reply.code(status).send({ ok: false, code, message } satisfies ApiErrorBody);

/** 业务规则拒绝：在事务里抛出，事务回滚，路由按 status 回给玩家（message 是给玩家看的中文） */
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

/** 写接口的幂等 key（NFR-SEC-5）：前端每次点击生成一个 UUID 放在 Idempotency-Key 请求头 */
export function idempotencyKey(req: FastifyRequest): string | null {
  const k = req.headers['idempotency-key'];
  return typeof k === 'string' && k.length >= 8 && k.length <= 100 ? k : null;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
  }
}

export function buildApp(input: Deps) {
  const deps: Deps = { ...input, binders: input.binders ?? createBinderService(input.repo, input.rng) };
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL || 'info' } });
  const now = deps.now ?? Date.now;

  // 只认会话 token 里的用户 id（FR-AUTH-4）
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (req: FastifyRequest) => {
    const h = req.headers.authorization;
    req.user = h?.startsWith('Bearer ') ? deps.sessions.verify(h.slice(7), now()) : null;
  });

  // 空间站日报：到点发新闻、换日刷新新闻效果（市场价、顾客、巡查都读缓存）
  app.addHook('onRequest', async () => { newsTick(deps, now()); });

  // 维护开关（NFR-MAINT-3）：写接口一律 503
  app.addHook('onRequest', async (req, reply) => {
    if (deps.config.disabled && req.method !== 'GET' && req.url.startsWith('/api/') && req.url !== '/api/auth/token') {
      return fail(reply, 503, 'maintenance', '卡奴维护中，稍后再来');
    }
  });

  // 写接口限流（NFR-SEC-4）：每个玩家 1 秒内最多 rateLimitPerSecond 次写请求，超过回 429。按真实时钟算（不受开发时钟偏移影响）
  const recent = new Map<string, number[]>();
  app.addHook('preHandler', async (req, reply) => {
    const limit = deps.config.rateLimitPerSecond;
    if (!limit || !req.user || req.method === 'GET' || !req.url.startsWith('/api/')) return;
    const t = Date.now();
    const hits = (recent.get(req.user.id) ?? []).filter((x) => t - x < 1000);
    if (hits.length >= limit) return fail(reply, 429, 'rate_limited', '点得太快了，歇一下再试');
    hits.push(t);
    recent.set(req.user.id, hits);
    if (recent.size > 5000) for (const [k, v] of recent) if (!v.some((x) => t - x < 1000)) recent.delete(k);
  });

  app.get('/api/config', async () => ({
    ok: true as const,
    clientId: deps.config.clientId,
    devAuth: deps.config.devAuth,
    disabled: deps.config.disabled,
  }));
  app.get('/api/health', async () => ({ ok: true }));

  registerAuthRoutes(app, deps, now);
  registerMeRoutes(app, deps, now);
  registerPackRoutes(app, deps, now);
  registerInventoryRoutes(app, deps);
  registerCounterRoutes(app, deps, now);
  registerBinderRoutes(app, deps, now);
  registerShowcaseRoutes(app, deps, now);
  registerQuestRoutes(app, deps, now);
  registerAppraisalRoutes(app, deps, now);
  registerTechRoutes(app, deps, now);
  registerRentRoutes(app, deps, now);
  registerExchangeRoutes(app, deps, now);
  registerAdminRoutes(app, deps, now);
  registerPoliceRoutes(app, deps, now);
  registerFactionRoutes(app, deps, now);
  registerNewsRoutes(app, deps, now);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) return fail(reply, err.status, err.code, err.message);
    req.log.error(err);
    // 不把内部错误细节发给玩家（NFR-SEC-2：调试字段也可能带隐藏属性）
    return fail(reply, (err as { statusCode?: number }).statusCode === 400 ? 400 : 500, 'internal', '出错了，稍后再试');
  });

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return fail(reply, 404, 'not_found', '没有这个接口');
    // 生产：前端构建产物由本服务器托管（C-1）；开发时走 Vite，不会到这里
    if (fs.existsSync(deps.config.clientDist)) return reply.sendFile('index.html');
    return fail(reply, 404, 'not_found', '前端还没构建');
  });
  if (fs.existsSync(deps.config.clientDist)) {
    app.register(fastifyStatic, { root: deps.config.clientDist });
  }

  return app;
}

// 组装 Fastify 应用。依赖全部从外面传进来，测试可以换成假的。
import fs from 'node:fs';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { ApiError, SessionUser } from '@kanu/shared/types';
import type { Config } from './config.ts';
import type { Repo } from './db/index.ts';
import type { SessionCodec } from './auth/session.ts';
import type { DiscordAuth } from './auth/discord.ts';
import type { WalletClient } from './wallet/client.ts';
import { registerAuthRoutes } from './routes/auth.ts';
import { registerMeRoutes } from './routes/me.ts';

export interface Deps {
  config: Config;
  repo: Repo;
  sessions: SessionCodec;
  discord: DiscordAuth;
  wallet: WalletClient;
  now?: () => number;
}

export const fail = (reply: FastifyReply, status: number, code: string, message: string) =>
  reply.code(status).send({ ok: false, code, message } satisfies ApiError);

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
  }
}

export function buildApp(deps: Deps) {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL || 'info' } });
  const now = deps.now ?? Date.now;

  // 只认会话 token 里的用户 id（FR-AUTH-4）
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (req: FastifyRequest) => {
    const h = req.headers.authorization;
    req.user = h?.startsWith('Bearer ') ? deps.sessions.verify(h.slice(7), now()) : null;
  });

  // 维护开关（NFR-MAINT-3）：写接口一律 503
  app.addHook('onRequest', async (req, reply) => {
    if (deps.config.disabled && req.method !== 'GET' && req.url.startsWith('/api/') && req.url !== '/api/auth/token') {
      return fail(reply, 503, 'maintenance', '卡奴维护中，稍后再来');
    }
  });

  app.get('/api/config', async () => ({
    ok: true as const,
    clientId: deps.config.clientId,
    devAuth: deps.config.devAuth,
    disabled: deps.config.disabled,
  }));
  app.get('/api/health', async () => ({ ok: true }));

  registerAuthRoutes(app, deps, now);
  registerMeRoutes(app, deps);

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

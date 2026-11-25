// 管理（FR-ADMIN，M7 内测）：只给 ADMIN_USER_IDS 里的人用，其他人一律 403。
// 这里的响应会带卡牌的隐藏属性（真伪、真实品相、来源、错版），FR-ADMIN-3 要求的；玩家接口绝不能调这里的查询。
//   GET  /api/admin/players?q=           按 Discord ID 或名字找玩家
//   GET  /api/admin/players/:id          玩家详情：信用点、房租、库存（含隐藏属性）、最近 100 条日志
//   POST /api/admin/grant                发信用点（可正可负）或指定卡，必须写原因（幂等，写日志）
//   POST /api/admin/players/:id/day      跳到第几个营业日（内测快速测房租用，FR-ADMIN-5 的"缩短一周"）
//   POST /api/admin/reload-content       重新导入 content/series/*.json 的卡牌模板（FR-ADMIN-4）
//   GET  /api/admin/exchanges?status=    兑换单
//   POST /api/admin/exchanges/:id/retry  用同一个 key 再调一次旺财（报过警的也能手动重试）
//   POST /api/admin/exchanges/:id/close  {outcome: 'done' | 'refund', reason}  人工关单：核实到账了 / 核实没到账、退信用点
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { STYLES, type Style } from '@kanu/shared/balance';
import { ApiError, fail, idempotencyKey, type Deps } from '../app.ts';
import { importAllSeries } from '../content.ts';
import { applyRedeem, redeemKey } from './exchange.ts';
import { rentStatus } from '../day.ts';

const GRADES = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'BL'];

export const isAdmin = (deps: Deps, userId: string | undefined | null) => !!userId && deps.config.adminUserIds.has(userId);

export function registerAdminRoutes(app: FastifyInstance, deps: Deps, now: () => number) {
  const { repo } = deps;

  /** 管理员才能过；不是管理员一律 403，不透露接口存在与否以外的信息 */
  const guard = (req: FastifyRequest, reply: FastifyReply): string | null => {
    if (!req.user) { fail(reply, 401, 'unauthorized', '请重新打开卡奴登录'); return null; }
    if (!isAdmin(deps, req.user.id)) { fail(reply, 403, 'forbidden', '只有管理员能用'); return null; }
    return req.user.id;
  };

  app.get<{ Querystring: { q?: string } }>('/api/admin/players', async (req, reply) => {
    if (!guard(req, reply)) return reply;
    const q = String(req.query.q ?? '').trim();
    return { ok: true, players: q ? repo.adminSearchPlayers(q) : repo.adminSearchPlayers('') };
  });

  app.get<{ Params: { id: string } }>('/api/admin/players/:id', async (req, reply) => {
    if (!guard(req, reply)) return reply;
    const p = repo.getPlayer(req.params.id);
    if (!p) return fail(reply, 404, 'not_found', '没有这个玩家');
    return {
      ok: true,
      player: { id: p.discord_id, name: p.display_name, credits: p.credits, reputation: p.reputation, gameDay: p.game_day, runStartDay: p.run_start_day, blueprints: p.blueprints },
      rent: rentStatus(deps, p.discord_id),
      cards: repo.adminCards(p.discord_id),
      sealed: repo.sealedByOwner(p.discord_id).length,
      events: repo.adminEvents(p.discord_id),
    };
  });

  app.post<{ Body: { userId?: string; credits?: number; templateId?: string; style?: string; grade?: string; authenticity?: string; count?: number; reason?: string } }>('/api/admin/grant', async (req, reply) => {
    const adminId = guard(req, reply);
    if (!adminId) return reply;
    const key = idempotencyKey(req);
    if (!key) return fail(reply, 400, 'missing_idempotency_key', '请求缺少幂等 key，请刷新后再试');
    const b = req.body ?? {};
    return repo.db.transaction(() => {
      const replay = repo.getIdempotent<Record<string, unknown>>(adminId, key);
      if (replay) return replay;
      const t = now();
      const reason = String(b.reason ?? '').trim();
      if (!reason) throw new ApiError(400, 'reason', '要写原因');
      const p = repo.getPlayer(String(b.userId ?? ''));
      if (!p) throw new ApiError(404, 'not_found', '没有这个玩家');
      const out: { ok: true; credits: number; cardIds: number[] } = { ok: true, credits: p.credits, cardIds: [] };
      if (b.credits !== undefined && b.credits !== 0) {
        if (!Number.isInteger(b.credits)) throw new ApiError(400, 'bad_credits', '信用点要是整数');
        const credits = p.credits + b.credits;
        if (credits < 0) throw new ApiError(400, 'bad_credits', `扣完会变负数（现在 ${p.credits}）`);
        repo.setCreditsPity(p.discord_id, credits, p.pity_count);
        repo.logCredits(p.discord_id, t, b.credits, 'admin', credits, { admin: adminId, reason });
        out.credits = credits;
      }
      if (b.templateId) {
        const count = b.count ?? 1;
        if (!Number.isInteger(count) || count < 1 || count > 50) throw new ApiError(400, 'bad_count', '一次发 1～50 张');
        if (!repo.allTemplates().some((x) => x.id === b.templateId)) throw new ApiError(400, 'bad_template', `没有卡 ${b.templateId}`);
        const style = (b.style ?? 'standard') as Style;
        if (!STYLES.includes(style)) throw new ApiError(400, 'bad_style', `风格只能是 ${STYLES.join(' ')}`);
        const grade = String(b.grade ?? '9');
        if (!GRADES.includes(grade)) throw new ApiError(400, 'bad_grade', '品相是 1～10 或 BL');
        const authenticity = b.authenticity ?? 'real';
        if (!['real', 'low_fake', 'high_fake'].includes(authenticity)) throw new ApiError(400, 'bad_auth', '真伪是 real / low_fake / high_fake');
        for (let i = 0; i < count; i += 1) {
          out.cardIds.push(repo.insertCard({ templateId: b.templateId, ownerId: p.discord_id, authenticity, grade, origin: 'legit', style, serialNo: null, now: t, collect: authenticity === 'real' }));
        }
        deps.binders!.placeNew(p.discord_id, out.cardIds, p.game_day);
      }
      if (!out.cardIds.length && out.credits === p.credits) throw new ApiError(400, 'nothing', '没有要发的东西');
      repo.logEvent(p.discord_id, t, 'admin_grant', { admin: adminId, reason, credits: b.credits ?? 0, templateId: b.templateId ?? null, cards: out.cardIds });
      repo.putIdempotent(adminId, key, out, t);
      return out;
    })();
  });

  app.post<{ Params: { id: string }; Body: { day?: number; reason?: string } }>('/api/admin/players/:id/day', async (req, reply) => {
    const adminId = guard(req, reply);
    if (!adminId) return reply;
    const p = repo.getPlayer(req.params.id);
    if (!p) return fail(reply, 404, 'not_found', '没有这个玩家');
    const day = req.body?.day;
    if (typeof day !== 'number' || !Number.isInteger(day) || day < p.run_start_day) return fail(reply, 400, 'bad_day', `营业日要是整数，不能早于这一轮的第一天（${p.run_start_day}）`);
    repo.adminSetDay(p.discord_id, day);
    repo.logEvent(p.discord_id, now(), 'admin_set_day', { admin: adminId, from: p.game_day, to: day, reason: req.body?.reason ?? '' });
    return { ok: true, day };
  });

  app.post('/api/admin/reload-content', async (req, reply) => {
    const adminId = guard(req, reply);
    if (!adminId) return reply;
    try {
      const series = repo.db.transaction(() => importAllSeries(repo))();
      repo.logEvent(null, now(), 'admin_reload_content', { admin: adminId, series });
      return { ok: true, series, templates: repo.allTemplates().length };
    } catch (e) {
      return fail(reply, 400, 'bad_content', (e as Error).message);
    }
  });

  app.get<{ Querystring: { status?: string } }>('/api/admin/exchanges', async (req, reply) => {
    if (!guard(req, reply)) return reply;
    return { ok: true, exchanges: repo.adminExchanges(req.query.status ?? null).map((r) => ({ ...r, key: redeemKey(r) })) };
  });

  app.post<{ Params: { id: string } }>('/api/admin/exchanges/:id/retry', async (req, reply) => {
    const adminId = guard(req, reply);
    if (!adminId) return reply;
    const row = repo.getExchange(Number.parseInt(req.params.id, 10));
    if (!row) return fail(reply, 404, 'not_found', '没有这张兑换单');
    if (row.status !== 'pending') return fail(reply, 400, 'closed', `这张单子已经是 ${row.status}`);
    const result = await deps.wallet.redeem({ key: redeemKey(row), userId: row.owner_id, coins: row.coins, week: row.week });
    repo.logEvent(row.owner_id, now(), 'admin_exchange_retry', { admin: adminId, exchange: row.id, result: result.kind });
    return { ok: true, result, exchange: applyRedeem(deps, row.id, result, now()) };
  });

  app.post<{ Params: { id: string }; Body: { outcome?: string; reason?: string } }>('/api/admin/exchanges/:id/close', async (req, reply) => {
    const adminId = guard(req, reply);
    if (!adminId) return reply;
    const outcome = req.body?.outcome;
    const reason = String(req.body?.reason ?? '').trim();
    if (outcome !== 'done' && outcome !== 'refund') return fail(reply, 400, 'bad_outcome', 'outcome 是 done（核实到账了）或 refund（核实没到账，退信用点）');
    if (!reason) return fail(reply, 400, 'reason', '要写原因（比如核实了旺财流水）');
    const id = Number.parseInt(req.params.id, 10);
    return repo.db.transaction(() => {
      const row = repo.getExchange(id);
      if (!row) throw new ApiError(404, 'not_found', '没有这张兑换单');
      if (row.status !== 'pending') throw new ApiError(400, 'closed', `这张单子已经是 ${row.status}`);
      const t = now();
      if (outcome === 'done') {
        repo.setExchange(id, { status: 'done', error: null, now: t });
      } else {
        const p = repo.getPlayer(row.owner_id)!;
        const credits = p.credits + row.credits;
        repo.setCreditsPity(row.owner_id, credits, p.pity_count);
        repo.logCredits(row.owner_id, t, row.credits, 'exchange_refund', credits, { exchange: id, admin: adminId, reason });
        repo.setExchange(id, { status: 'failed', error: `管理员关单：${reason}`, now: t });
      }
      repo.logEvent(row.owner_id, t, 'admin_exchange_close', { admin: adminId, exchange: id, outcome, reason });
      return { ok: true, exchange: repo.getExchange(id) };
    })();
  });
}

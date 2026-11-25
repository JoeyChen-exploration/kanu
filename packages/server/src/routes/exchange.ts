// 金币兑换（DESIGN 11，FR-EXCH-1～4，SRS 6.3）：信用点单向换旺财金币。
//   GET  /api/exchange           汇率、本周额度、能兑多少、最近的兑换单、金币余额
//   POST /api/exchange { coins } 兑换（幂等）
// 流程：一个事务里检查额度和租金保证金 → 扣信用点 → 插 pending 兑换单；再调旺财 /wallet/cardshop-redeem（key = 兑换单）：
//   ok → done；明确拒绝 → 一个事务里退信用点、failed；超时 / 连不上 / 404 / 5xx → 保持 pending，不退，
//   每 EXCHANGE.retryMinutes 分钟用同一个 key 重试；超过 alertHours 还是 pending 就报警、停止自动重试，由管理员处理。
import type { FastifyInstance } from 'fastify';
import { EXCHANGE } from '@kanu/shared/balance';
import type { ExchangeOrderResponse, ExchangeResponse, ExchangeView } from '@kanu/shared/types';
import { ApiError, fail, idempotencyKey, type Deps } from '../app.ts';
import type { ExchangeRow } from '../db/index.ts';
import type { RedeemResult } from '../wallet/client.ts';
import { addDays, sydneyWeek } from '../time.ts';
import { rentStatus } from '../day.ts';

const toView = (r: ExchangeRow): ExchangeView => ({ id: r.id, credits: r.credits, coins: r.coins, status: r.status, error: r.status === 'failed' ? r.error : null, createdAt: r.created_at });
/** 旺财那边的幂等 key：兑换单 id + 建单时间（卡奴的库就算重建，id 重复了也不会撞上旺财记着的旧 key） */
export const redeemKey = (r: ExchangeRow) => `cardshop:${r.id}-${r.created_at}`;

/** 本周额度、租金保证金、这次最多能兑多少 */
function limits(deps: Deps, userId: string, now: number) {
  const player = deps.repo.getPlayer(userId)!;
  const week = sydneyWeek(now);
  const weekUsed = deps.repo.weekCoins(userId, week);
  const weekLeft = Math.max(0, EXCHANGE.weeklyCapCoins - weekUsed);
  const rent = rentStatus(deps, userId);
  const arrears = rent.arrears !== null;
  const reserve = rent.owned ? 0 : (rent.next?.amount ?? 0);
  const spendable = Math.max(0, player.credits - reserve);
  const maxCoins = arrears ? 0 : Math.min(weekLeft, Math.floor(spendable / EXCHANGE.creditsPerCoin));
  return { player, week, weekUsed, weekLeft, reserve, arrears, maxCoins };
}

/** 按旺财的结论处理兑换单（只处理还在 pending 的，重复调用不会重复退钱） */
export function applyRedeem(deps: Deps, id: number, result: RedeemResult, now: number): ExchangeRow {
  const { repo } = deps;
  return repo.db.transaction((): ExchangeRow => {
    const row = repo.getExchange(id)!;
    if (row.status !== 'pending') return row;
    if (result.kind === 'ok') {
      repo.setExchange(id, { status: 'done', error: null, now, attempt: true });
      repo.logEvent(row.owner_id, now, 'exchange_done', { exchange: id, coins: row.coins, replay: result.replay });
    } else if (result.kind === 'rejected') {
      const player = repo.getPlayer(row.owner_id)!;
      const credits = player.credits + row.credits;
      repo.setCreditsPity(row.owner_id, credits, player.pity_count);
      repo.logCredits(row.owner_id, now, row.credits, 'exchange_refund', credits, { exchange: id, error: result.error });
      repo.setExchange(id, { status: 'failed', error: result.error, now, attempt: true });
    } else {
      repo.setExchange(id, { status: 'pending', error: result.reason, now, attempt: true });
      repo.logEvent(row.owner_id, now, 'exchange_retry', { exchange: id, reason: result.reason });
    }
    return repo.getExchange(id)!;
  })();
}

/** 定时任务：pending 的兑换单用同一个 key 重试；超过 alertHours 报警、停止自动重试 */
export async function retryPendingExchanges(deps: Deps, now: number, log: { error: (msg: string) => void } = console) {
  for (const row of deps.repo.pendingExchanges()) {
    if (now - row.created_at > EXCHANGE.alertHours * 3600e3) {
      deps.repo.setExchange(row.id, { status: 'pending', error: row.error, now, alerted: true });
      deps.repo.logEvent(row.owner_id, now, 'exchange_alert', { exchange: row.id, coins: row.coins, credits: row.credits, attempts: row.attempts, lastError: row.error });
      log.error(`[exchange] 兑换单 ${row.id}（${row.owner_id}，${row.coins} 金币）超过 ${EXCHANGE.alertHours} 小时还没到账，已停止自动重试，请管理员处理（旺财只记得 key 48 小时）：${row.error ?? ''}`);
      continue;
    }
    const result = await deps.wallet.redeem({ key: redeemKey(row), userId: row.owner_id, coins: row.coins, week: row.week });
    applyRedeem(deps, row.id, result, now);
  }
}

export function registerExchangeRoutes(app: FastifyInstance, deps: Deps, now: () => number) {
  const { repo } = deps;

  app.get('/api/exchange', async (req, reply) => {
    if (!req.user) return fail(reply, 401, 'unauthorized', '请重新打开卡奴登录');
    const userId = req.user.id;
    if (!repo.getPlayer(userId)) return fail(reply, 401, 'unauthorized', '请重新打开卡奴登录');
    const l = limits(deps, userId, now());
    const response: ExchangeResponse = {
      ok: true, rate: EXCHANGE.creditsPerCoin, weeklyCap: EXCHANGE.weeklyCapCoins, weekUsed: l.weekUsed, weekLeft: l.weekLeft,
      resetDay: addDays(l.week, 7), credits: l.player.credits, reserve: l.reserve, arrears: l.arrears, maxCoins: l.maxCoins,
      wallet: await deps.wallet.balance(userId), orders: repo.recentExchanges(userId).map(toView),
    };
    return response;
  });

  app.post<{ Body: { coins?: number } }>('/api/exchange', async (req, reply) => {
    if (!req.user) return fail(reply, 401, 'unauthorized', '请重新打开卡奴登录');
    const key = idempotencyKey(req);
    if (!key) return fail(reply, 400, 'missing_idempotency_key', '请求缺少幂等 key，请刷新后再试');
    const userId = req.user.id;
    const coins = req.body?.coins;
    // 第一步（一个事务）：检查 → 扣信用点 → 插 pending 兑换单。幂等记录只记兑换单 id，重放时按兑换单现在的状态回
    const created = repo.db.transaction((): { orderId: number; replay: boolean } => {
      const replay = repo.getIdempotent<{ orderId: number }>(userId, key);
      if (replay) return { orderId: replay.orderId, replay: true };
      const t = now();
      if (!repo.getPlayer(userId)) throw new ApiError(401, 'unauthorized', '请重新打开卡奴登录');
      const l = limits(deps, userId, t);
      if (l.arrears) throw new ApiError(400, 'arrears', '欠租中不能兑换，先把摊位费交了');
      if (typeof coins !== 'number' || !Number.isInteger(coins) || coins <= 0) throw new ApiError(400, 'bad_coins', '金币数要是正整数');
      if (coins > l.weekLeft) throw new ApiError(400, 'weekly_cap', `本周最多还能兑 ${l.weekLeft} 金币（每周 ${EXCHANGE.weeklyCapCoins}，悉尼周一 00:00 重置）`);
      if (coins > l.maxCoins) throw new ApiError(400, 'rent_reserve', `下次摊位费 ${l.reserve} 要留着：现在最多能兑 ${l.maxCoins} 金币`);
      const cost = coins * EXCHANGE.creditsPerCoin;
      const credits = l.player.credits - cost;
      repo.setCreditsPity(userId, credits, l.player.pity_count);
      const orderId = repo.insertExchange({ ownerId: userId, credits: cost, coins, week: l.week, now: t });
      repo.logCredits(userId, t, -cost, 'exchange', credits, { exchange: orderId, coins });
      repo.putIdempotent(userId, key, { orderId }, t);
      return { orderId, replay: false };
    })();
    // 第二步：调旺财（事务外）。重放时如果还是 pending 也顺手再试一次（同一个 key，旺财不会重复入账）
    let row = repo.getExchange(created.orderId)!;
    if (row.status === 'pending' && !row.alerted) {
      const result = await deps.wallet.redeem({ key: redeemKey(row), userId, coins: row.coins, week: row.week });
      row = applyRedeem(deps, row.id, result, now());
    }
    const response: ExchangeOrderResponse = { ok: true, credits: repo.getPlayer(userId)!.credits, order: toView(row) };
    return response;
  });
}

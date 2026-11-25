// 调旺财 /wallet/* 的客户端（SRS 6.3）。不 import 旺财的任何代码，只走 HTTP。
// mock：本机开发用，返回固定余额；兑换在内存里模拟旺财的幂等和每周上限，不碰任何真钱包。
// live：GET /wallet/<discordId>、POST /wallet/cardshop-redeem，http://127.0.0.1:<WANGCAI_CONTROL_PORT>，Bearer secret。
// 联调时用旺财的 `node scripts/wallet-flow-drill.mjs --serve` 起一个本地 control-server，不要连生产钱包。
import { EXCHANGE } from '@kanu/shared/balance';
import type { WalletView } from '@kanu/shared/types';

/**
 * 兑换结果（FR-EXCH-4）：
 *   ok       旺财入账了（含 replay：同一个 key 之前已经入过）
 *   rejected 旺财明确拒绝（HTTP 200 + ok: false）：退信用点
 *   unknown  超时、连不上、401 / 404 / 5xx：不知道到没到账，兑换单保持 pending，之后用同一个 key 重试
 */
export type RedeemResult =
  | { kind: 'ok'; replay: boolean; bal: number | null }
  | { kind: 'rejected'; error: string }
  | { kind: 'unknown'; reason: string };

export interface WalletClient {
  mode: 'mock' | 'live';
  /** 只读，用于首页显示；失败时返回 coins: null，不抛错（FR-AUTH-7） */
  balance(discordId: string): Promise<WalletView>;
  /** 信用点换金币入账（卡奴已经扣好信用点）；key = cardshop:<兑换单 id>，重试必须用同一个 key */
  redeem(req: { key: string; userId: string; coins: number; week: string }): Promise<RedeemResult>;
}

export function createWalletClient(opts: {
  mode: 'mock' | 'live';
  port: number | null;
  secret: string | null;
  mockCoins: number;
  fetchImpl?: typeof fetch;
}): WalletClient {
  if (opts.mode === 'mock') {
    // 模拟旺财：同一个 key 只入账一次（连拒绝也记住），每人每周上限
    const seen = new Map<string, RedeemResult>();
    const weekly = new Map<string, number>();
    const bal = new Map<string, number>();
    return {
      mode: 'mock',
      balance: async (id) => ({ coins: bal.get(id) ?? opts.mockCoins, opened: true }),
      async redeem({ key, userId, coins, week }) {
        const prev = seen.get(key);
        if (prev) return prev.kind === 'ok' ? { ...prev, replay: true } : prev;
        const used = weekly.get(`${userId}|${week}`) ?? 0;
        let r: RedeemResult;
        if (!Number.isInteger(coins) || coins <= 0) r = { kind: 'rejected', error: '金币数要是正整数' };
        else if (used + coins > EXCHANGE.weeklyCapCoins) r = { kind: 'rejected', error: `超过本周兑换上限：每周最多 ${EXCHANGE.weeklyCapCoins} 金币，本周已兑 ${used}` };
        else {
          weekly.set(`${userId}|${week}`, used + coins);
          bal.set(userId, (bal.get(userId) ?? opts.mockCoins) + coins);
          r = { kind: 'ok', replay: false, bal: bal.get(userId)! };
        }
        seen.set(key, r);
        return r;
      },
    };
  }
  if (!opts.port || !opts.secret) throw new Error('WALLET_MODE=live 需要 WANGCAI_CONTROL_PORT 和 WANGCAI_CONTROL_SECRET');
  const f = opts.fetchImpl ?? fetch;
  const base = `http://127.0.0.1:${opts.port}`;
  const auth = { authorization: `Bearer ${opts.secret}` };
  return {
    mode: 'live',
    async balance(discordId) {
      try {
        const res = await f(`${base}/wallet/${encodeURIComponent(discordId)}`, { headers: auth, signal: AbortSignal.timeout(3000) });
        const data = (await res.json()) as { ok?: boolean; opened?: boolean; bal?: number };
        if (!data.ok) return { coins: null, opened: false };
        if (!data.opened) return { coins: 0, opened: false };
        return { coins: Number(data.bal ?? 0), opened: true };
      } catch {
        return { coins: null, opened: false };
      }
    },
    async redeem({ key, userId, coins }) {
      let res: Response;
      try {
        res = await f(`${base}/wallet/cardshop-redeem`, {
          method: 'POST',
          headers: { ...auth, 'content-type': 'application/json' },
          body: JSON.stringify({ key, userId, coins }),
          signal: AbortSignal.timeout(5000),
        });
      } catch (e) {
        return { kind: 'unknown', reason: `连不上旺财：${(e as Error).message}` };
      }
      // 旺财对业务结果一律回 200；别的状态（401 secret 不对、404 还没上这个接口、503 钱包没开、5xx）都当"不知道"，保持 pending
      if (res.status !== 200) return { kind: 'unknown', reason: `旺财回 HTTP ${res.status}` };
      let data: { ok?: boolean; replay?: boolean; bal?: number; error?: string };
      try { data = (await res.json()) as typeof data; } catch { return { kind: 'unknown', reason: '旺财回的不是 JSON' }; }
      if (data.ok === true) return { kind: 'ok', replay: data.replay === true, bal: typeof data.bal === 'number' ? data.bal : null };
      if (data.ok === false) return { kind: 'rejected', error: String(data.error || '旺财拒绝了') };
      return { kind: 'unknown', reason: '旺财回的结果看不懂' };
    },
  };
}

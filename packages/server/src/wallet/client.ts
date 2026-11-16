// 调旺财 /wallet/* 的客户端（SRS 6.3）。不 import 旺财的任何代码，只走 HTTP。
// mock：本机开发用，返回固定余额，不碰任何真钱包。
// live：GET http://127.0.0.1:<WANGCAI_CONTROL_PORT>/wallet/<discordId>，Bearer secret。
// 联调时用旺财的 `node scripts/wallet-flow-drill.mjs --serve` 起一个本地 control-server，不要连生产钱包。
import type { WalletView } from '@kanu/shared/types';

export interface WalletClient {
  mode: 'mock' | 'live';
  /** 只读，用于首页显示；失败时返回 coins: null，不抛错（FR-AUTH-7） */
  balance(discordId: string): Promise<WalletView>;
}

export function createWalletClient(opts: {
  mode: 'mock' | 'live';
  port: number | null;
  secret: string | null;
  mockCoins: number;
  fetchImpl?: typeof fetch;
}): WalletClient {
  if (opts.mode === 'mock') {
    return { mode: 'mock', balance: async () => ({ coins: opts.mockCoins, opened: true }) };
  }
  if (!opts.port || !opts.secret) throw new Error('WALLET_MODE=live 需要 WANGCAI_CONTROL_PORT 和 WANGCAI_CONTROL_SECRET');
  const f = opts.fetchImpl ?? fetch;
  const base = `http://127.0.0.1:${opts.port}`;
  return {
    mode: 'live',
    async balance(discordId) {
      try {
        const res = await f(`${base}/wallet/${encodeURIComponent(discordId)}`, {
          headers: { authorization: `Bearer ${opts.secret}` },
          signal: AbortSignal.timeout(3000),
        });
        const data = (await res.json()) as { ok?: boolean; opened?: boolean; bal?: number };
        if (!data.ok) return { coins: null, opened: false };
        if (!data.opened) return { coins: 0, opened: false };
        return { coins: Number(data.bal ?? 0), opened: true };
      } catch {
        return { coins: null, opened: false };
      }
    },
  };
}

// 频道播报（FR-PACK-6、FR-NOTIFY-1、FR-NOTIFY-3）：用 Bot token 走 Discord REST，不需要常驻 Gateway。
// 同一频道每分钟最多 NOTIFY.perMinute 条，多出来的攒着，到下一分钟合并成一条发。
// 没配 DISCORD_BOT_TOKEN 或播报频道时什么都不发（本机开发默认如此）。
import { NOTIFY } from '@kanu/shared/balance';

export interface Notifier {
  announce(text: string): void;
  /** 测试用：把攒着的消息立刻发掉 */
  flush(): Promise<void>;
}

export const nullNotifier: Notifier = { announce: () => {}, flush: async () => {} };

export function createDiscordNotifier(opts: {
  botToken: string | null;
  channelId: string | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (msg: string, err?: unknown) => void;
}): Notifier {
  if (!opts.botToken || !opts.channelId) return nullNotifier;
  const f = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((m, e) => console.error(m, e));
  let windowStart = 0;
  let sentInWindow = 0;
  let pending: string[] = [];
  let timer: NodeJS.Timeout | null = null;

  const post = async (content: string) => {
    try {
      const res = await f(`https://discord.com/api/v10/channels/${opts.channelId}/messages`, {
        method: 'POST',
        headers: { authorization: `Bot ${opts.botToken}`, 'content-type': 'application/json' },
        // 不 @ 任何人（播报只写显示名）
        body: JSON.stringify({ content: content.slice(0, 2000), allowed_mentions: { parse: [] } }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) log(`[notify] 播报失败 HTTP ${res.status}`);
    } catch (e) {
      log('[notify] 播报失败', e);
    }
  };

  const flush = async () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!pending.length) return;
    const merged = pending.join('\n');
    pending = [];
    windowStart = now();
    sentInWindow = 1;
    await post(merged);
  };

  return {
    announce(text) {
      const t = now();
      if (t - windowStart >= 60_000) { windowStart = t; sentInWindow = 0; }
      if (sentInWindow < NOTIFY.perMinute && !pending.length) {
        sentInWindow += 1;
        void post(text);
        return;
      }
      pending.push(text);
      if (!timer) timer = setTimeout(() => void flush(), Math.max(0, windowStart + 60_000 - t));
    },
    flush,
  };
}

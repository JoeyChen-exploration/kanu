// 管理页（FR-ADMIN，M7 内测）：只有管理员（ADMIN_USER_IDS）看得到这个标签，接口也只认管理员。
// 查玩家（含卡牌隐藏属性）、发信用点 / 卡、跳营业日、重新导入卡牌、处理卡住的兑换单。
import { useEffect, useState } from 'react';
import { STYLES } from '@kanu/shared/balance';
import { api, newIdempotencyKey } from '../api.ts';
import { fmt } from '../Card.tsx';

type Player = { discord_id: string; display_name: string; credits: number; game_day: number; rent_due: number; shop_owned: number };
type Detail = {
  player: { id: string; name: string; credits: number; reputation: number; gameDay: number; runStartDay: number; blueprints: number };
  rent: { owned: boolean; arrears: { amount: number; week: number } | null; next: { day: number; week: number; amount: number } | null };
  cards: Array<Record<string, string | number | null>>;
  sealed: number;
  events: Array<{ id: number; at: number; kind: string; data: Record<string, unknown> }>;
};
type Exchange = { id: number; owner_id: string; credits: number; coins: number; status: string; error: string | null; attempts: number; alerted: number; created_at: number; key: string };

const AUTH: Record<string, string> = { real: '真', low_fake: '低仿', high_fake: '高仿' };

export function Admin() {
  const [q, setQ] = useState('');
  const [players, setPlayers] = useState<Player[]>([]);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [grant, setGrant] = useState({ credits: '', templateId: '', style: 'standard', grade: '9', count: '1', reason: '' });
  const [day, setDay] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const search = () => api<{ players: Player[] }>(`/admin/players?q=${encodeURIComponent(q)}`).then((r) => setPlayers(r.players)).catch((e: Error) => setErr(e.message));
  const open = (id: string) => api<Detail>(`/admin/players/${id}`).then(setDetail).catch((e: Error) => setErr(e.message));
  const loadEx = () => api<{ exchanges: Exchange[] }>('/admin/exchanges?status=pending').then((r) => setExchanges(r.exchanges)).catch((e: Error) => setErr(e.message));
  useEffect(() => { void search(); void loadEx(); }, []);

  const run = async (fn: () => Promise<string>) => {
    setBusy(true); setErr(''); setMsg('');
    try { setMsg(await fn()); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const post = <T,>(url: string, body: object) => api<T>(url, { method: 'POST', body, idempotencyKey: newIdempotencyKey() });

  return (
    <section className="page admin-page">
      <h1>管理</h1>
      {msg && <p className="deal-msg">{msg}</p>}
      {err && <p className="error">{err}</p>}

      <div className="admin-block">
        <h2>查玩家</h2>
        <div className="admin-row">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Discord ID 或名字" onKeyDown={(e) => { if (e.key === 'Enter') void search(); }} />
          <button className="secondary" onClick={() => void search()}>找</button>
          <button className="secondary" disabled={busy} onClick={() => run(async () => { const r = await post<{ series: string[]; templates: number }>('/admin/reload-content', {}); return `重新导入了 ${r.series.join('、')}，共 ${r.templates} 张卡牌模板`; })}>重新导入卡牌</button>
        </div>
        <table className="admin-table">
          <thead><tr><th>名字</th><th>ID</th><th>信用点</th><th>营业日</th><th>欠租</th><th>店主</th></tr></thead>
          <tbody>
            {players.map((p) => (
              <tr key={p.discord_id} onClick={() => void open(p.discord_id)} className={detail?.player.id === p.discord_id ? 'on' : ''}>
                <td>{p.display_name}</td><td className="mono">{p.discord_id}</td><td>{fmt(p.credits)}</td><td>{p.game_day}</td><td>{p.rent_due ? fmt(p.rent_due) : ''}</td><td>{p.shop_owned ? '是' : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {detail && (
        <div className="admin-block">
          <h2>{detail.player.name} <small className="mono">{detail.player.id}</small></h2>
          <p className="hint">信用点 {fmt(detail.player.credits)} · 信誉 {detail.player.reputation} · 蓝图 {fmt(detail.player.blueprints)} · 第 {detail.player.gameDay} 天（这一轮从第 {detail.player.runStartDay} 天起）· 没拆的卡包 {detail.sealed} · {detail.rent.owned ? '店主' : detail.rent.arrears ? `欠租 ${fmt(detail.rent.arrears.amount)}` : detail.rent.next ? `第 ${detail.rent.next.day} 天交 ${fmt(detail.rent.next.amount)}` : ''}</p>

          <h3>发放（必须写原因，记日志）</h3>
          <div className="admin-row">
            <label>信用点 <input inputMode="numeric" value={grant.credits} onChange={(e) => setGrant({ ...grant, credits: e.target.value })} placeholder="可负数" /></label>
            <label>卡 <input value={grant.templateId} onChange={(e) => setGrant({ ...grant, templateId: e.target.value.toUpperCase() })} placeholder="如 NEO-17" /></label>
            <label>风格 <select value={grant.style} onChange={(e) => setGrant({ ...grant, style: e.target.value })}>{STYLES.map((s) => <option key={s}>{s}</option>)}</select></label>
            <label>品相 <input value={grant.grade} onChange={(e) => setGrant({ ...grant, grade: e.target.value })} size={3} /></label>
            <label>张数 <input inputMode="numeric" value={grant.count} onChange={(e) => setGrant({ ...grant, count: e.target.value })} size={3} /></label>
            <label className="grow">原因 <input value={grant.reason} onChange={(e) => setGrant({ ...grant, reason: e.target.value })} placeholder="内测补偿……" /></label>
            <button className="primary" disabled={busy || !grant.reason.trim()} onClick={() => run(async () => {
              const body: Record<string, unknown> = { userId: detail.player.id, reason: grant.reason };
              if (grant.credits.trim()) body.credits = Number(grant.credits);
              if (grant.templateId.trim()) Object.assign(body, { templateId: grant.templateId.trim(), style: grant.style, grade: grant.grade, count: Number(grant.count || 1) });
              const r = await post<{ credits: number; cardIds: number[] }>('/admin/grant', body);
              await open(detail.player.id);
              return `发好了：信用点现在 ${fmt(r.credits)}${r.cardIds.length ? `，发了 ${r.cardIds.length} 张卡` : ''}`;
            })}>发放</button>
          </div>

          <h3>跳营业日（内测测房租用）</h3>
          <div className="admin-row">
            <input inputMode="numeric" value={day} onChange={(e) => setDay(e.target.value)} placeholder={`现在第 ${detail.player.gameDay} 天`} size={10} />
            <button className="secondary" disabled={busy || !day} onClick={() => run(async () => { await post('/admin/players/' + detail.player.id + '/day', { day: Number(day), reason: '管理页' }); await open(detail.player.id); return `跳到第 ${day} 天`; })}>跳过去</button>
          </div>

          <h3>库存 {detail.cards.length} 张 <small>含隐藏属性，只有管理员看得到</small></h3>
          <div className="admin-scroll">
            <table className="admin-table">
              <thead><tr><th>#</th><th>卡</th><th>稀有度</th><th>风格</th><th>位置</th><th>真伪</th><th>品相</th><th>来源</th><th>错版</th><th>封壳</th></tr></thead>
              <tbody>
                {detail.cards.map((c) => (
                  <tr key={String(c.id)} className={c.authenticity !== 'real' ? 'fake' : ''}>
                    <td>{c.id}</td><td>{c.template_id} {c.name}</td><td>{c.rarity}</td><td>{c.style}</td><td>{c.location}</td>
                    <td>{AUTH[String(c.authenticity)] ?? c.authenticity}</td><td>{c.grade}</td><td>{c.origin}</td><td>{c.misprint ? '是' : ''}</td><td>{c.slab_score ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3>最近 {detail.events.length} 条日志</h3>
          <div className="admin-scroll">
            {detail.events.map((e) => (
              <div key={e.id} className="admin-event"><span className="mono">{new Date(e.at).toLocaleString('zh-CN')}</span> <b>{e.kind}</b> <code>{JSON.stringify(e.data)}</code></div>
            ))}
          </div>
        </div>
      )}

      <div className="admin-block">
        <h2>卡住的兑换单 <button className="link" onClick={() => void loadEx()}>刷新</button></h2>
        {exchanges.length === 0 ? <p className="hint">没有 pending 的兑换单。</p> : (
          <>
            <p className="hint">关单前先查旺财的钱包流水（why = cardshop、ref = 下面的 key）：有这笔就点"核实到账"，没有才点"退信用点"。旺财只记得 key 48 小时，过了之后只能人工核对流水。</p>
            <table className="admin-table">
              <thead><tr><th>#</th><th>玩家</th><th>金币</th><th>信用点</th><th>重试</th><th>报警</th><th>最近的错误</th><th>key</th><th /></tr></thead>
              <tbody>
                {exchanges.map((x) => (
                  <tr key={x.id}>
                    <td>{x.id}</td><td className="mono">{x.owner_id}</td><td>{x.coins}</td><td>{fmt(x.credits)}</td><td>{x.attempts}</td><td>{x.alerted ? '⚠️' : ''}</td><td>{x.error}</td><td className="mono">{x.key}</td>
                    <td className="admin-actions">
                      <button className="chip" disabled={busy} onClick={() => run(async () => { const r = await post<{ result: { kind: string } }>(`/admin/exchanges/${x.id}/retry`, {}); await loadEx(); return `重试结果：${r.result.kind}`; })}>重试</button>
                      <button className="chip" disabled={busy} onClick={() => { const reason = window.prompt('核实到账了？写一下依据（比如旺财流水时间）'); if (reason) void run(async () => { await post(`/admin/exchanges/${x.id}/close`, { outcome: 'done', reason }); await loadEx(); return `#${x.id} 标记为已到账`; }); }}>核实到账</button>
                      <button className="chip danger" disabled={busy} onClick={() => { const reason = window.prompt('核实旺财没有这笔？写一下依据，确认后退信用点'); if (reason) void run(async () => { await post(`/admin/exchanges/${x.id}/close`, { outcome: 'refund', reason }); await loadEx(); return `#${x.id} 已退信用点`; }); }}>退信用点</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </section>
  );
}

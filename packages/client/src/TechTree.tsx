// 科技树（docs/TECH-TREE.md，MVP 6 个节点）：店铺页上五条分支并排，每条分支一位联系人。
// 点亮节点用蓝图，蓝图不够的部分自动用信用点 1:1 换。"追踪"把节点的解锁条件放进任务栏。
import { useEffect, useState } from 'react';
import { BLUEPRINT } from '@kanu/shared/balance';
import type { MeResponse, TechBuyResponse, TechNodeView, TechResponse } from '@kanu/shared/types';
import { WRITE_EVENT, api, newIdempotencyKey } from './api.ts';
import { fmt } from './Card.tsx';

export function TechTree({ onChange }: { onChange: (p: Partial<MeResponse>) => void }) {
  const [data, setData] = useState<TechResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    const load = () => api<TechResponse>('/tech').then(setData).catch((e: Error) => setErr(e.message));
    void load();
    window.addEventListener(WRITE_EVENT, load);
    return () => window.removeEventListener(WRITE_EVENT, load);
  }, []);

  const buy = async (n: TechNodeView) => {
    setBusy(n.id); setErr(''); setMsg('');
    try {
      const r = await api<TechBuyResponse>('/tech/buy', { method: 'POST', body: { nodeId: n.id }, idempotencyKey: newIdempotencyKey() });
      onChange({ credits: r.credits });
      setMsg(`点亮了「${n.name}」：${n.effect}${r.converted > 0 ? `（用 ${fmt(Math.ceil(r.converted / BLUEPRINT.perCredit))} 信用点换了 ${fmt(r.converted)} 蓝图）` : ''}`);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  };

  const track = async (n: TechNodeView) => {
    setBusy(n.id); setErr('');
    try {
      setData(await api<TechResponse>('/tech/track', { method: 'POST', body: { nodeId: n.tracked ? null : n.id } }));
    } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  };

  if (!data) return err ? <p className="error">{err}</p> : null;
  return (
    <section className="tech">
      <div className="tech-head">
        <h2>科技树</h2>
        <span className="hint">蓝图 <b>{fmt(data.blueprints)}</b> · 价格按蓝图算，蓝图不够的部分点亮时用信用点 1:1 换 · 永久保留，破产也不清空</span>
      </div>
      <div className="tech-branches">
        {data.branches.map((b) => (
          <div key={b.id} className={`tech-branch branch-${b.id}`}>
            <div className="tech-branch-head"><b>{b.name}</b><span className="hint">{b.contact}</span></div>
            {b.nodes.map((n) => {
              const short = Math.max(0, n.price - data.blueprints);
              const afford = data.credits >= Math.ceil(short / BLUEPRINT.perCredit);
              return (
                <div key={n.id} className={`tech-node${n.owned ? ' owned' : n.unlockable ? ' ready' : ' locked'}`}>
                  <div className="tech-node-top">
                    <span className="tech-id">{n.id}</span>
                    <b>{n.name}</b>
                    <span className="tech-tier">第 {n.tier} 层</span>
                  </div>
                  <p className="tech-effect">{n.effect}</p>
                  <p className="tech-flavor">"{n.flavor}"</p>
                  {!n.owned && (n.requires.length > 0 || n.conditions.length > 0) && (
                    <ul className="tech-conds">
                      {n.requires.map((r) => <li key={r.id} className={r.owned ? 'met' : ''}>{r.owned ? '✓' : '·'} 先点 {r.name}</li>)}
                      {n.conditions.map((c) => <li key={c.text} className={c.met ? 'met' : ''}>{c.met ? '✓' : '·'} {c.text}（{c.current} / {c.target}）</li>)}
                    </ul>
                  )}
                  {n.owned
                    ? <span className="tech-owned">已点亮</span>
                    : (
                      <div className="tech-actions">
                        <button className="primary" disabled={busy !== null || !n.unlockable || !afford} onClick={() => buy(n)}>
                          点亮 {fmt(n.price)}
                        </button>
                        <button className={n.tracked ? 'chip on' : 'chip'} disabled={busy !== null} onClick={() => track(n)}>{n.tracked ? '取消追踪' : '追踪'}</button>
                      </div>
                    )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      {msg && <p className="deal-msg">{msg}</p>}
      {err && <p className="error">{err}</p>}
    </section>
  );
}

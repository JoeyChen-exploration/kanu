// 派系面板（店铺页，DESIGN 8.4）：三个派系的关系值、等级、怎么涨、得罪谁、各等级奖励。隐藏的治安关系不显示。
import { useEffect, useState } from 'react';
import type { FactionsResponse, FactionView, MeResponse, TributeResponse } from '@kanu/shared/types';
import { WRITE_EVENT, api, newIdempotencyKey } from './api.ts';
import { fmt } from './Card.tsx';
import { ArtImg } from './art.tsx';

const EMOJI: Record<FactionView['id'], string> = { guild: '🏛️', black: '🕶️', collectors: '🏺' };

export function FactionEmblem({ id, className = 'faction-emblem' }: { id: FactionView['id']; className?: string }) {
  return <ArtImg srcs={[`/art/factions/${id}.webp`, `/art/factions/${id}.png`]} className={className} fallback={<span className={className} aria-hidden>{EMOJI[id]}</span>} />;
}

export function FactionPanel({ onChange }: { onChange: (p: Partial<MeResponse>) => void }) {
  const [data, setData] = useState<FactionsResponse | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const load = () => api<FactionsResponse>('/factions').then(setData).catch((e: Error) => setErr(e.message));
  useEffect(() => {
    void load();
    window.addEventListener(WRITE_EVENT, load);
    return () => window.removeEventListener(WRITE_EVENT, load);
  }, []);
  const payTribute = async () => {
    setBusy(true); setErr('');
    try {
      const r = await api<TributeResponse>('/factions/tribute', { method: 'POST', body: {}, idempotencyKey: newIdempotencyKey() });
      onChange({ credits: r.credits });
      await load();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); setConfirm(false); }
  };
  if (!data) return err ? <p className="error">{err}</p> : null;
  const vd = data.vendetta;
  const { min, max, hostileMax, knownMin, allyMin } = data.thresholds;
  const pos = (v: number) => `${((v - min) / (max - min)) * 100}%`;

  return (
    <section className="faction-panel">
      <h2>派系 <small>讨好一方，常常会得罪另一方</small></h2>
      {vd && (
        <div className={`vendetta vendetta-${vd.stage}`}>
          <FactionEmblem id="black" className="vendetta-emblem" />
          <div>
            <b>{vd.stage === 'warn' ? '门缝里塞进来一张纸条' : vd.stage === 'ultimatum' ? '黑市下了最后通牒' : '你被黑市盯上了'}</b>
            <p>{vd.stage === 'warn'
              ? '"最近话挺多啊，卡店老板。"黑市已经记住你了，再得罪下去就会找上门。'
              : vd.stage === 'ultimatum'
                ? '"拿钱来，这事就算了。"不摆平的话，关系再差下去，哪天打烊就回不了店了。'
                : `每次打烊都有 ${vd.hitPct}% 被黑市"清理"：店没了、卡和信用点清空，只剩珍藏柜，等于从头开始。`}</p>
            {vd.tribute !== null && (confirm
              ? <span className="vendetta-actions"><button className="danger" disabled={busy} onClick={payTribute}>确认交 {fmt(vd.tribute)}</button><button className="secondary" onClick={() => setConfirm(false)}>算了</button></span>
              : <button className="danger" disabled={busy} onClick={() => setConfirm(true)}>交摆平费 {fmt(vd.tribute)} 信用点</button>)}
            {err && <p className="error">{err}</p>}
          </div>
        </div>
      )}
      <div className="faction-list">
        {data.factions.map((f) => (
          <div key={f.id} className={`faction faction-${f.id} tier-${f.tier}`}>
            <FactionEmblem id={f.id} />
            <div className="faction-body">
              <b>{f.name} <span className={`tier-tag tier-${f.tier}`}>
                <ArtImg srcs={[`/art/factions/tier-${f.tier}.webp`, `/art/factions/tier-${f.tier}.png`]} className="tier-icon" fallback={null} />{f.tierName}
              </span> <small>{f.value > 0 ? `+${f.value}` : f.value}</small></b>
              <div className="rep-bar" aria-hidden>
                <i className="mark" style={{ left: pos(hostileMax) }} />
                <i className="mark" style={{ left: pos(knownMin) }} />
                <i className="mark" style={{ left: pos(allyMin) }} />
                <i className="zero" style={{ left: pos(0) }} />
                <i className="dot" style={{ left: pos(f.value) }} />
              </div>
              <span className="hint faction-contact">
                <ArtImg srcs={[`/art/contacts/${f.contact}.webp`, `/art/contacts/${f.contact}.png`]} className="contact-mini" fallback={null} />
                联系人：{f.contactName}
              </span>
              <span className="hint">涨：{f.gain}；得罪：{f.rival}</span>
              {f.perks.map((p) => (
                <span key={p.tier + p.text} className={p.active ? 'perk on' : 'perk'}>{p.active ? '✓' : '🔒'} {p.tier === 'ally' ? `盟友（${allyMin}）` : `熟脸（${knownMin}）`}：{p.text}</span>
              ))}
              {f.id === 'black' && data.registryLeft !== null && <span className="perk on">失窃登记表这周还能查 {data.registryLeft} 次（库存页，把卡拖上去）</span>}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

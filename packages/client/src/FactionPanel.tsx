// 派系面板（店铺页，DESIGN 8.4）：三个派系的关系值、等级、怎么涨、得罪谁、各等级奖励。隐藏的治安关系不显示。
import { useEffect, useState } from 'react';
import type { FactionsResponse, FactionView } from '@kanu/shared/types';
import { WRITE_EVENT, api } from './api.ts';
import { ArtImg } from './art.tsx';

const EMOJI: Record<FactionView['id'], string> = { guild: '🏛️', black: '🕶️', collectors: '🏺' };

export function FactionEmblem({ id, className = 'faction-emblem' }: { id: FactionView['id']; className?: string }) {
  return <ArtImg srcs={[`/art/factions/${id}.webp`, `/art/factions/${id}.png`]} className={className} fallback={<span className={className} aria-hidden>{EMOJI[id]}</span>} />;
}

export function FactionPanel() {
  const [data, setData] = useState<FactionsResponse | null>(null);
  const [err, setErr] = useState('');
  const load = () => api<FactionsResponse>('/factions').then(setData).catch((e: Error) => setErr(e.message));
  useEffect(() => {
    void load();
    window.addEventListener(WRITE_EVENT, load);
    return () => window.removeEventListener(WRITE_EVENT, load);
  }, []);
  if (!data) return err ? <p className="error">{err}</p> : null;
  const { min, max, hostileMax, knownMin, allyMin } = data.thresholds;
  const pos = (v: number) => `${((v - min) / (max - min)) * 100}%`;

  return (
    <section className="faction-panel">
      <h2>派系 <small>讨好一方，常常会得罪另一方</small></h2>
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

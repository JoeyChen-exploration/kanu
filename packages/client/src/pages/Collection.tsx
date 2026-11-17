// 图鉴页（FR-INV-5）：有过就点亮，没有过的只显示轮廓。
import { useEffect, useState } from 'react';
import type { CollectionResponse } from '@kanu/shared/types';
import { api } from '../api.ts';
import { Card } from '../Card.tsx';

export function Collection() {
  const [data, setData] = useState<CollectionResponse | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { api<CollectionResponse>('/collection').then(setData).catch((e: Error) => setErr(e.message)); }, []);

  return (
    <section className="page">
      {data?.series.map((s) => (
        <div key={s.id}>
          <h2>{s.name} <small>{s.owned} / {s.total}</small></h2>
          <div className="progress"><div style={{ width: `${(s.owned / s.total) * 100}%` }} /></div>
          <div className="grid">
            {s.cards.map((c) => (
              <div key={c.templateId} className={c.owned ? 'cell' : 'cell locked'}>
                {c.owned ? <Card card={{ ...c, style: 'standard', serialNo: null }} small /> : <div className="card small silhouette"><div className="card-face">?</div></div>}
                {c.count > 1 && <span className="count">×{c.count}</span>}
              </div>
            ))}
          </div>
        </div>
      ))}
      {err && <p className="error">{err}</p>}
    </section>
  );
}

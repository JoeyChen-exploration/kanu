// 卡牌显示（FR-INV-3）：卡面图 + 卡框 + 稀有度角标 + 名牌条。
// 布局按 docs/ART.md"卡面安全区"：以 630 × 880 为基准，所有位置用卡宽的百分比（容器单位 cqw，1cqw = 6.3 px）写在 style.css，
// 卡多大都是同一个比例，美术按那组像素值画就能对上。缺图时回退到现在代码画的占位（ArtImg）。
import { createContext, useContext } from 'react';
import type { CardView } from '@kanu/shared/types';
import { ART, ArtImg } from './art.tsx';

/** 现在是第几个营业日：卡牌按"散放了几天"画磨损（App 里提供） */
export const GameDayContext = createContext(1);

/** 散放天数 → 磨损档位：0 干净，1–2 落灰，3–5 划痕，6 天以上划痕加卷角。只看公开的天数，不代表真实品相 */
export function wearLevel(looseDays: number | null): number {
  if (looseDays === null || looseDays < 1) return 0;
  if (looseDays <= 2) return 1;
  if (looseDays <= 5) return 2;
  return 3;
}

const STYLE_NAME: Record<string, string> = {
  standard: '', holo: '闪卡', ice: '镭射碎冰', gold: '金框', dark: '暗物质', serial: '编号限定',
};

export const fmt = (n: number) => n.toLocaleString('zh-CN');

export function Card({ card, small }: { card: Pick<CardView, 'name' | 'rarity' | 'style' | 'tags' | 'serialNo'> & Partial<CardView>; small?: boolean }) {
  const day = useContext(GameDayContext);
  const looseDays = card.looseSinceDay != null ? day - card.looseSinceDay : null;
  const wear = wearLevel(looseDays);
  const slab = card.slab ?? null;
  return (
    <div className={`card rarity-${card.rarity} style-${card.style}${small ? ' small' : ''}${wear ? ` wear-${wear}` : ''}${slab ? ' slabbed' : ''}`} title={looseDays !== null ? `散放 ${looseDays} 天` : undefined}>
      {/* 鉴定的公开标记（DESIGN 5）：封壳评分（含错版认定）在壳顶上 */}
      {slab && <div className={slab.score === 'BL' ? 'slab-label black' : 'slab-label'}>星港评级 <b>{slab.score === 'BL' ? '黑标' : slab.score}</b>{slab.errata && <span className="slab-errata">错版</span>}</div>}
      <div className="card-body">
        {/* 卡面窗口：卡面图画满 630 × 880，外圈 24 px 被卡框盖住 */}
        <div className="card-face">
          <ArtImg srcs={card.templateId ? [ART.card(card.templateId)] : []} className="card-art-img" fallback={<div className="card-art" aria-hidden>{card.name.slice(0, 1)}</div>} />
        </div>
        <ArtImg srcs={[ART.frame(card.style)]} className="card-frame-img" fallback={null} />
        <div className="card-badge">
          <ArtImg srcs={[ART.rarity(card.rarity)]} className="card-badge-img" alt={card.rarity} fallback={<span className="card-rarity">{card.rarity}</span>} />
        </div>
        {card.style === 'serial' && card.serialNo != null && <span className="card-serial">{String(card.serialNo).padStart(2, '0')}/50</span>}
        <div className="card-plate">
          <div className="card-name">{card.name}</div>
          {!small && <div className="card-tags">{card.tags.join(' · ')}</div>}
        </div>
        {!small && STYLE_NAME[card.style] && <div className="card-style">{STYLE_NAME[card.style]}</div>}
        {card.gradeRejected && <span className="rejected-mark" title="评级社拒评：疑似假卡">拒评</span>}
        {card.acquired === 'wholesale' && !slab && <span className="wholesale-mark" title="电话批发来的：批发商不保证正品">批</span>}
        {card.acquired === 'dealer' && !slab && <span className="wholesale-mark dealer-mark" title="从卡贩手里收来的：来路不明">收</span>}
      </div>
    </div>
  );
}

/** 背面朝上的卡（开包翻牌前） */
export function CardBack({ small }: { small?: boolean }) {
  return (
    <div className={`card card-back${small ? ' small' : ''}`}>
      <div className="card-body">
        <ArtImg srcs={[ART.cardBack]} className="card-back-img" fallback={<div className="card-face"><div className="card-back-logo">卡奴</div></div>} />
      </div>
    </div>
  );
}

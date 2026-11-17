// 卡牌显示（FR-INV-3）：卡面 + 外层风格图层。美术到位前，卡面是按稀有度配色的占位图，外框用 CSS 画。
import { createContext, useContext } from 'react';
import type { CardView } from '@kanu/shared/types';

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
  return (
    <div className={`card rarity-${card.rarity} style-${card.style}${small ? ' small' : ''}${wear ? ` wear-${wear}` : ''}`} title={looseDays !== null ? `散放 ${looseDays} 天` : undefined}>
      <div className="card-face">
        <div className="card-top">
          <span className="card-rarity">{card.rarity}</span>
          {card.style === 'serial' && card.serialNo != null && <span className="card-serial">{String(card.serialNo).padStart(2, '0')}/50</span>}
        </div>
        <div className="card-art" aria-hidden>{card.name.slice(0, 1)}</div>
        <div className="card-name">{card.name}</div>
        {!small && <div className="card-tags">{card.tags.join(' · ')}</div>}
        {!small && STYLE_NAME[card.style] && <div className="card-style">{STYLE_NAME[card.style]}</div>}
      </div>
    </div>
  );
}

/** 背面朝上的卡（开包翻牌前） */
export function CardBack({ small }: { small?: boolean }) {
  return (
    <div className={`card card-back${small ? ' small' : ''}`}>
      <div className="card-face"><div className="card-back-logo">卡奴</div></div>
    </div>
  );
}

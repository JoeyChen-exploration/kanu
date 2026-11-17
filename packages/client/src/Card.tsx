// 卡牌显示（FR-INV-3）：卡面 + 外层风格图层。美术到位前，卡面是按稀有度配色的占位图，外框用 CSS 画。
import type { CardView } from '@kanu/shared/types';

const STYLE_NAME: Record<string, string> = {
  standard: '', holo: '闪卡', ice: '镭射碎冰', gold: '金框', dark: '暗物质', serial: '编号限定',
};

export const fmt = (n: number) => n.toLocaleString('zh-CN');

export function Card({ card, small }: { card: Pick<CardView, 'name' | 'rarity' | 'style' | 'tags' | 'serialNo'> & Partial<CardView>; small?: boolean }) {
  return (
    <div className={`card rarity-${card.rarity} style-${card.style}${small ? ' small' : ''}`}>
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

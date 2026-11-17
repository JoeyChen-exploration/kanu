// 新手手册：一本可以左右翻页的小册子（顶栏 📖 打开，第一次进游戏自动打开）。
// 数字全部从 balance.ts 读，调了数值手册跟着变。只讲公开规则，不写顾客心理价位怎么算、品相掉没掉这类隐藏信息。
import { useRef, useState, type ReactNode } from 'react';
import {
  ANNOUNCE, BINDER_KINDS, BINDERS, COUNTER, CUSTOMER, CUSTOMER_TYPES, EXCHANGE, LOOSE, PACKS, PITY, RARITIES, RARITY,
  RENT, SERIAL_LIMIT, SHOP_PRICE, SHOWCASE, STARTER_BINDER, STORE, STYLE, STYLES, UNGRADED_MULT, type CustomerWants,
} from '@kanu/shared/balance';
import { Card, GameDayContext, fmt } from './Card.tsx';
import { AVATAR } from './pages/Counter.tsx';

const SEEN_KEY = 'kanu.booklet.seen';
/** 第一次进游戏要不要自动打开（本机记住看过没有） */
export function bookletUnseen() {
  try { return localStorage.getItem(SEEN_KEY) !== '1'; } catch { return false; }
}
function markSeen() {
  try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* 存不了就算了 */ }
}

const pct = (ppm: number) => `${+(ppm / 10_000).toFixed(2)}%`;

/** 每类顾客一句话印象（数值另外从 balance 读） */
const CUSTOMER_NOTE: Partial<Record<string, string>> = {
  resident: '街坊邻居，买便宜卡，出价实在。',
  student: '钱不多但很有耐心；看到闪卡这类特殊风格会多给。',
  tourist: '上层区来的游客，不太懂行，给钱爽快，但没什么耐心。',
  collector: '眼光毒、识假厉害，好卡肯出高价。',
  nostalgic: '点名要某一张卡。手上刚好有的话，他出价很高。',
  rich: '只看好卡，钱多。',
  speculator: '炒卡的，只想低价收好卡，耐心很差。',
  streamer: '要没拆的卡包，回去直播开箱，按卡包价加价收。',
  middleman: '什么卡都收，但只给很低的价，不问来路。',
};

function wantsText(w: CustomerWants) {
  if (w.kind === 'pack') return '没拆的卡包';
  if (w.template) return '点名的某一张卡';
  if (w.rarities.length === RARITIES.length) return '什么稀有度都收';
  return w.rarities.length <= 3 ? w.rarities.join(' / ') : `${w.rarities[0]} 以上`;
}

/** 磨损示意用的卡：在"第 10 天"的画面里，分别散放 0 / 1 / 4 / 7 天 */
const SAMPLE_DAY = 10;
const WEAR_SAMPLES = [
  { days: 0, label: '收在卡册里' },
  { days: 1, label: '散放 1–2 天：落灰' },
  { days: 4, label: '3–5 天：划痕' },
  { days: 7, label: '6 天以上：卷角' },
];

const counterDays = Object.keys(COUNTER.customersPerDayDist).map(Number);
const mvpTypes = CUSTOMER_TYPES.filter((t) => CUSTOMER[t].mvp);

const PAGES: Array<{ title: string; body: ReactNode }> = [
  {
    title: '欢迎来到卡奴',
    body: (
      <>
        <p>你在下层区开了一家小卡店。每天的流程很简单：</p>
        <ol className="booklet-steps">
          <li><b>进货</b>：在店里电脑上订卡包。</li>
          <li><b>开包</b>：一包一包拆，看看能不能开出大货。</li>
          <li><b>柜台</b>：客人一位一位进门，把卡卖给他们赚信用点。</li>
          <li><b>打烊</b>：客人都走了就打烊，进入下一天。</li>
        </ol>
        <p>好卡可以留着收藏、填满图鉴，也可以卖个好价钱。开局有一本{BINDERS[STARTER_BINDER].name}。</p>
        <p className="hint">往后翻，每一页讲一件事。随时可以点顶上的 📖 再打开这本手册。</p>
      </>
    ),
  },
  {
    title: '进货和开包',
    body: (
      <>
        <p>电脑订货是<b>唯一保证正品</b>的进货渠道，可以加进购物车一次买好几包。</p>
        <table className="booklet-table">
          <tbody>
            {(['themed', 'premium'] as const).map((k) => (
              <tr key={k}><td>{PACKS[k].name}</td><td>{fmt(PACKS[k].price)} 信用点</td><td>{PACKS[k].cards} 张一包</td></tr>
            ))}
          </tbody>
        </table>
        <ul>
          <li>每个营业日一共能订 <b>{STORE.packsPerDay} 包</b>（各种卡包加起来），打烊后重置。</li>
          <li>每种卡包就是一个系列，进货页能看到各稀有度的出货率。</li>
          <li><b>保底</b>：连续 {PITY.packs - 1} 包都没开出 {PITY.rarity} 或以上，第 {PITY.packs} 包必出一张 {PITY.rarity}。</li>
          <li>没拆的卡包可以先放着，开箱主播会来收。</li>
        </ul>
      </>
    ),
  },
  {
    title: '稀有度和风格',
    body: (
      <>
        <p>卡越稀有越值钱。下面是大概的市场价（没评级的卡）：</p>
        <table className="booklet-table">
          <tbody>
            {RARITIES.map((r) => (
              <tr key={r}><td><span className={`rarity-chip rarity-${r}`}>{r}</span></td><td>{RARITY[r].name}</td><td>约 {fmt(Math.round(RARITY[r].basePrice * UNGRADED_MULT))}</td></tr>
            ))}
          </tbody>
        </table>
        <p>同一张卡还有不同的<b>外层风格</b>，价格要乘上倍数：</p>
        <p className="booklet-chips">
          {STYLES.filter((s) => s !== 'standard').map((s) => <span key={s} className="badge">{STYLE[s].name} ×{STYLE[s].mult}</span>)}
        </p>
        <p className="hint">编号限定全服每张卡只有 {SERIAL_LIMIT} 张。</p>
      </>
    ),
  },
  {
    title: '柜台：一位一位接待',
    body: (
      <>
        <p>开门后客人<b>一位接一位</b>进门。你只看得到眼前这位，看不到后面还有谁。每天大约来 {Math.min(...counterDays)}–{Math.max(...counterDays)} 位。</p>
        <ul>
          <li>先看他<b>想要什么</b>、<b>预算多少</b>，还有<b>耐心</b>（●越少越容易走）。</li>
          <li>点开卡册，符合他要求的卡会<b>发光</b>，默认排在最前面。</li>
          <li><b>开价</b>：可以用 + − 调，每次加减多少自己选。开得太高他会嫌贵，或者还价；每次谈不拢都会扣耐心。</li>
          <li><b>接受还价</b>：他还了价，你点头就成交。</li>
          <li><b>快速出售</b>：价格低一些，但<b>必定成交</b>。</li>
          <li>手上没有他要的，就<b>请他离开</b>。</li>
        </ul>
        <p>客人都走了，就可以<b>打烊</b>，进入下一天。</p>
      </>
    ),
  },
  {
    title: '认识你的客人',
    body: (
      <div className="booklet-customers">
        {mvpTypes.map((t) => (
          <div key={t} className="booklet-customer">
            <span className="booklet-avatar" aria-hidden>{AVATAR[t] ?? '🙂'}</span>
            <div>
              <b>{CUSTOMER[t].name}</b> <span className="hint">要：{wantsText(CUSTOMER[t].wants)} · 耐心 {'●'.repeat(CUSTOMER[t].patience)}</span>
              <p className="hint">{CUSTOMER_NOTE[t]}</p>
            </div>
          </div>
        ))}
      </div>
    ),
  },
  {
    title: '卡册：把卡收好',
    body: (
      <>
        <p>卡要放进<b>卡册</b>才算收好。所有卡册的格数加起来就是你能存多少张卡。新开的卡会自动放进有空位的卡册。</p>
        <table className="booklet-table">
          <tbody>
            {BINDER_KINDS.map((k) => (
              <tr key={k}>
                <td>{BINDERS[k].name}</td>
                <td>{fmt(BINDERS[k].price)}</td>
                <td>{BINDERS[k].slots} 张</td>
              </tr>
            ))}
          </tbody>
        </table>
        <ul>
          <li>{BINDERS.humidor.name}：{BINDERS.humidor.effect.replace('防磨损；', '')}。</li>
          <li>{BINDERS.leather.name}：{BINDERS.leather.effect.replace('防磨损；', '')}。</li>
        </ul>
        <p className="hint">卡册在进货页的"用品"里买，不限购。没拆的卡包和珍藏柜里的卡不占格子。</p>
      </>
    ),
  },
  {
    title: '散放在桌面上会磨损',
    body: (
      <>
        <p>卡册都满了，新开的卡只能<b>散放在桌面上</b>，最多放 {LOOSE.slots} 张。桌面也满了就<b>不能再拆包</b>，要先卖卡或者买新卡册。</p>
        <p>散放的卡每过一天，有 <b>{pct(LOOSE.wearPpm)}</b> 的概率品相掉 1 分。品相看不出来，要送评才知道掉了多少；卡面会按散放的天数变旧：</p>
        <GameDayContext.Provider value={SAMPLE_DAY}>
          <div className="booklet-wear">
            {WEAR_SAMPLES.map((s) => (
              <figure key={s.days}>
                <Card card={{ name: '霓虹龙', rarity: 'SR', style: 'standard', tags: [], serialNo: null, looseSinceDay: s.days ? SAMPLE_DAY - s.days : null }} small />
                <figcaption>{s.label}</figcaption>
              </figure>
            ))}
          </div>
        </GameDayContext.Provider>
        <p className="hint">变旧只看放了几天，不代表真的掉了分。买了新卡册，桌面上的卡会自动收进去，值钱的先收。</p>
      </>
    ),
  },
  {
    title: '珍藏柜',
    body: (
      <>
        <p>库存页最上面是<b>珍藏柜</b>，一共 {SHOWCASE.slots} 格。</p>
        <ul>
          <li>就算店倒闭了从头开始，珍藏柜里的卡也会<b>留下来</b>。</li>
          <li>珍藏柜里的卡<b>不能拿去抵押</b>。</li>
          <li>有客人想要的话，<b>照样可以在柜台卖掉</b>，不用先取出来。</li>
          <li>珍藏柜不占卡册格子。</li>
        </ul>
        <p className="hint">把你最舍不得的那几张放进去。</p>
      </>
    ),
  },
  {
    title: '快开放：鉴定和房租',
    body: (
      <>
        <p>这些还在装修，先告诉你规则：</p>
        <ul>
          <li><b>真假和品相</b>：每张卡都有看不见的真伪、品相和来源。电脑订的货都是正品；别的渠道可能混进假货。</li>
          <li><b>鉴定</b>：用放大镜自己看，或者花钱送鉴定机构、送评级。评了高分的卡值钱得多。</li>
          <li><b>摊位费</b>：每 {RENT.everyDays} 个营业日交一次，从 {fmt(RENT.base)} 起，每周涨 {Math.round((RENT.growth - 1) * 100)}%，第 {RENT.capWeek} 周以后不再涨。交不起就倒闭，从头开始。</li>
          <li><b>买下店铺</b>：攒够 {fmt(SHOP_PRICE)} 信用点买下来，以后就不用交摊位费了。</li>
          <li><b>换金币</b>：信用点可以按 {EXCHANGE.creditsPerCoin} : 1 换成旺财金币，每周最多 {fmt(EXCHANGE.weeklyCapCoins)} 金币。</li>
        </ul>
      </>
    ),
  },
  {
    title: '几个小窍门',
    body: (
      <ul>
        <li>客人的预算是个范围，开价贴着上限试一试，不行再降。</li>
        <li>耐心只剩一格的时候，稳妥点就选快速出售。</li>
        <li>怀旧老顾客点名的卡，手上有的话千万别便宜卖。</li>
        <li>卡册快满了就早点买新的，别让好卡在桌面上放旧。</li>
        <li>攒几包不拆，开箱主播来了能卖个好价钱。</li>
        <li>开出 {ANNOUNCE.minRarity} 以上的大货，全服都会看到播报。</li>
      </ul>
    ),
  },
];

export function Booklet({ onClose }: { onClose: () => void }) {
  const [page, setPage] = useState(0);
  const touchX = useRef<number | null>(null);
  const go = (p: number) => setPage(Math.min(PAGES.length - 1, Math.max(0, p)));
  const close = () => { markSeen(); onClose(); };
  const last = page === PAGES.length - 1;
  const cur = PAGES[page]!;

  return (
    <div className="sheet booklet-backdrop" onClick={close}>
      <div
        className="booklet"
        role="dialog"
        aria-label="新手手册"
        onClick={(e) => e.stopPropagation()}
        onTouchStart={(e) => { touchX.current = e.touches[0]?.clientX ?? null; }}
        onTouchEnd={(e) => {
          const start = touchX.current;
          const end = e.changedTouches[0]?.clientX;
          touchX.current = null;
          if (start == null || end == null || Math.abs(end - start) < 50) return;
          go(page + (end < start ? 1 : -1));
        }}
      >
        <div className="booklet-head">
          <span className="hint">新手手册 · {page + 1} / {PAGES.length}</span>
          <button className="chip" onClick={close} aria-label="关闭手册">✕</button>
        </div>
        <article key={page} className="booklet-page">
          <h2>{cur.title}</h2>
          {cur.body}
        </article>
        <div className="booklet-dots" aria-hidden>
          {PAGES.map((_, i) => <button key={i} className={i === page ? 'on' : ''} onClick={() => go(i)} tabIndex={-1} />)}
        </div>
        <div className="booklet-nav">
          <button className="chip" disabled={page === 0} onClick={() => go(page - 1)}>上一页</button>
          {last
            ? <button className="chip on" onClick={close}>开始营业</button>
            : <button className="chip on" onClick={() => go(page + 1)}>下一页</button>}
        </div>
      </div>
    </div>
  );
}

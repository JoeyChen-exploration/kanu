// 新手手册：一本可以左右翻页的小册子（顶栏 📖 打开，第一次进游戏自动打开）。
// 数字全部从 balance.ts 读，调了数值手册跟着变。只讲公开规则，不写顾客心理价位怎么算、品相掉没掉这类隐藏信息。
import { useRef, useState, type ReactNode } from 'react';
import { BLACK_MARKET, FACTIONS, POLICE, DEALER,
  ANNOUNCE, APPRAISAL, BINDER_KINDS, ERRATA, PHONE, GRAND_COLLECTOR, BINDERS, COUNTER, CUSTOMER, CUSTOMER_TYPES, EXCHANGE, LOOSE, PACKS, PITY, RARITIES, RARITY,
  RENT, SERIAL_LIMIT, SHOP_PRICE, SHOWCASE, STARTER_BINDER, STORE, STYLE, STYLES, UNGRADED_MULT, WHOLESALE, PAWN, type CustomerWants, } from '@kanu/shared/balance';
import { Card, GameDayContext, fmt } from './Card.tsx';
import { AVATAR } from './pages/Counter.tsx';
import { FloatWindow } from './drag.tsx';

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
  grand: '高级客人。珍藏柜展示分够高才会上门，只看 UR 以上，出价是富人的两倍，但耐心少、眼光毒。',
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
/** 手册里介绍的客人：MVP 的几类 + 珍藏柜引来的大藏家 */
const mvpTypes = CUSTOMER_TYPES.filter((t) => CUSTOMER[t].mvp || t === 'grand');

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
          <li><b>黑市</b>（黑市关系到熟脸 {FACTIONS.knownMin} 才有门路）：一包 {PACKS.black.price}，稀有卡更多，所有系列的卡都可能出，但每张约 {PACKS.black.fakePpm / 10_000}% 是假卡、{PACKS.black.stolenPpm / 10_000}% 是赃物，没有保底，每天最多 {BLACK_MARKET.perDay} 包。拆出来的卡带"黑"字。</li>
          <li><b>电话批发</b>（买了电话 📞 才有）：一盒 {WHOLESALE.boxPacks} 包，每包打 {Math.round(WHOLESALE.discount * 10)} 折，每天只能订一盒。<b>隔日送达</b>：第二天送货员作为第一位客人来柜台，占一个客人名额，在柜台<b>收货付款</b>（不想要可以拒收，不扣钱）。便宜但<b>批发商不保证正品</b>，每张约 {WHOLESALE.fakePpm / 10_000}% 是假卡；拆出来的卡带"批"字，卖之前用放大镜看看。</li>
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
        <p className="hint">编号限定全服每张卡只有 {SERIAL_LIMIT} 张。图鉴页每个系列一本册子：每张卡有过就点亮（普通图鉴），每种卡面都收集过才算<b>大师图鉴</b> ★。</p>
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
          <li>点开卡册（一个可以挪动的小浮窗），符合他要求的卡会<b>发光</b>，默认排在最前面。把发光的卡<b>拖到柜台台面上</b>，再按按钮成交。</li>
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
        <div className="booklet-customer">
          <span className="booklet-avatar" aria-hidden>{AVATAR.dealer}</span>
          <div>
            <b>卡贩</b> <span className="hint">点了科技树"卡贩门路"才来 · 反过来卖卡给你</span>
            <p className="hint">带 {DEALER.cards[0]}–{DEALER.cards[1]} 张卡摆在柜台上，每张标着市场价，你出价收。属性全不知道，可能是假卡、也可能是赃物，先拿放大镜看。出价够他心里的价就卖，太低他会还价，磨太久就走。收来的卡带"收"字。</p>
          </div>
        </div>
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
        <p className="hint">点开卡册是一个小浮窗，拖住标题栏能挪到屏幕任何位置，一边翻卡册一边整理珍藏柜。卡册在进货页的"用品"里买，不限购。没拆的卡包和珍藏柜里的卡不占格子。</p>
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
        <p><b>珍藏柜</b>是店的门面，客人和别的玩家都看得到。开局没有，在库存页花信用点解锁、升级：</p>
        <table className="booklet-table">
          <tbody>
            {SHOWCASE.levels.slice(1).map((l, i) => (
              <tr key={i}><td>{i === 0 ? '解锁' : `升到 ${i + 1} 级`}</td><td>{fmt(l.price)}</td><td>{l.slots} 格</td></tr>
            ))}
          </tbody>
        </table>
        <ul>
          <li>柜里的卡越稀有，<b>展示分</b>越高（{RARITIES.filter((r) => SHOWCASE.rarityScore[r] > 0).map((r) => `${r} ${SHOWCASE.rarityScore[r]}`).join('、')}，特殊风格再乘倍数）。</li>
          <li>每 {SHOWCASE.pointsPerPct} 分，客人的预算和出价 <b>+1%</b>，最多 +{SHOWCASE.maxPriceBonus * 100}%；到 {SHOWCASE.patienceAt} 分，每位客人耐心 <b>+{SHOWCASE.patienceBonus}</b>。</li>
          <li>展示分到 {GRAND_COLLECTOR.minScore} 分以上，有几率引来 🎩 <b>大藏家</b>，分越高越常来。</li>
          <li>在库存页<b>按住一张卡</b>（手机上长按）拖到珍藏柜就放进去了；拖回卡册或桌面就是取出来。</li>
          <li>柜里的卡有客人要也能直接卖，但卖掉展示分就掉了。</li>
          <li>店倒闭从头开始时，柜里的卡会<b>留下来</b>；不能拿去抵押；不占卡册格子。</li>
        </ul>
      </>
    ),
  },
  {
    title: '放大镜和送评',
    body: (
      <>
        <p>每张卡都有看不见的<b>真伪</b>、<b>品相</b>，少数还是<b>错版</b>（约 {ERRATA.ppm / 10_000}%）。电脑订的货都是正品；以后别的渠道可能混进假货。</p>
        <ul>
          <li><b>放大镜 🔍</b>：在柜台上。按住它拖到卡上就能查验（柜台台面上的卡、卡册浮窗里的卡都行）：看起来真不真、品相大概几分、是不是错版。免费，每张卡只能查一次，只有你知道，不改卡价。放大镜也可能看漏高仿。</li>
          <li><b>电话 📞</b>：花 {fmt(PHONE.price)} 信用点买一部。打给<b>星港评级社</b>送评：把卡拖到电话上，按"送评"。下次打烊出结果。</li>
          <li><b>送评结果</b>：真卡封壳出分（1–10 分、四个分项，还有比 10 分更稀有的<b>黑标</b>），卡价按分数算，10 分是未评级的好几倍；错版会被公开认定，价格再 ×{ERRATA.mult}。送了假卡会被拒评，信誉 −{APPRAISAL.gradeRejectRepLoss}。</li>
          <li>窍门：先用放大镜挑出品相 9–10、或者错版的卡，再送评。</li>
        </ul>
      </>
    ),
  },
  {
    title: '赃物、便衣和巡查',
    body: (
      <>
        <p>卡贩的货来路不明，大约 {Math.round(DEALER.stolenPpm / 10_000)}% 是赃物。赃物看不出来，放大镜只能看真假和品相。</p>
        <ul>
          <li><b>便衣</b>：{POLICE.undercoverPpm / 10_000}% 的客人是治安局的便衣，长得和普通客人一样，有时说话会露破绽（比如问"有没有来路特别一点的"）。把赃卡卖给他：卡没收、不给钱、罚款，信誉 −{POLICE.bustRepLoss}。卖别的卡给他没事。</li>
          <li><b>巡查</b>：打烊后有时会来查店，库存和珍藏柜里的赃卡大概率被查出。选<b>交出</b>（没收，信誉 −{POLICE.surrenderRepLoss}）或<b>打点</b>（付这些卡市场价的 {POLICE.bribePct * 100}%，卡留下）。处理完才能开门。</li>
          <li><b>藏匿室</b>：科技树走"后门生意"路线才有，藏在里面的赃卡巡查不容易查出来（3 格，查出率 20%；地下仓 6 格、10%）。走"挂牌营业"正经路线的店，巡查来得少一半，卖真卡还涨信誉。</li>
          <li><b>举报</b>：觉得卡贩的货是赃物，可以举报他。对了有奖金、信誉 +{POLICE.reportRepGain}；他的货是干净的就是错举，信誉 −{POLICE.falseReportRepLoss}。</li>
          <li>治安局记性很好：常打点、被便衣抓，巡查和便衣会来得更勤；老实交出、举报对了，他们就松一点。</li>
        </ul>
      </>
    ),
  },
  {
    title: '派系',
    body: (
      <>
        <p>城里有三股势力，店铺页能看到你和他们的关系（{FACTIONS.min}～+{FACTIONS.max}，开局 0）。讨好一方，常常会得罪另一方。</p>
        <ul>
          <li>等级：<b>敌对</b>（≤ {FACTIONS.hostileMax}）、<b>陌生</b>、<b>熟脸</b>（≥ {FACTIONS.knownMin}）、<b>盟友</b>（≥ {FACTIONS.allyMin}）。</li>
          {FACTIONS.list.map((f) => <li key={f.id}><b>{f.name}</b>：{f.gain}会涨；得罪：{f.rival}。</li>)}
          <li>卖真卡给普通客人涨商会关系，每个营业日最多算 {FACTIONS.realSalePerDay} 次。</li>
          <li><b>奖励</b>：黑市熟脸才卖你黑市卡包；黑市盟友给你一份失窃登记表副本，每周能查 {FACTIONS.registryPerWeek} 张卡是不是赃物（库存页，把卡拖上去）；正规商会盟友电脑订货 {FACTIONS.guildAlly.storeDiscount * 10} 折、每天多订 {FACTIONS.guildAlly.storePacks} 包。</li>
        </ul>
      </>
    ),
  },
  {
    title: '房租和金币',
    body: (
      <>
        <ul>
          <li><b>摊位费</b>：每 {RENT.everyDays} 个营业日交一次，从 {fmt(RENT.base)} 起，每周涨 {Math.round((RENT.growth - 1) * 100)}%，第 {RENT.capWeek} 周以后不再涨。交不起就倒闭，从头开始。</li>
          <li><b>交不起</b>：交租日打烊时钱不够，柜台先关门、不能进下一天。去"店铺"页把卡抵押给房东（按市场价 {PAWN.loanPct * 100}% 给钱，{PAWN.days} 天内 {PAWN.redeemPct * 100}% 赎回，珍藏柜的卡不收），凑够就交租；实在不行就从头开始，只留珍藏柜里的卡。</li>
          <li><b>买下店铺</b>：攒够 {fmt(SHOP_PRICE)} 信用点买下来，以后就不用交摊位费了。</li>
          <li><b>换金币</b>：信用点可以按 {EXCHANGE.creditsPerCoin} : 1 换成旺财金币，每周最多 {fmt(EXCHANGE.weeklyCapCoins)} 金币。</li>
        </ul>
      </>
    ),
  },
  {
    title: '科技树：把店升级',
    body: (
      <>
        <p>"科技"页是一棵树：从"卡奴小店"往下分出五条分支，每条有一位下层区的联系人卖升级。点节点看详情，按住空白处拖动看整棵树。</p>
        <ul>
          <li><b>点亮</b>：价格按蓝图算，蓝图不够的部分点亮时自动用信用点 1 : 1 换。点过的永久保留，倒闭了也不清空。</li>
          <li><b>条件</b>：第 2 层起要先点前一个，还要做到一些事，比如"成交 10 笔"。</li>
          <li><b>追踪</b>：点节点上的"追踪"，任务栏最上面会显示它还差什么。</li>
          <li><b>二选一</b>：有的节点左右并排，只能点一个，决定你的店走哪条路。</li>
          <li><b>怎么选</b>：二号柜台每天多来一位客人，但货不够卖的话多来的人也买不到东西。先把货备足再点。</li>
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

  // 道具浮窗：一本可以拖到任意位置的小书，不挡住后面的页面操作
  return (
    <FloatWindow id="booklet" className="booklet" title={<>📖 新手手册 <small>{page + 1} / {PAGES.length}</small></>} onClose={close}>
      <div
        className="booklet-inner"
        onTouchStart={(e) => { touchX.current = e.touches[0]?.clientX ?? null; }}
        onTouchEnd={(e) => {
          const start = touchX.current;
          const end = e.changedTouches[0]?.clientX;
          touchX.current = null;
          if (start == null || end == null || Math.abs(end - start) < 50) return;
          go(page + (end < start ? 1 : -1));
        }}
      >
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
    </FloatWindow>
  );
}

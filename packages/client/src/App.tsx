// 卡奴前端：登录 → 底部四个标签页（店铺、进货、库存、图鉴）。
import { useEffect, useRef, useState } from 'react';
import type { ConfigResponse, MeResponse } from '@kanu/shared/types';
import { api } from './api.ts';
import { devLogin, insideDiscord, loginWithDiscord } from './discord.ts';
import { GameDayContext, fmt } from './Card.tsx';
import { Packs } from './pages/Packs.tsx';
import { Inventory } from './pages/Inventory.tsx';
import { Collection } from './pages/Collection.tsx';
import { Counter } from './pages/Counter.tsx';
import { Booklet, bookletUnseen } from './Booklet.tsx';

type State =
  | { kind: 'loading'; text: string }
  | { kind: 'dev-login'; cfg: ConfigResponse }
  | { kind: 'ready'; me: MeResponse }
  | { kind: 'error'; text: string };

type Tab = 'shop' | 'packs' | 'counter' | 'inventory' | 'collection';
const TABS: Array<[Tab, string]> = [['shop', '店铺'], ['packs', '进货'], ['counter', '柜台'], ['inventory', '库存'], ['collection', '图鉴']];

export function App() {
  const [state, setState] = useState<State>({ kind: 'loading', text: '正在开店…' });
  const [tab, setTab] = useState<Tab>('shop');
  /** 新手手册：第一次进游戏自动打开，之后点顶栏 📖 */
  const [booklet, setBooklet] = useState(bookletUnseen);
  const started = useRef(false);

  const loadMe = async () => setState({ kind: 'ready', me: await api<MeResponse>('/me') });

  useEffect(() => {
    if (started.current) return; // StrictMode 下 effect 会跑两次，登录只做一次
    started.current = true;
    (async () => {
      const cfg = await api<ConfigResponse>('/config');
      if (cfg.disabled) return setState({ kind: 'error', text: '卡奴维护中，稍后再来' });
      if (insideDiscord()) {
        setState({ kind: 'loading', text: '正在用 Discord 登录…' });
        await loginWithDiscord(cfg);
        await loadMe();
      } else if (cfg.devAuth) {
        setState({ kind: 'dev-login', cfg });
      } else {
        setState({ kind: 'error', text: '请在 Discord 里打开卡奴' });
      }
    })().catch((e: Error) => setState({ kind: 'error', text: e.message || '出错了' }));
  }, []);

  if (state.kind === 'loading') return <main className="center">{state.text}</main>;
  if (state.kind === 'error') return <main className="center">{state.text}</main>;
  if (state.kind === 'dev-login') return <DevLogin onLogin={async (name) => { await devLogin(name); await loadMe(); }} />;

  const { me } = state;
  const patchMe = (p: Partial<MeResponse>) => setState({ kind: 'ready', me: { ...me, ...p } });

  return (
    <GameDayContext.Provider value={me.gameDay}>
    <div className="app">
      <header className="topbar">
        <Avatar url={me.user.avatar} />
        <span className="topbar-name">{me.user.name}</span>
        <span className="topbar-credits">{fmt(me.credits)} 信用点</span>
        <button className="topbar-book" onClick={() => setBooklet(true)} aria-label="新手手册">📖</button>
      </header>
      {booklet && <Booklet onClose={() => setBooklet(false)} />}
      <main className="content">
        {tab === 'shop' && <Shop me={me} onChange={patchMe} />}
        {tab === 'packs' && <Packs me={me} onChange={patchMe} />}
        {tab === 'counter' && <Counter onChange={patchMe} />}
        {tab === 'inventory' && <Inventory onChange={patchMe} />}
        {tab === 'collection' && <Collection />}
      </main>
      <nav className="tabs">
        {TABS.map(([k, label]) => (
          <button key={k} className={tab === k ? 'on' : ''} onClick={() => { setTab(k); if (k === 'shop') loadMe().catch(() => {}); }}>{label}</button>
        ))}
      </nav>
    </div>
    </GameDayContext.Provider>
  );
}

function DevTools({ onChange }: { onChange: (p: Partial<MeResponse>) => void }) {
  const [value, setValue] = useState('100000');
  const [msg, setMsg] = useState('');
  const save = async () => {
    try {
      const r = await api<{ credits: number }>('/dev/credits', { method: 'POST', body: { credits: Number(value) } });
      onChange({ credits: r.credits });
      setMsg(`已设为 ${fmt(r.credits)}`);
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  return (
    <section className="devtools">
      <h2>测试工具 <small>只有测试账号看得到</small></h2>
      <label className="price-input">
        信用点设为
        <input inputMode="numeric" value={value} onChange={(e) => setValue(e.target.value.replace(/\D/g, ''))} />
      </label>
      <button className="secondary" disabled={!value} onClick={save}>保存</button>
      {msg && <p className="hint">{msg}</p>}
    </section>
  );
}

function Shop({ me, onChange }: { me: MeResponse; onChange: (p: Partial<MeResponse>) => void }) {
  return (
    <section className="page">
      <h1>你好，{me.user.name}</h1>
      <section className="stats">
        <div className="stat"><span className="label">信用点</span><span className="value">{fmt(me.credits)}</span></div>
        <div className="stat">
          <span className="label">旺财金币</span>
          <span className="value">{me.wallet.coins === null ? '暂时查不到' : !me.wallet.opened ? '还没开户' : fmt(me.wallet.coins)}</span>
        </div>
        <div className="stat"><span className="label">信誉</span><span className="value">{me.reputation}</span></div>
        <div className="stat"><span className="label">营业</span><span className="value">第 {me.gameDay} 天</span></div>
      </section>
      <p className="hint">去"进货"开包，再到"柜台"把卡卖给顾客。不清楚规则就点右上角的 📖 看新手手册。</p>
      {me.devTools && <DevTools onChange={onChange} />}
    </section>
  );
}

// Activity 里不能直接请求外部域名（C-1）：Discord 头像走 Developer Portal 里的 URL Mapping
// `/discord-cdn` → `cdn.discordapp.com`。没配映射或加载失败就显示占位。
function Avatar({ url }: { url: string | null }) {
  const [broken, setBroken] = useState(false);
  if (!url || broken) return <div className="avatar placeholder" />;
  const src = insideDiscord() ? url.replace('https://cdn.discordapp.com', '/discord-cdn') : url;
  return <img className="avatar" src={src} alt="" onError={() => setBroken(true)} />;
}

function DevLogin({ onLogin }: { onLogin: (name: string) => Promise<void> }) {
  const [name, setName] = useState('');
  const [err, setErr] = useState('');
  return (
    <main className="center">
      <form
        className="dev-login"
        onSubmit={(e) => {
          e.preventDefault();
          onLogin(name).catch((x: Error) => setErr(x.message));
        }}
      >
        <p>本机开发登录</p>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="随便起个名字" maxLength={20} />
        <button type="submit" disabled={!name.trim()}>进店</button>
        {err && <p className="error">{err}</p>}
      </form>
    </main>
  );
}

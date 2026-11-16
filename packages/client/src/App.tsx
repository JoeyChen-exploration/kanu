// M0 首页：你好，<名字>、信用点、旺财金币余额（SRS M0 / FR-AUTH-7）。
import { useEffect, useRef, useState } from 'react';
import type { ConfigResponse, MeResponse } from '@kanu/shared/types';
import { api } from './api.ts';
import { devLogin, insideDiscord, loginWithDiscord } from './discord.ts';

type State =
  | { kind: 'loading'; text: string }
  | { kind: 'dev-login'; cfg: ConfigResponse }
  | { kind: 'ready'; me: MeResponse }
  | { kind: 'error'; text: string };

const fmt = (n: number) => n.toLocaleString('zh-CN');

export function App() {
  const [state, setState] = useState<State>({ kind: 'loading', text: '正在开店…' });
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
  return (
    <main className="shop">
      <header>
        <Avatar url={me.user.avatar} />
        <h1>你好，{me.user.name}</h1>
      </header>
      <section className="stats">
        <div className="stat">
          <span className="label">信用点</span>
          <span className="value">{fmt(me.credits)}</span>
        </div>
        <div className="stat">
          <span className="label">旺财金币</span>
          <span className="value">
            {me.wallet.coins === null ? '暂时查不到' : !me.wallet.opened ? '还没开户' : fmt(me.wallet.coins)}
          </span>
        </div>
        <div className="stat">
          <span className="label">信誉</span>
          <span className="value">{me.reputation}</span>
        </div>
        <div className="stat">
          <span className="label">摊位</span>
          <span className="value">第 {me.weekNo} 周</span>
        </div>
      </section>
      <p className="hint">店铺还在装修，开包、鉴定和柜台下一步就来。</p>
    </main>
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

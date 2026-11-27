// 空间站日报（DESIGN 8.2）：顶栏 📰 打开的浮窗。今天一条、往前几天的也列出来；小道消息标出来，信不信玩家自己判断。
import { useEffect, useState } from 'react';
import type { NewsResponse, NewsView } from '@kanu/shared/types';
import { api } from './api.ts';
import { FloatWindow } from './drag.tsx';

const md = (d: string) => `${Number(d.slice(5, 7))} 月 ${Number(d.slice(8, 10))} 日`;

function effectText(n: NewsView, today: string): string {
  if (today < n.startDate) return n.startDate === n.endDate ? `${md(n.startDate)}见分晓` : `${md(n.startDate)}起，到${md(n.endDate)}`;
  if (today <= n.endDate) return `正在发酵，到${md(n.endDate)}`;
  return '已经过去了';
}

export function NewsPaper({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<NewsResponse | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { api<NewsResponse>('/news').then(setData).catch((e: Error) => setErr(e.message)); }, []);
  return (
    <FloatWindow id="news" className="float-news" title="📰 空间站日报" onClose={onClose}>
      {!data ? <p className="hint">{err || '取报纸中…'}</p> : data.items.length === 0
        ? <p className="hint">今天的日报还没到（每天早上 8 点，悉尼时间）。</p>
        : (
          <div className="news-list">
            {data.items.map((n) => (
              <article key={n.id} className={`news-item${n.date === data.today ? ' today' : ''}${n.source === 'rumor' ? ' rumor' : ''}`}>
                <header><span className="news-date">{md(n.date)}</span>{n.source === 'rumor' && <span className="news-rumor">小道消息</span>}</header>
                <h3>{n.title}</h3>
                <p>{n.body}</p>
                <small className="hint">{effectText(n, data.today)}</small>
              </article>
            ))}
            <p className="hint">新闻从发布的第二天起影响市场。小道消息有真有假，信不信你自己判断。</p>
          </div>
        )}
    </FloatWindow>
  );
}

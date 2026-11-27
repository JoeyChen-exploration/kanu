// 空间站日报（DESIGN 8.2）：每天悉尼时间 NEWS.hour 点以后第一次检查时发当天的新闻（全服一条），
// 效果从第二天起生效 days 天。newsTick 每个请求和每分钟的定时器都会调，便宜：只比较悉尼日期。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NEWS } from '@kanu/shared/balance';
import type { Deps } from './app.ts';
import type { NewsRow, Repo } from './db/index.ts';
import { newsEffects, rollNews, type NewsTemplate } from './game/news.ts';
import type { Rng } from './game/rng.ts';
import { addDays, sydneyDay, sydneyHour } from './time.ts';

const FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'content', 'news.json');
let cache: NewsTemplate[] | null = null;
export const newsTemplates = (): NewsTemplate[] => (cache ??= (JSON.parse(fs.readFileSync(FILE, 'utf8')) as { templates: NewsTemplate[] }).templates);

/** 按今天生效的真新闻刷新 repo 里的效果缓存（市场价、顾客、巡查都读它） */
export function refreshNews(repo: Repo, today: string) {
  repo.setNewsEffects(today, newsEffects(repo.activeNews(today)));
}

/** 频道里发的那一行 */
export const newsAnnouncement = (n: Pick<NewsRow, 'title' | 'body' | 'source'>) =>
  `📰 **空间站日报**${n.source === 'rumor' ? '（小道消息）' : ''}｜${n.title}\n${n.body}`;

/** 发一条新闻（事务里调用）：自动日报或管理员手动发 */
export function publishNews(repo: Repo, rng: Rng, now: number, opts: { manual: boolean; templateId?: string; target?: string; real?: boolean; source?: 'official' | 'rumor' }): NewsRow {
  const today = sydneyDay(now);
  const tags = [...new Set(repo.allTemplates().flatMap((t) => JSON.parse(t.tags) as string[]))].sort();
  const n = rollNews(rng, { templates: newsTemplates(), series: repo.allSeries(), tags, ...opts });
  const id = repo.insertNews({
    date: today, template: n.templateId, kind: n.kind, target: n.target, title: n.title, body: n.body, source: n.source, real: n.real, mult: n.mult,
    startDate: addDays(today, 1), endDate: addDays(today, n.days), manual: opts.manual, now,
  });
  repo.logEvent('system', now, 'news', { id, date: today, template: n.templateId, kind: n.kind, target: n.target, real: n.real, mult: n.mult, days: n.days, manual: opts.manual });
  return repo.newsSince(today).find((r) => r.id === id)!;
}

/** 到点发当天的日报（deps.news 没开就不自动发）、换日刷新效果缓存 */
export function newsTick(deps: Deps, now: number) {
  const { repo } = deps;
  const today = sydneyDay(now);
  let posted: NewsRow | null = null;
  if (deps.news && sydneyHour(now) >= NEWS.hour && !repo.autoNewsOn(today)) {
    const rng = deps.news.rng;
    posted = repo.db.transaction(() => (repo.autoNewsOn(today) ? null : publishNews(repo, rng, now, { manual: false })))();
  }
  if (posted || repo.newsEffectsDay() !== today) refreshNews(repo, today);
  if (posted) deps.notifier.announce(newsAnnouncement(posted));
}

// 空间站日报（DESIGN 8.2，FR-NEWS-1～3、FR-ADMIN-6）：
//   GET  /api/news               最近几天的新闻（不带真假）
//   GET  /api/admin/news         管理页：带真假和数值、模板列表
//   POST /api/admin/news         管理员手动发一条 { templateId?, target?, real?, source? }，马上发到频道
import type { FastifyInstance } from 'fastify';
import { NEWS } from '@kanu/shared/balance';
import type { AdminNewsItem, AdminNewsResponse, NewsResponse, NewsView } from '@kanu/shared/types';
import { ApiError, fail, type Deps } from '../app.ts';
import type { NewsRow } from '../db/index.ts';
import { newsAnnouncement, newsTemplates, publishNews, refreshNews } from '../news.ts';
import { cryptoRng } from '../rng.ts';
import { addDays, sydneyDay } from '../time.ts';
import { isAdmin } from './admin.ts';

/** 给玩家看的字段白名单：real、mult、kind、target 都不给 */
const toView = (r: NewsRow): NewsView => ({ id: r.id, date: r.date, title: r.title, body: r.body, source: r.source, startDate: r.start_date, endDate: r.end_date });

export function registerNewsRoutes(app: FastifyInstance, deps: Deps, now: () => number) {
  const { repo } = deps;

  app.get('/api/news', async (req, reply) => {
    if (!req.user) return fail(reply, 401, 'unauthorized', '请重新打开卡奴登录');
    const today = sydneyDay(now());
    return { ok: true, today, items: repo.newsSince(addDays(today, 1 - NEWS.keepDays)).map(toView) } satisfies NewsResponse;
  });

  const tags = () => [...new Set(repo.allTemplates().flatMap((t) => JSON.parse(t.tags) as string[]))].sort();

  app.get('/api/admin/news', async (req, reply) => {
    if (!req.user) return fail(reply, 401, 'unauthorized', '请重新打开卡奴登录');
    if (!isAdmin(deps, req.user.id)) return fail(reply, 403, 'forbidden', '只有管理员能用');
    const today = sydneyDay(now());
    const items: AdminNewsItem[] = repo.newsSince(addDays(today, -30)).map((r) => ({ ...toView(r), kind: r.kind, target: r.target, real: r.real === 1, mult: r.mult, manual: r.manual === 1, template: r.template }));
    return { ok: true, items, templates: newsTemplates().map((t) => ({ id: t.id, kind: t.kind, title: t.title })), series: repo.allSeries().map((s) => ({ id: s.id, name: s.name })), tags: tags() } satisfies AdminNewsResponse;
  });

  app.post<{ Body: { templateId?: unknown; target?: unknown; real?: unknown; source?: unknown } }>('/api/admin/news', async (req, reply) => {
    if (!req.user) return fail(reply, 401, 'unauthorized', '请重新打开卡奴登录');
    if (!isAdmin(deps, req.user.id)) return fail(reply, 403, 'forbidden', '只有管理员能用');
    const b = req.body ?? {};
    const opts = {
      manual: true,
      ...(typeof b.templateId === 'string' && b.templateId ? { templateId: b.templateId } : {}),
      ...(typeof b.target === 'string' && b.target ? { target: b.target } : {}),
      ...(typeof b.real === 'boolean' ? { real: b.real } : {}),
      ...(b.source === 'official' || b.source === 'rumor' ? { source: b.source as 'official' | 'rumor' } : {}),
    };
    const t = now();
    const row = repo.db.transaction(() => {
      try {
        const r = publishNews(repo, deps.news ? deps.news.rng : cryptoRng, t, opts);
        repo.logEvent(req.user!.id, t, 'admin_news', { news: r.id });
        return r;
      } catch (e) { throw new ApiError(400, 'bad_news', (e as Error).message); }
    })();
    refreshNews(repo, sydneyDay(t));
    deps.notifier.announce(newsAnnouncement(row));
    return { ok: true, item: { ...toView(row), kind: row.kind, target: row.target, real: row.real === 1, mult: row.mult, manual: true, template: row.template } };
  });
}

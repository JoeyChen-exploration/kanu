// 卡牌系列内容：packages/server/content/series/*.json，启动时导入数据库（FR-ADMIN-4 的最小版）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RARITIES, RARITY } from '@kanu/shared/balance';
import type { Repo, SeriesContent } from './db/index.ts';

export const CONTENT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'content', 'series');

export function loadSeries(dir = CONTENT_DIR): SeriesContent[] {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as SeriesContent);
}

/** 每个稀有度的张数要和 DESIGN 3.2 对上，否则开包的模板下标会越界 */
export function checkSeries(s: SeriesContent): string[] {
  const errors: string[] = [];
  for (const r of RARITIES) {
    const n = s.cards.filter((c) => c.rarity === r).length;
    if (n !== RARITY[r].perSeries) errors.push(`${s.id} 的 ${r} 有 ${n} 张，应该是 ${RARITY[r].perSeries} 张`);
  }
  const ids = new Set<string>();
  for (const c of s.cards) {
    if (ids.has(c.id)) errors.push(`${c.id} 重复`);
    ids.add(c.id);
  }
  return errors;
}

export function importAllSeries(repo: Repo, dir = CONTENT_DIR): string[] {
  const all = loadSeries(dir);
  for (const s of all) {
    const errors = checkSeries(s);
    if (errors.length) throw new Error(`卡牌内容有问题：\n${errors.join('\n')}`);
    repo.importSeries(s);
  }
  return all.map((s) => s.id);
}

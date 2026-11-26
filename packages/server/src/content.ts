// 卡牌系列内容：packages/server/content/series/*.json，启动时导入数据库（FR-ADMIN-4 的最小版）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PACKS, RARITIES, RARITY } from '@kanu/shared/balance';
import type { Repo, SeriesContent } from './db/index.ts';

export const CONTENT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'content', 'series');

export function loadSeries(dir = CONTENT_DIR): SeriesContent[] {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as SeriesContent);
}

/** 每个稀有度的张数要和这类卡包的构成（PACKS[kind].composition，DESIGN 3.2）对上，否则开包的模板下标会越界 */
export function checkSeries(s: SeriesContent): string[] {
  const errors: string[] = [];
  if (s.kind !== 'themed' && s.kind !== 'premium') return [`${s.id} 的 kind 要是 themed 或 premium`];
  const want = PACKS[s.kind].composition;
  for (const r of RARITIES) {
    const n = s.cards.filter((c) => c.rarity === r).length;
    if (n !== want[r]) errors.push(`${s.id}（${PACKS[s.kind].name}）的 ${r} 有 ${n} 张，应该是 ${want[r]} 张`);
  }
  for (const c of s.cards) if (!RARITY[c.rarity]) errors.push(`${c.id} 的稀有度 ${c.rarity} 不认识`);
  const ids = new Set<string>();
  for (const c of s.cards) {
    if (ids.has(c.id)) errors.push(`${c.id} 重复`);
    ids.add(c.id);
  }
  return errors;
}

/** 顾客台词（FR-CTR-7）：content/lines.json，按"顾客类型 → 场景"分组 */
/** bust：便衣抓人；busted / false_report：举报卡贩对了 / 错了（卡贩的台词） */
export type LineEvent = 'greet' | 'counter' | 'too_high' | 'deal' | 'left' | 'bust' | 'busted' | 'false_report';
export interface Lines {
  byType: Record<string, Record<LineEvent, string[]>>;
  caught: string[];
}

export function loadLines(file = path.resolve(CONTENT_DIR, '..', 'lines.json')): Lines {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  const { note: _note, caught, ...byType } = raw;
  return { byType: byType as Lines['byType'], caught: caught as string[] };
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

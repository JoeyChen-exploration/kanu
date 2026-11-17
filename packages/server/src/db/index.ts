// SQLite（better-sqlite3）。迁移只往前加，按 user_version 记版本，重启不会重复跑。
// 隐藏属性（authenticity、grade、origin）只存在 card_instances 里，读给玩家的查询一律走 toCardView，不带这些列。
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { PLAYER, RARITY, type Rarity, type Style } from '@kanu/shared/balance';
import type { CardLocation, CardView, SessionUser } from '@kanu/shared/types';
import { publicPrice } from '../game/price.ts';

const MIGRATIONS: string[] = [
  // 1：M0 建档（players、events_log）
  `CREATE TABLE players (
     discord_id   TEXT PRIMARY KEY,
     display_name TEXT NOT NULL,
     avatar       TEXT,
     credits      INTEGER NOT NULL,
     reputation   INTEGER NOT NULL,
     week_no      INTEGER NOT NULL DEFAULT 1,
     created_at   INTEGER NOT NULL
   );
   CREATE TABLE events_log (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     at         INTEGER NOT NULL,
     discord_id TEXT,
     kind       TEXT NOT NULL,
     data       TEXT NOT NULL
   );
   CREATE INDEX events_log_player ON events_log (discord_id, at);`,

  // 2：M2 开包与库存
  `ALTER TABLE players ADD COLUMN pity_count INTEGER NOT NULL DEFAULT 0;
   CREATE TABLE series (
     id   TEXT PRIMARY KEY,
     name TEXT NOT NULL
   );
   CREATE TABLE card_templates (
     id        TEXT PRIMARY KEY,
     series_id TEXT NOT NULL REFERENCES series(id),
     name      TEXT NOT NULL,
     rarity    TEXT NOT NULL,
     tags      TEXT NOT NULL,
     flavor    TEXT,
     image     TEXT
   );
   CREATE INDEX card_templates_rarity ON card_templates (series_id, rarity, id);
   CREATE TABLE card_instances (
     id           INTEGER PRIMARY KEY AUTOINCREMENT,
     template_id  TEXT NOT NULL REFERENCES card_templates(id),
     owner_id     TEXT NOT NULL REFERENCES players(discord_id),
     authenticity TEXT NOT NULL,
     grade        TEXT NOT NULL,
     origin       TEXT NOT NULL,
     style        TEXT NOT NULL,
     serial_no    INTEGER,
     location     TEXT NOT NULL DEFAULT 'inventory',
     created_at   INTEGER NOT NULL
   );
   CREATE INDEX card_instances_owner ON card_instances (owner_id, location, id);
   CREATE UNIQUE INDEX card_instances_serial ON card_instances (template_id, serial_no) WHERE serial_no IS NOT NULL;
   CREATE TABLE serials (
     template_id TEXT PRIMARY KEY REFERENCES card_templates(id),
     next_serial INTEGER NOT NULL DEFAULT 1
   );
   CREATE TABLE collection (
     discord_id  TEXT NOT NULL,
     template_id TEXT NOT NULL,
     first_at    INTEGER NOT NULL,
     PRIMARY KEY (discord_id, template_id)
   );
   CREATE TABLE daily_usage (
     discord_id   TEXT NOT NULL,
     sydney_day   TEXT NOT NULL,
     packs_normal INTEGER NOT NULL DEFAULT 0,
     packs_black  INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (discord_id, sydney_day)
   );
   CREATE TABLE idempotency (
     key        TEXT NOT NULL,
     discord_id TEXT NOT NULL,
     response   TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (discord_id, key)
   );`,
];

export interface PlayerRow {
  discord_id: string;
  display_name: string;
  avatar: string | null;
  credits: number;
  reputation: number;
  week_no: number;
  pity_count: number;
  created_at: number;
}

export interface TemplateRow {
  id: string;
  series_id: string;
  name: string;
  rarity: Rarity;
  tags: string;
  flavor: string | null;
  image: string | null;
}

/** card_instances 的完整一行，含隐藏属性：只能在服务器内部用 */
export interface InstanceRow {
  id: number;
  template_id: string;
  owner_id: string;
  authenticity: string;
  grade: string;
  origin: string;
  style: Style;
  serial_no: number | null;
  location: CardLocation;
  created_at: number;
}

export interface SeriesContent {
  id: string;
  name: string;
  cards: Array<{ id: string; name: string; rarity: Rarity; tags: string[]; flavor?: string; image?: string }>;
}

export function openDb(file: string) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return createRepo(db);
}

function migrate(db: Database.Database) {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v += 1) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

function createRepo(db: Database.Database) {
  const q = {
    getPlayer: db.prepare<[string], PlayerRow>('SELECT * FROM players WHERE discord_id = ?'),
    insertPlayer: db.prepare(
      'INSERT INTO players (discord_id, display_name, avatar, credits, reputation, week_no, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
    ),
    updateProfile: db.prepare('UPDATE players SET display_name = ?, avatar = ? WHERE discord_id = ?'),
    setCreditsPity: db.prepare('UPDATE players SET credits = ?, pity_count = ? WHERE discord_id = ?'),
    insertEvent: db.prepare('INSERT INTO events_log (at, discord_id, kind, data) VALUES (?, ?, ?, ?)'),

    upsertSeries: db.prepare('INSERT INTO series (id, name) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name'),
    upsertTemplate: db.prepare(
      `INSERT INTO card_templates (id, series_id, name, rarity, tags, flavor, image) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET series_id = excluded.series_id, name = excluded.name, rarity = excluded.rarity,
         tags = excluded.tags, flavor = excluded.flavor, image = excluded.image`,
    ),
    templatesBySeriesRarity: db.prepare<[string, string], TemplateRow>(
      'SELECT * FROM card_templates WHERE series_id = ? AND rarity = ? ORDER BY id',
    ),
    allSeries: db.prepare<[], { id: string; name: string }>('SELECT id, name FROM series ORDER BY id'),
    allTemplates: db.prepare<[], TemplateRow>('SELECT * FROM card_templates ORDER BY id'),

    ensureSerial: db.prepare('INSERT INTO serials (template_id, next_serial) VALUES (?, 1) ON CONFLICT(template_id) DO NOTHING'),
    getSerial: db.prepare<[string], { next_serial: number }>('SELECT next_serial FROM serials WHERE template_id = ?'),
    bumpSerial: db.prepare('UPDATE serials SET next_serial = next_serial + 1 WHERE template_id = ?'),

    insertInstance: db.prepare(
      `INSERT INTO card_instances (template_id, owner_id, authenticity, grade, origin, style, serial_no, location, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'inventory', ?)`,
    ),
    markCollected: db.prepare('INSERT INTO collection (discord_id, template_id, first_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING'),

    getUsage: db.prepare<[string, string], { packs_normal: number; packs_black: number }>(
      'SELECT packs_normal, packs_black FROM daily_usage WHERE discord_id = ? AND sydney_day = ?',
    ),
    bumpNormal: db.prepare(
      `INSERT INTO daily_usage (discord_id, sydney_day, packs_normal) VALUES (?, ?, 1)
       ON CONFLICT(discord_id, sydney_day) DO UPDATE SET packs_normal = packs_normal + 1`,
    ),

    getIdem: db.prepare<[string, string], { response: string }>('SELECT response FROM idempotency WHERE discord_id = ? AND key = ?'),
    putIdem: db.prepare('INSERT INTO idempotency (key, discord_id, response, created_at) VALUES (?, ?, ?, ?)'),
    pruneIdem: db.prepare('DELETE FROM idempotency WHERE created_at < ?'),

    cardsWithTemplate: `SELECT i.id, i.template_id, i.style, i.serial_no, i.location, i.created_at,
                               t.name, t.rarity, t.tags, t.flavor, t.series_id, s.name AS series_name
                        FROM card_instances i JOIN card_templates t ON t.id = i.template_id JOIN series s ON s.id = t.series_id`,
  };

  const viewSql = db.prepare<[number], CardViewRow>(`${q.cardsWithTemplate} WHERE i.id = ?`);

  const repo = {
    db,
    getPlayer: (id: string) => q.getPlayer.get(id) ?? null,

    /** 第一次登录自动建档（FR-AUTH-5）；之后每次登录只同步名字和头像。建档和流水在一个事务里（DR-1、DR-2）。 */
    ensurePlayer: db.transaction((user: SessionUser, now: number): PlayerRow => {
      const existing = q.getPlayer.get(user.id);
      if (existing) {
        q.updateProfile.run(user.name, user.avatar, user.id);
        return { ...existing, display_name: user.name, avatar: user.avatar };
      }
      q.insertPlayer.run(user.id, user.name, user.avatar, PLAYER.startCredits, PLAYER.startReputation, now);
      repo.logCredits(user.id, now, PLAYER.startCredits, 'open', PLAYER.startCredits);
      return q.getPlayer.get(user.id)!;
    }),

    logCredits(discordId: string, now: number, delta: number, why: string, bal: number, extra: Record<string, unknown> = {}) {
      q.insertEvent.run(now, discordId, 'credits', JSON.stringify({ delta, why, bal, ...extra }));
    },
    logEvent(discordId: string | null, now: number, kind: string, data: Record<string, unknown>) {
      q.insertEvent.run(now, discordId, kind, JSON.stringify(data));
    },
    setCreditsPity(discordId: string, credits: number, pity: number) {
      q.setCreditsPity.run(credits, pity, discordId);
    },

    // ---- 系列和模板（FR-ADMIN-4 的最小版：启动时从 content/ 导入） ----
    importSeries: db.transaction((content: SeriesContent) => {
      q.upsertSeries.run(content.id, content.name);
      for (const c of content.cards) {
        if (!RARITY[c.rarity]) throw new Error(`${c.id} 的稀有度 ${c.rarity} 不认识`);
        q.upsertTemplate.run(c.id, content.id, c.name, c.rarity, JSON.stringify(c.tags), c.flavor ?? null, c.image ?? null);
        q.ensureSerial.run(c.id);
      }
    }),
    templatesFor: (seriesId: string, rarity: Rarity) => q.templatesBySeriesRarity.all(seriesId, rarity),
    allSeries: () => q.allSeries.all(),
    allTemplates: () => q.allTemplates.all(),

    // ---- 编号限定（FR-PACK-5）：只在事务里调用，保证不重号 ----
    serialLeft: (templateId: string, limit: number) => (q.getSerial.get(templateId)?.next_serial ?? 1) <= limit,
    takeSerial(templateId: string, limit: number): number | null {
      const next = q.getSerial.get(templateId)?.next_serial ?? 1;
      if (next > limit) return null;
      q.bumpSerial.run(templateId);
      return next;
    },

    insertCard(c: { templateId: string; ownerId: string; authenticity: string; grade: string; origin: string; style: Style; serialNo: number | null; now: number }): number {
      const r = q.insertInstance.run(c.templateId, c.ownerId, c.authenticity, c.grade, c.origin, c.style, c.serialNo, c.now);
      // 图鉴只认真卡（DESIGN 3.6）。黑市包上线后，假卡和来路不明的卡要等验真后再点亮，否则图鉴会泄露真伪
      if (c.authenticity === 'real') q.markCollected.run(c.ownerId, c.templateId, c.now);
      return Number(r.lastInsertRowid);
    },

    packsOpenedToday: (discordId: string, day: string) => q.getUsage.get(discordId, day)?.packs_normal ?? 0,
    bumpNormalPacks: (discordId: string, day: string) => q.bumpNormal.run(discordId, day),

    // ---- 幂等（NFR-SEC-5） ----
    getIdempotent: <T>(discordId: string, key: string): T | null => {
      const row = q.getIdem.get(discordId, key);
      return row ? (JSON.parse(row.response) as T) : null;
    },
    putIdempotent: (discordId: string, key: string, response: unknown, now: number) => {
      q.putIdem.run(key, discordId, JSON.stringify(response), now);
    },
    pruneIdempotency: (before: number) => q.pruneIdem.run(before).changes,

    // ---- 读给玩家看的卡牌：只有公开信息 ----
    cardView: (id: number): CardView | null => {
      const row = viewSql.get(id);
      return row ? toCardView(row) : null;
    },
    inventory(ownerId: string, opts: { rarity?: string; location?: CardLocation; page: number; pageSize: number }) {
      const where = ['i.owner_id = ?'];
      const args: unknown[] = [ownerId];
      if (opts.rarity) { where.push('t.rarity = ?'); args.push(opts.rarity); }
      if (opts.location) { where.push('i.location = ?'); args.push(opts.location); }
      const w = where.join(' AND ');
      const total = (db.prepare(`SELECT COUNT(*) AS n FROM card_instances i JOIN card_templates t ON t.id = i.template_id WHERE ${w}`).get(...args) as { n: number }).n;
      const rows = db.prepare(`${q.cardsWithTemplate} WHERE ${w} ORDER BY i.id DESC LIMIT ? OFFSET ?`)
        .all(...args, opts.pageSize, (opts.page - 1) * opts.pageSize) as CardViewRow[];
      return { total, cards: rows.map(toCardView) };
    },
    ownedInstance: (ownerId: string, id: number) =>
      (db.prepare('SELECT * FROM card_instances WHERE id = ? AND owner_id = ?').get(id, ownerId) as InstanceRow | undefined) ?? null,
    countLocation: (ownerId: string, location: CardLocation) =>
      (db.prepare('SELECT COUNT(*) AS n FROM card_instances WHERE owner_id = ? AND location = ?').get(ownerId, location) as { n: number }).n,
    setLocation: (id: number, location: CardLocation) => db.prepare('UPDATE card_instances SET location = ? WHERE id = ?').run(location, id),

    collection(ownerId: string) {
      const owned = new Set((db.prepare('SELECT template_id FROM collection WHERE discord_id = ?').all(ownerId) as Array<{ template_id: string }>).map((r) => r.template_id));
      const counts = new Map((db.prepare('SELECT template_id, COUNT(*) AS n FROM card_instances WHERE owner_id = ? GROUP BY template_id').all(ownerId) as Array<{ template_id: string; n: number }>).map((r) => [r.template_id, r.n]));
      return { owned, counts };
    },

    close: () => db.close(),
  };
  return repo;
}

interface CardViewRow {
  id: number;
  template_id: string;
  style: Style;
  serial_no: number | null;
  location: CardLocation;
  created_at: number;
  name: string;
  rarity: Rarity;
  tags: string;
  flavor: string | null;
  series_id: string;
  series_name: string;
}

/** 唯一一个把卡牌交给玩家的出口：字段白名单，隐藏属性根本不在 CardViewRow 里 */
function toCardView(r: CardViewRow): CardView {
  return {
    id: r.id,
    templateId: r.template_id,
    name: r.name,
    seriesId: r.series_id,
    seriesName: r.series_name,
    rarity: r.rarity,
    tags: JSON.parse(r.tags) as string[],
    flavor: r.flavor,
    style: r.style,
    serialNo: r.serial_no,
    location: r.location,
    price: publicPrice({ rarity: r.rarity, style: r.style, publicGrade: null }),
    createdAt: r.created_at,
  };
}

export type Repo = ReturnType<typeof openDb>;

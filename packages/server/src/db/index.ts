// SQLite（better-sqlite3）。迁移只往前加，按 user_version 记版本，重启不会重复跑。
// 隐藏属性（authenticity、grade、origin）只存在 card_instances 里，读给玩家的查询一律走 toCardView，不带这些列。
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { PLAYER, RARITIES, RARITY, type Grade, type QuestMetric, type Rarity, type Style } from '@kanu/shared/balance';
import type { CardLocation, CardView, SessionUser } from '@kanu/shared/types';
import { publicPrice } from '../game/price.ts';

/** 卡册排序（2026-11-18 用户定）：稀有度从高到低，同一张卡挨在一起，再按放进去的先后 */
const BINDER_ORDER = `CASE t.rarity ${[...RARITIES].reverse().map((r, k) => `WHEN '${r}' THEN ${k}`).join(' ')} ELSE 99 END, t.id, i.style, i.id`;

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

  // 3：M4 柜台。float（个人浮动）是隐藏的，心理价位每次出价时现算，都不发给玩家
  `CREATE TABLE customers (
     id            INTEGER PRIMARY KEY AUTOINCREMENT,
     owner_id      TEXT NOT NULL REFERENCES players(discord_id),
     sydney_day    TEXT NOT NULL,
     slot          INTEGER NOT NULL,
     seat          INTEGER NOT NULL,
     type          TEXT NOT NULL,
     demand        TEXT NOT NULL,
     float         REAL NOT NULL,
     patience      INTEGER NOT NULL,
     status        TEXT NOT NULL DEFAULT 'waiting',
     line          TEXT NOT NULL,
     budget_low    INTEGER NOT NULL,
     budget_high   INTEGER NOT NULL,
     counter_price INTEGER,
     created_at    INTEGER NOT NULL,
     UNIQUE (owner_id, sydney_day, slot, seat)
   );`,

  // 4：营业日改成玩家自己推进（2026-11-17）。"哪一天"用 day_key 表示（营业日写成 g12），不再是悉尼日期
  `ALTER TABLE players ADD COLUMN game_day INTEGER NOT NULL DEFAULT 1;
   ALTER TABLE customers RENAME COLUMN sydney_day TO day_key;
   ALTER TABLE daily_usage RENAME COLUMN sydney_day TO day_key;`,

  // 5：卡包重做（2026-11-17）。series 加卡包类型；模板可以停用（内容里删掉的旧卡，玩家手上的照常保留）；
  // 买来的卡包先原封不动放在 sealed_packs，拆的时候才发卡。daily_usage.packs_normal 现在记电脑订货的包数
  `ALTER TABLE series ADD COLUMN kind TEXT NOT NULL DEFAULT 'themed';
   ALTER TABLE card_templates ADD COLUMN retired INTEGER NOT NULL DEFAULT 0;
   CREATE TABLE sealed_packs (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     owner_id   TEXT NOT NULL REFERENCES players(discord_id),
     series_id  TEXT NOT NULL REFERENCES series(id),
     source     TEXT NOT NULL,
     box_id     INTEGER,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX sealed_packs_owner ON sealed_packs (owner_id, series_id);`,

  // 6：顾客一位一位进门（2026-11-17）。day_customer_count 是本营业日一共来几位（第一次开柜台时定，打烊清零），
  // 不发给玩家：玩家不知道今天还剩几位
  `ALTER TABLE players ADD COLUMN day_customer_count INTEGER NOT NULL DEFAULT 0;`,

  // 7：卡册（2026-11-17）。卡在库存里时要么在某本卡册里（binder_id），要么散放在桌面上（binder_id 为空）。
  // loose_since_day 是开始散放的营业日（画磨损用，公开信息）；真正的品相变化只改 grade（隐藏）
  `CREATE TABLE binders (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     owner_id   TEXT NOT NULL REFERENCES players(discord_id),
     kind       TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX binders_owner ON binders (owner_id);
   ALTER TABLE card_instances ADD COLUMN binder_id INTEGER REFERENCES binders(id);
   ALTER TABLE card_instances ADD COLUMN loose_since_day INTEGER;`,

  // 8：珍藏柜不占卡册格子（2026-11-17）。之前放进珍藏柜的卡还挂在卡册上，清掉
  `UPDATE card_instances SET binder_id = NULL, loose_since_day = NULL WHERE location = 'showcase';`,

  // 9：珍藏柜要解锁、升级（2026-11-17）。老存档里已经放了卡的玩家直接送 1 级。
  // 顾客的耐心上限按进门时算（珍藏柜加成会让耐心多 1 点），存下来给前端画耐心条
  `ALTER TABLE players ADD COLUMN showcase_level INTEGER NOT NULL DEFAULT 0;
   UPDATE players SET showcase_level = 1 WHERE discord_id IN (SELECT owner_id FROM card_instances WHERE location = 'showcase');
   ALTER TABLE customers ADD COLUMN max_patience INTEGER NOT NULL DEFAULT 0;`,

  // 10：大师图鉴（2026-11-17 用户定，从第四阶段提前）：每张卡的每种外层风格"有过"就记一笔（卖掉也算）。
  // 老存档按现在手上的真卡补记；以前卖掉的风格已经查不到了
  `CREATE TABLE collection_styles (
     discord_id  TEXT NOT NULL,
     template_id TEXT NOT NULL,
     style       TEXT NOT NULL,
     first_at    INTEGER NOT NULL,
     PRIMARY KEY (discord_id, template_id, style)
   );
   INSERT OR IGNORE INTO collection_styles (discord_id, template_id, style, first_at)
     SELECT owner_id, template_id, style, MIN(created_at) FROM card_instances WHERE authenticity = 'real' GROUP BY owner_id, template_id, style;`,

  // 11：任务栏 / 新手指引（2026-11-17）：领过哪些任务的奖励
  `CREATE TABLE quest_claims (
     discord_id TEXT NOT NULL,
     quest_id   TEXT NOT NULL,
     claimed_at INTEGER NOT NULL,
     PRIMARY KEY (discord_id, quest_id)
   );`,

  // 12：鉴定（M3，DESIGN 5）。卡上的公开结果：verified 已验真、slab_score / slab_subgrades 封壳评分、
  // grade_rejected 评级社拒评标记；ready_day 是送去鉴定机构 / 评级社的卡哪个营业日出结果（location = lab / grading）。
  // appraisals 存每张卡每种方式的结论（只给这张卡的主人看），每种方式最多一次（FR-APPR-1）
  `ALTER TABLE card_instances ADD COLUMN verified INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE card_instances ADD COLUMN slab_score TEXT;
   ALTER TABLE card_instances ADD COLUMN slab_subgrades TEXT;
   ALTER TABLE card_instances ADD COLUMN grade_rejected INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE card_instances ADD COLUMN ready_day INTEGER;
   CREATE TABLE appraisals (
     card_id    INTEGER NOT NULL,
     method     TEXT NOT NULL,
     result     TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (card_id, method)
   );`,

  // 13：鉴定重定（2026-11-17 用户定）：没有鉴定机构了（verified 列留着不用）；放大镜查验存在 appraisals（method = inspect）；
  // 错版卡（misprint 隐藏，slab_errata 是封壳时公开认定的错版）；电话要买（players.phone）
  `ALTER TABLE card_instances ADD COLUMN misprint INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE card_instances ADD COLUMN slab_errata INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE players ADD COLUMN phone INTEGER NOT NULL DEFAULT 0;
   UPDATE card_instances SET location = 'inventory', ready_day = NULL WHERE location = 'lab';`,

  // 14：电话批发（2026-11-18）。acquired 是卡从哪来的（公开）：store 电脑订货、wholesale 电话批发。
  // 玩家知道哪些卡来路不保证，好拿放大镜看
  `ALTER TABLE card_instances ADD COLUMN acquired TEXT NOT NULL DEFAULT 'store';`,

  // 15：批发订单（2026-11-18 用户定：货由送货员送到柜台，货到付款）。status：pending 等送货、delivered 收了、refused 拒收
  `CREATE TABLE wholesale_orders (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     owner_id    TEXT NOT NULL REFERENCES players(discord_id),
     series_id   TEXT NOT NULL,
     packs       INTEGER NOT NULL,
     price       INTEGER NOT NULL,
     ordered_day INTEGER NOT NULL,
     status      TEXT NOT NULL DEFAULT 'pending',
     created_at  INTEGER NOT NULL
   );
   CREATE INDEX wholesale_orders_owner ON wholesale_orders (owner_id, status);`,
  // 16：科技树（docs/TECH-TREE.md MVP）。点过的节点永久保留；蓝图余额；任务栏里追踪的节点
  `CREATE TABLE tech_owned (
     discord_id TEXT NOT NULL REFERENCES players(discord_id),
     node_id    TEXT NOT NULL,
     bought_at  INTEGER NOT NULL,
     PRIMARY KEY (discord_id, node_id)
   );
   ALTER TABLE players ADD COLUMN blueprints INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE players ADD COLUMN tech_tracked TEXT;`,
  // 17：房租（DESIGN 7，FR-RENT）。run_start_day = 这一轮从哪个营业日开始（破产后重算）；shop_owned 买下店铺；
  // rent_due > 0 表示欠租（交租日打烊时钱不够），rent_week 是欠的第几周。pawns：抵押给房东的卡（卡本身 location = 'pawned'）
  `ALTER TABLE players ADD COLUMN run_start_day INTEGER NOT NULL DEFAULT 1;
   ALTER TABLE players ADD COLUMN shop_owned INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE players ADD COLUMN rent_due INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE players ADD COLUMN rent_week INTEGER NOT NULL DEFAULT 0;
   CREATE TABLE pawns (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     owner_id    TEXT NOT NULL REFERENCES players(discord_id),
     card_id     INTEGER NOT NULL,
     loan        INTEGER NOT NULL,
     redeem      INTEGER NOT NULL,
     pawned_day  INTEGER NOT NULL,
     due_day     INTEGER NOT NULL,
     status      TEXT NOT NULL DEFAULT 'active',
     created_at  INTEGER NOT NULL
   );
   CREATE INDEX pawns_owner ON pawns (owner_id, status);`,
];

/** 营业日在 customers、daily_usage 里的键 */
export const dayKey = (gameDay: number) => `g${gameDay}`;

export interface CustomerRow {
  id: number;
  owner_id: string;
  day_key: string;
  slot: number;
  seat: number;
  type: string;
  demand: string;
  float: number;
  patience: number;
  status: string;
  line: string;
  budget_low: number;
  budget_high: number;
  counter_price: number | null;
  /** 进门时的耐心（含珍藏柜加成）；老数据为 0 */
  max_patience: number;
  created_at: number;
}

export interface PlayerRow {
  discord_id: string;
  display_name: string;
  avatar: string | null;
  credits: number;
  reputation: number;
  week_no: number;
  pity_count: number;
  game_day: number;
  day_customer_count: number;
  showcase_level: number;
  /** 买了电话没有（1 = 有） */
  phone: number;
  /** 蓝图余额（科技树货币） */
  blueprints: number;
  /** 任务栏里追踪的科技树节点 */
  tech_tracked: string | null;
  /** 这一轮从哪个营业日开始（破产后重算周数） */
  run_start_day: number;
  /** 买下店铺没有（1 = 是店主，不再交租） */
  shop_owned: number;
  /** 欠租金额（0 = 没欠）；欠的是第几周 */
  rent_due: number;
  rent_week: number;
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
  binder_id: number | null;
  loose_since_day: number | null;
  created_at: number;
  slab_score: string | null;
  slab_subgrades: string | null;
  slab_errata: number;
  grade_rejected: number;
  ready_day: number | null;
  /** 错版（隐藏） */
  misprint: number;
}

export interface SeriesContent {
  id: string;
  name: string;
  /** 主题包 / 典藏包，决定价格、爆率和每种稀有度几张（PACKS[kind]） */
  kind: 'themed' | 'premium';
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

    upsertSeries: db.prepare('INSERT INTO series (id, name, kind) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = excluded.kind'),
    upsertTemplate: db.prepare(
      `INSERT INTO card_templates (id, series_id, name, rarity, tags, flavor, image) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET series_id = excluded.series_id, name = excluded.name, rarity = excluded.rarity,
         tags = excluded.tags, flavor = excluded.flavor, image = excluded.image, retired = 0`,
    ),
    templatesBySeriesRarity: db.prepare<[string, string], TemplateRow>(
      'SELECT * FROM card_templates WHERE series_id = ? AND rarity = ? AND retired = 0 ORDER BY id',
    ),
    allSeries: db.prepare<[], { id: string; name: string; kind: 'themed' | 'premium' }>("SELECT s.id, s.name, s.kind FROM series s WHERE EXISTS (SELECT 1 FROM card_templates t WHERE t.series_id = s.id AND t.retired = 0) ORDER BY s.kind DESC, s.id"),
    allTemplates: db.prepare<[], TemplateRow>('SELECT * FROM card_templates WHERE retired = 0 ORDER BY id'),
    retireMissing: db.prepare("UPDATE card_templates SET retired = 1 WHERE series_id = ? AND id NOT IN (SELECT value FROM json_each(?))"),

    ensureSerial: db.prepare('INSERT INTO serials (template_id, next_serial) VALUES (?, 1) ON CONFLICT(template_id) DO NOTHING'),
    getSerial: db.prepare<[string], { next_serial: number }>('SELECT next_serial FROM serials WHERE template_id = ?'),
    bumpSerial: db.prepare('UPDATE serials SET next_serial = next_serial + 1 WHERE template_id = ?'),

    insertInstance: db.prepare(
      `INSERT INTO card_instances (template_id, owner_id, authenticity, grade, origin, style, serial_no, location, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'inventory', ?)`,
    ),
    markCollected: db.prepare('INSERT INTO collection (discord_id, template_id, first_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING'),
    markStyleCollected: db.prepare('INSERT INTO collection_styles (discord_id, template_id, style, first_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING'),

    getUsage: db.prepare<[string, string], { packs_normal: number; packs_black: number }>(
      'SELECT packs_normal, packs_black FROM daily_usage WHERE discord_id = ? AND day_key = ?',
    ),
    bumpNormal: db.prepare(
      `INSERT INTO daily_usage (discord_id, day_key, packs_normal) VALUES (?, ?, 1)
       ON CONFLICT(discord_id, day_key) DO UPDATE SET packs_normal = packs_normal + 1`,
    ),

    getIdem: db.prepare<[string, string], { response: string }>('SELECT response FROM idempotency WHERE discord_id = ? AND key = ?'),
    putIdem: db.prepare('INSERT INTO idempotency (key, discord_id, response, created_at) VALUES (?, ?, ?, ?)'),
    pruneIdem: db.prepare('DELETE FROM idempotency WHERE created_at < ?'),

    cardsWithTemplate: `SELECT i.id, i.template_id, i.style, i.serial_no, i.location, i.binder_id, i.loose_since_day, i.created_at,
                               i.slab_score, i.slab_subgrades, i.slab_errata, i.grade_rejected, i.ready_day, i.acquired,
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
      q.upsertSeries.run(content.id, content.name, content.kind);
      for (const c of content.cards) {
        if (!RARITY[c.rarity]) throw new Error(`${c.id} 的稀有度 ${c.rarity} 不认识`);
        q.upsertTemplate.run(c.id, content.id, c.name, c.rarity, JSON.stringify(c.tags), c.flavor ?? null, c.image ?? null);
        q.ensureSerial.run(c.id);
      }
      // 内容里删掉的旧卡停用：不再开出来、图鉴不再显示，玩家手上的照常保留
      q.retireMissing.run(content.id, JSON.stringify(content.cards.map((c) => c.id)));
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

    /**
     * 新卡入库。collect：要不要马上点亮图鉴——只能按公开信息决定（M3 修）：电脑订货保证正品，拆出来就点亮；
     * 以后电话批发、卡贩这些来路不明的卡传 false，等鉴定机构验真（或封壳）后再点亮。不能按隐藏的真伪决定，否则图鉴会泄露真伪
     */
    insertCard(c: { templateId: string; ownerId: string; authenticity: string; grade: string; origin: string; style: Style; serialNo: number | null; now: number; collect?: boolean; misprint?: boolean; acquired?: 'store' | 'wholesale' }): number {
      const r = q.insertInstance.run(c.templateId, c.ownerId, c.authenticity, c.grade, c.origin, c.style, c.serialNo, c.now);
      const id = Number(r.lastInsertRowid);
      if (c.misprint) db.prepare('UPDATE card_instances SET misprint = 1 WHERE id = ?').run(id);
      if (c.acquired === 'wholesale') db.prepare("UPDATE card_instances SET acquired = 'wholesale' WHERE id = ?").run(id);
      if (c.collect ?? true) repo.markCollected(c.ownerId, c.templateId, c.style, c.now);
      return id;
    },
    setPhone: (discordId: string) => db.prepare('UPDATE players SET phone = 1 WHERE discord_id = ?').run(discordId),
    // ---- 科技树 ----
    techOwned: (discordId: string) =>
      new Set((db.prepare('SELECT node_id FROM tech_owned WHERE discord_id = ?').all(discordId) as Array<{ node_id: string }>).map((r) => r.node_id)),
    addTech: (discordId: string, nodeId: string, now: number) =>
      db.prepare('INSERT INTO tech_owned (discord_id, node_id, bought_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').run(discordId, nodeId, now).changes > 0,
    setBlueprints: (discordId: string, n: number) => db.prepare('UPDATE players SET blueprints = ? WHERE discord_id = ?').run(n, discordId),
    setTechTracked: (discordId: string, nodeId: string | null) => db.prepare('UPDATE players SET tech_tracked = ? WHERE discord_id = ?').run(nodeId, discordId),
    // ---- 房租、抵押、破产（FR-RENT） ----
    setArrears: (discordId: string, due: number, week: number) => db.prepare('UPDATE players SET rent_due = ?, rent_week = ? WHERE discord_id = ?').run(due, week, discordId),
    setShopOwned: (discordId: string, owned: boolean) => db.prepare('UPDATE players SET shop_owned = ? WHERE discord_id = ?').run(owned ? 1 : 0, discordId),
    /** 从头开始：信用点重置、新一轮从 day 开始、清掉欠租和店铺 */
    restartRun: (discordId: string, credits: number, day: number) =>
      db.prepare('UPDATE players SET credits = ?, run_start_day = ?, rent_due = 0, rent_week = 0, shop_owned = 0 WHERE discord_id = ?').run(credits, day, discordId),
    insertPawn: (p: { ownerId: string; cardId: number; loan: number; redeem: number; day: number; dueDay: number; now: number }) =>
      Number(db.prepare('INSERT INTO pawns (owner_id, card_id, loan, redeem, pawned_day, due_day, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(p.ownerId, p.cardId, p.loan, p.redeem, p.day, p.dueDay, p.now).lastInsertRowid),
    activePawns: (ownerId: string) =>
      db.prepare("SELECT * FROM pawns WHERE owner_id = ? AND status = 'active' ORDER BY due_day, id").all(ownerId) as Array<{ id: number; card_id: number; loan: number; redeem: number; pawned_day: number; due_day: number }>,
    getPawn: (ownerId: string, id: number) =>
      (db.prepare('SELECT * FROM pawns WHERE id = ? AND owner_id = ?').get(id, ownerId) as { id: number; card_id: number; loan: number; redeem: number; due_day: number; status: string } | undefined) ?? null,
    setPawnStatus: (id: number, status: string) => db.prepare('UPDATE pawns SET status = ? WHERE id = ?').run(status, id),
    /** 抵押中的卡（公开信息），按 id 给 */
    pawnedCards(ownerId: string): CardView[] {
      const rows = db.prepare(`${q.cardsWithTemplate} WHERE i.owner_id = ? AND i.location = 'pawned'`).all(ownerId) as CardViewRow[];
      return rows.map(toCardView);
    },
    /** 破产清空：珍藏柜以外的卡（库存、抵押中、送评中）、没拆的卡包、没送到的批发订单 */
    wipeForRestart(ownerId: string) {
      const cards = db.prepare("DELETE FROM card_instances WHERE owner_id = ? AND location <> 'showcase'").run(ownerId).changes;
      const packs = db.prepare('DELETE FROM sealed_packs WHERE owner_id = ?').run(ownerId).changes;
      db.prepare("UPDATE pawns SET status = 'forfeited' WHERE owner_id = ? AND status = 'active'").run(ownerId);
      db.prepare("UPDATE wholesale_orders SET status = 'refused' WHERE owner_id = ? AND status = 'pending'").run(ownerId);
      return { cards, packs };
    },
    /** 这个营业日已经打电话订过几次批发（不管后来收没收） */
    wholesaleToday: (discordId: string, gameDay: number) =>
      (db.prepare('SELECT COUNT(*) AS n FROM wholesale_orders WHERE owner_id = ? AND ordered_day = ?').get(discordId, gameDay) as { n: number }).n,
    insertOrder: (o: { ownerId: string; seriesId: string; packs: number; price: number; day: number; now: number }) =>
      Number(db.prepare('INSERT INTO wholesale_orders (owner_id, series_id, packs, price, ordered_day, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(o.ownerId, o.seriesId, o.packs, o.price, o.day, o.now).lastInsertRowid),
    /** 最早一张还没送到的订单 */
    pendingOrder: (ownerId: string) =>
      (db.prepare("SELECT o.*, s.name AS series_name FROM wholesale_orders o JOIN series s ON s.id = o.series_id WHERE o.owner_id = ? AND o.status = 'pending' ORDER BY o.id LIMIT 1").get(ownerId) as
        { id: number; owner_id: string; series_id: string; series_name: string; packs: number; price: number; ordered_day: number; status: string } | undefined) ?? null,
    getOrder: (ownerId: string, id: number) =>
      (db.prepare('SELECT * FROM wholesale_orders WHERE owner_id = ? AND id = ?').get(ownerId, id) as { id: number; series_id: string; packs: number; price: number; status: string } | undefined) ?? null,
    setOrderStatus: (id: number, status: 'delivered' | 'refused') => db.prepare('UPDATE wholesale_orders SET status = ? WHERE id = ?').run(status, id),
    /** 新的整盒编号 */
    nextBoxId: () => ((db.prepare('SELECT MAX(box_id) AS m FROM sealed_packs').get() as { m: number | null }).m ?? 0) + 1,
    markCollected(ownerId: string, templateId: string, style: string, now: number) {
      q.markCollected.run(ownerId, templateId, now);
      q.markStyleCollected.run(ownerId, templateId, style, now);
    },

    // ---- 鉴定（M3，DESIGN 5） ----
    /** 这张卡做过的鉴定：方式 → 结论（JSON） */
    appraisalsOf: (cardId: number) =>
      new Map((db.prepare('SELECT method, result FROM appraisals WHERE card_id = ?').all(cardId) as Array<{ method: string; result: string }>).map((r) => [r.method, JSON.parse(r.result) as unknown])),
    /** 记一次鉴定；同一张卡同一种方式只能有一次（主键），已经有了返回 false */
    putAppraisal: (cardId: number, method: string, result: unknown, now: number) =>
      db.prepare('INSERT INTO appraisals (card_id, method, result, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING').run(cardId, method, JSON.stringify(result), now).changes > 0,
    setAppraisal: (cardId: number, method: string, result: unknown) =>
      db.prepare('UPDATE appraisals SET result = ? WHERE card_id = ? AND method = ?').run(JSON.stringify(result), cardId, method),
    /** 送评：拿出卡册、桌面、珍藏柜，记下哪天出结果 */
    sendToGrading: (cardId: number, readyDay: number) =>
      db.prepare("UPDATE card_instances SET location = 'grading', ready_day = ?, binder_id = NULL, loose_since_day = NULL WHERE id = ?").run(readyDay, cardId),
    /** 到期该出结果的卡（含隐藏属性，只在服务器内部用） */
    dueGrading: (ownerId: string, day: number) =>
      db.prepare("SELECT * FROM card_instances WHERE owner_id = ? AND location = 'grading' AND ready_day <= ? ORDER BY id").all(ownerId, day) as InstanceRow[],
    gradingCards(ownerId: string): CardView[] {
      const rows = db.prepare(`${q.cardsWithTemplate} WHERE i.owner_id = ? AND i.location = 'grading' ORDER BY i.id`).all(ownerId) as CardViewRow[];
      return rows.map(toCardView);
    },
    /** 评级社出结果后回到库存（调用方再放进卡册或桌面）：封壳（评分、分项、错版公开）或拒评标记 */
    backFromGrading: (cardId: number, fields: { slab?: { score: string; subgrades: unknown; errata: boolean }; rejected?: boolean }) =>
      db.prepare(`UPDATE card_instances SET location = 'inventory', ready_day = NULL,
                    slab_score = COALESCE(?, slab_score), slab_subgrades = COALESCE(?, slab_subgrades), slab_errata = MAX(slab_errata, ?),
                    grade_rejected = MAX(grade_rejected, ?) WHERE id = ?`)
        .run(fields.slab?.score ?? null, fields.slab ? JSON.stringify(fields.slab.subgrades) : null, fields.slab?.errata ? 1 : 0, fields.rejected ? 1 : 0, cardId),

    // ---- 没拆的卡包（DESIGN 4） ----
    insertSealed: (ownerId: string, seriesId: string, source: string, now: number, boxId: number | null = null) =>
      Number(db.prepare('INSERT INTO sealed_packs (owner_id, series_id, source, box_id, created_at) VALUES (?, ?, ?, ?, ?)').run(ownerId, seriesId, source, boxId, now).lastInsertRowid),
    getSealed: (ownerId: string, id: number) =>
      (db.prepare('SELECT * FROM sealed_packs WHERE id = ? AND owner_id = ?').get(id, ownerId) as { id: number; owner_id: string; series_id: string; source: string; box_id: number | null; created_at: number } | undefined) ?? null,
    deleteSealed: (id: number) => db.prepare('DELETE FROM sealed_packs WHERE id = ?').run(id),
    sealedByOwner: (ownerId: string) =>
      db.prepare('SELECT p.id, p.series_id, p.source, s.name, s.kind FROM sealed_packs p JOIN series s ON s.id = p.series_id WHERE p.owner_id = ? ORDER BY p.id').all(ownerId) as Array<{ id: number; series_id: string; source: string; name: string; kind: 'themed' | 'premium' }>,
    seriesKind: (seriesId: string) => (db.prepare('SELECT kind FROM series WHERE id = ?').get(seriesId) as { kind: 'themed' | 'premium' } | undefined)?.kind ?? null,

    advanceDay: (discordId: string) => db.prepare('UPDATE players SET game_day = game_day + 1, day_customer_count = 0 WHERE discord_id = ?').run(discordId),
    setDayCustomerCount: (discordId: string, n: number) => db.prepare('UPDATE players SET day_customer_count = ? WHERE discord_id = ?').run(n, discordId),
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

    /** 能拿去柜台卖的卡：卡册、桌面、珍藏柜里的都能卖（2026-11-17 用户定：珍藏柜只防抵押、防清空，不防卖） */
    sellableCards(ownerId: string, limit = 1000): CardView[] {
      const rows = db.prepare(`${q.cardsWithTemplate} WHERE i.owner_id = ? AND i.location IN ('inventory', 'showcase') ORDER BY i.id DESC LIMIT ?`).all(ownerId, limit) as CardViewRow[];
      return rows.map(toCardView);
    },
    deleteCard: (id: number) => db.prepare('DELETE FROM card_instances WHERE id = ?').run(id),
    setCreditsReputation: (discordId: string, credits: number, reputation: number) =>
      db.prepare('UPDATE players SET credits = ?, reputation = ? WHERE discord_id = ?').run(credits, reputation, discordId),

    // ---- 柜台顾客（FR-CTR-1～3） ----
    customersFor: (ownerId: string, day: string) =>
      db.prepare('SELECT * FROM customers WHERE owner_id = ? AND day_key = ? ORDER BY slot, seat').all(ownerId, day) as CustomerRow[],
    getCustomer: (ownerId: string, id: number) =>
      (db.prepare('SELECT * FROM customers WHERE id = ? AND owner_id = ?').get(id, ownerId) as CustomerRow | undefined) ?? null,
    insertCustomer(c: Omit<CustomerRow, 'id' | 'status' | 'counter_price' | 'max_patience'> & { max_patience?: number }): number {
      const r = db.prepare(
        `INSERT INTO customers (owner_id, day_key, slot, seat, type, demand, float, patience, max_patience, line, budget_low, budget_high, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(c.owner_id, c.day_key, c.slot, c.seat, c.type, c.demand, c.float, c.patience, c.max_patience ?? c.patience, c.line, c.budget_low, c.budget_high, c.created_at);
      return Number(r.lastInsertRowid);
    },
    setShowcaseLevel: (discordId: string, level: number) => db.prepare('UPDATE players SET showcase_level = ? WHERE discord_id = ?').run(level, discordId),
    /** 珍藏柜里的卡（公开信息），最值钱的在前 */
    showcaseCards(ownerId: string): CardView[] {
      const rows = db.prepare(`${q.cardsWithTemplate} WHERE i.owner_id = ? AND i.location = 'showcase' ORDER BY i.id`).all(ownerId) as CardViewRow[];
      return rows.map(toCardView).sort((a, b) => b.price - a.price);
    },
    updateCustomer: (id: number, c: { patience: number; status: string; line: string; counter_price: number | null }) =>
      db.prepare('UPDATE customers SET patience = ?, status = ?, line = ?, counter_price = ? WHERE id = ?').run(c.patience, c.status, c.line, c.counter_price, id),

    // ---- 卡册（DESIGN 4.5） ----
    bindersOf: (ownerId: string) =>
      db.prepare('SELECT b.id, b.kind, b.created_at, (SELECT COUNT(*) FROM card_instances i WHERE i.binder_id = b.id) AS used FROM binders b WHERE b.owner_id = ? ORDER BY b.id').all(ownerId) as Array<{ id: number; kind: string; created_at: number; used: number }>,
    insertBinder: (ownerId: string, kind: string, now: number) =>
      Number(db.prepare('INSERT INTO binders (owner_id, kind, created_at) VALUES (?, ?, ?)').run(ownerId, kind, now).lastInsertRowid),
    getBinder: (ownerId: string, id: number) =>
      (db.prepare('SELECT * FROM binders WHERE id = ? AND owner_id = ?').get(id, ownerId) as { id: number; owner_id: string; kind: string; created_at: number } | undefined) ?? null,
    /** 放进某本卡册（binderId）或散放到桌面（null，记下从第几个营业日开始散放） */
    placeCard: (cardId: number, binderId: number | null, looseSinceDay: number | null) =>
      db.prepare('UPDATE card_instances SET binder_id = ?, loose_since_day = ? WHERE id = ?').run(binderId, binderId === null ? looseSinceDay : null, cardId),
    /** 散放在桌面上的卡（在库存里、不在任何卡册里），最值钱的排前面由调用方排 */
    looseCards(ownerId: string): CardView[] {
      const rows = db.prepare(`${q.cardsWithTemplate} WHERE i.owner_id = ? AND i.location = 'inventory' AND i.binder_id IS NULL ORDER BY i.id`).all(ownerId) as CardViewRow[];
      return rows.map(toCardView);
    },
    /** 一本卡册里的全部卡（按稀有度从高到低），柜台按顾客需要重新排 */
    allBinderCards(binderId: number): CardView[] {
      const rows = db.prepare(`${q.cardsWithTemplate} WHERE i.binder_id = ? AND i.location = 'inventory' ORDER BY ${BINDER_ORDER}`).all(binderId) as CardViewRow[];
      return rows.map(toCardView);
    },
    binderCards(binderId: number, page: number, pageSize: number): CardView[] {
      const rows = db.prepare(`${q.cardsWithTemplate} WHERE i.binder_id = ? ORDER BY ${BINDER_ORDER} LIMIT ? OFFSET ?`).all(binderId, pageSize, (page - 1) * pageSize) as CardViewRow[];
      return rows.map(toCardView);
    },
    /** 磨损：只改隐藏的品相，不发给玩家 */
    setGrade: (cardId: number, grade: string) => db.prepare('UPDATE card_instances SET grade = ? WHERE id = ?').run(grade, cardId),
    looseInstances: (ownerId: string) =>
      db.prepare("SELECT * FROM card_instances WHERE owner_id = ? AND location = 'inventory' AND binder_id IS NULL").all(ownerId) as InstanceRow[],

    /** 任务进度：从流水和库存里数（不另记计数） */
    questStats(ownerId: string): Record<QuestMetric, number> {
      const count = (sql: string) => (db.prepare(sql).get(ownerId) as { n: number }).n;
      const player = q.getPlayer.get(ownerId);
      return {
        packsBought: count("SELECT COUNT(*) AS n FROM events_log WHERE discord_id = ? AND kind = 'credits' AND json_extract(data, '$.why') IN ('store', 'store_test_free')"),
        packsOpened: count("SELECT COUNT(*) AS n FROM events_log WHERE discord_id = ? AND kind = 'pack_open'"),
        sales: count("SELECT COUNT(*) AS n FROM events_log WHERE discord_id = ? AND kind = 'credits' AND json_extract(data, '$.why') = 'sale'"),
        daysEnded: count("SELECT COUNT(*) AS n FROM events_log WHERE discord_id = ? AND kind = 'day_end'"),
        collected: count('SELECT COUNT(*) AS n FROM collection WHERE discord_id = ?'),
        showcaseLevel: player?.showcase_level ?? 0,
        showcaseCards: count("SELECT COUNT(*) AS n FROM card_instances WHERE owner_id = ? AND location = 'showcase'"),
        binders: count('SELECT COUNT(*) AS n FROM binders WHERE owner_id = ?'),
      };
    },
    questClaims: (ownerId: string) =>
      new Set((db.prepare('SELECT quest_id FROM quest_claims WHERE discord_id = ?').all(ownerId) as Array<{ quest_id: string }>).map((r) => r.quest_id)),
    claimQuest: (ownerId: string, questId: string, now: number) =>
      db.prepare('INSERT INTO quest_claims (discord_id, quest_id, claimed_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').run(ownerId, questId, now).changes > 0,

    collection(ownerId: string) {
      const owned = new Set((db.prepare('SELECT template_id FROM collection WHERE discord_id = ?').all(ownerId) as Array<{ template_id: string }>).map((r) => r.template_id));
      const counts = new Map((db.prepare('SELECT template_id, COUNT(*) AS n FROM card_instances WHERE owner_id = ? GROUP BY template_id').all(ownerId) as Array<{ template_id: string; n: number }>).map((r) => [r.template_id, r.n]));
      // 大师图鉴：每种风格有过没有（键 "模板|风格"）、现在手上各几张
      const ownedStyles = new Set((db.prepare('SELECT template_id, style FROM collection_styles WHERE discord_id = ?').all(ownerId) as Array<{ template_id: string; style: string }>).map((r) => `${r.template_id}|${r.style}`));
      const styleCounts = new Map((db.prepare('SELECT template_id, style, COUNT(*) AS n FROM card_instances WHERE owner_id = ? GROUP BY template_id, style').all(ownerId) as Array<{ template_id: string; style: string; n: number }>).map((r) => [`${r.template_id}|${r.style}`, r.n]));
      return { owned, counts, ownedStyles, styleCounts };
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
  binder_id: number | null;
  loose_since_day: number | null;
  created_at: number;
  slab_score: string | null;
  slab_subgrades: string | null;
  slab_errata: number;
  grade_rejected: number;
  ready_day: number | null;
  acquired: string;
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
    binderId: r.binder_id,
    looseSinceDay: r.location === 'inventory' && r.binder_id === null ? r.loose_since_day : null,
    // 只有封壳后公开的评分参与定价（FR-APPR-5）
    price: publicPrice({ rarity: r.rarity, style: r.style, publicGrade: r.slab_score ? (r.slab_score === 'BL' ? 'BL' : Number(r.slab_score) as Grade) : null, publicErrata: r.slab_errata === 1 }),
    createdAt: r.created_at,
    slab: r.slab_score ? { score: r.slab_score, subgrades: JSON.parse(r.slab_subgrades ?? '{}') as Record<string, number>, errata: r.slab_errata === 1 } : null,
    gradeRejected: r.grade_rejected === 1,
    readyDay: r.ready_day,
    acquired: r.acquired === 'wholesale' ? 'wholesale' : 'store',
  };
}

export type Repo = ReturnType<typeof openDb>;

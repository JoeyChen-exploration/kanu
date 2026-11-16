// SQLite（better-sqlite3）。迁移只往前加，按 user_version 记版本，重启不会重复跑。
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { PLAYER } from '@kanu/shared/balance';
import type { SessionUser } from '@kanu/shared/types';

const MIGRATIONS: string[] = [
  // 1：M0 建档（SRS 第 5 节 players、events_log 的 M0 子集）
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
];

export interface PlayerRow {
  discord_id: string;
  display_name: string;
  avatar: string | null;
  credits: number;
  reputation: number;
  week_no: number;
  created_at: number;
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
  const getPlayer = db.prepare<[string], PlayerRow>('SELECT * FROM players WHERE discord_id = ?');
  const insertPlayer = db.prepare(
    'INSERT INTO players (discord_id, display_name, avatar, credits, reputation, week_no, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
  );
  const updateProfile = db.prepare('UPDATE players SET display_name = ?, avatar = ? WHERE discord_id = ?');
  const insertEvent = db.prepare('INSERT INTO events_log (at, discord_id, kind, data) VALUES (?, ?, ?, ?)');

  return {
    db,
    getPlayer: (id: string) => getPlayer.get(id) ?? null,
    /** 第一次登录自动建档（FR-AUTH-5）；之后每次登录只同步名字和头像。建档和流水在一个事务里（DR-1、DR-2）。 */
    ensurePlayer: db.transaction((user: SessionUser, now: number): PlayerRow => {
      const existing = getPlayer.get(user.id);
      if (existing) {
        updateProfile.run(user.name, user.avatar, user.id);
        return { ...existing, display_name: user.name, avatar: user.avatar };
      }
      insertPlayer.run(user.id, user.name, user.avatar, PLAYER.startCredits, PLAYER.startReputation, now);
      insertEvent.run(now, user.id, 'credits', JSON.stringify({ delta: PLAYER.startCredits, why: 'open', bal: PLAYER.startCredits }));
      return getPlayer.get(user.id)!;
    }),
    close: () => db.close(),
  };
}

export type Repo = ReturnType<typeof openDb>;

// 全部游戏数值的唯一来源（CLAUDE.md 第 3 条）。以 docs/DESIGN.md 为准，改了要跑 npm run sim。
// M0 只放建档用到的数；其余表在 M1 按 DESIGN 补全。

export const PLAYER = {
  /** 开局信用点（DESIGN 9.1） */
  startCredits: 1500,
  /** 破产重开信用点（DESIGN 7） */
  restartCredits: 1200,
  /** 开局信誉（DESIGN 6） */
  startReputation: 50,
} as const;

export const SESSION = {
  /** 会话 token 有效期（SRS FR-AUTH-3） */
  ttlMs: 24 * 3600e3,
} as const;

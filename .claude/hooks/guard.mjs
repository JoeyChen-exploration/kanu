#!/usr/bin/env node
// PreToolUse 钩子（matcher: Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell）
// 把 CLAUDE.md 里能机器检查的规矩落成拦截，只用 Node，不依赖 jq / python。
// 违规时 exit 2，原因写进 stderr 反馈给 Claude；其他情况一律放行（拿不到信息时也放行，宁可漏拦不误伤）。
//
// 规则：
//   scope   只改 kanu：写兄弟仓库（oceania-bot、wangcai-cards）或上层目录里的文件一律拦；
//           对兄弟仓库跑会改动 git 状态的命令也拦。读不受影响。
//   branch  kanu 在 main / master 上时，不许改仓库内文件、不许 commit；任何时候都不许推 main / master。
//   secrets commit 时暂存区里有 .env（.env.example 除外）或 data/ 下的文件就拦。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PARENT = path.dirname(REPO);
const SIBLINGS = ['oceania-bot', 'wangcai-cards'];
const WIN = process.platform === 'win32';
const norm = (p) => { const r = path.resolve(p); return WIN ? r.toLowerCase() : r; };
const inside = (p, dir) => { const a = norm(p), d = norm(dir); return a === d || a.startsWith(d + path.sep); };

const block = (msg) => { process.stderr.write(`拦截：${msg}\n`); process.exit(2); };

let input = {};
try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }
const tool = input.tool_name || '';
const ti = input.tool_input || {};

const git = (...args) => {
  try { return execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; }
};
const branch = () => git('branch', '--show-current');
const onMain = () => ['main', 'master'].includes(branch());

// ---------- 改文件 ----------
if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)) {
  const file = ti.file_path || ti.notebook_path;
  if (!file) process.exit(0);
  if (inside(file, PARENT) && !inside(file, REPO)) {
    block(`${file} 不在 kanu 里。这个工作区只改 kanu；oceania-bot 和 wangcai-cards 只读，要改它们请到各自的仓库、走各自的分支和 PR（SRS 6.4）。`);
  }
  if (inside(file, REPO) && onMain()) {
    block(`kanu 当前在 ${branch()} 分支上，不能直接改仓库内文件。先 git checkout -b <类型>/<简短描述>（如 feat/pack-open、docs/tech-tree）再改。`);
  }
  process.exit(0);
}

// ---------- 命令 ----------
if (tool === 'Bash' || tool === 'PowerShell') {
  const cmd = String(ti.command || '');
  // 按 && || ; | 换行 切段，逐段看是不是真的 git 命令
  const segs = cmd.split(/&&|\|\||;|\||\r?\n/).map((s) => s.trim()).filter(Boolean);
  const gitSeg = (s) => /^(?:sudo\s+)?git(?:\s|$)/.test(s.replace(/^cd\s+\S+\s*/, ''));
  const touchesSibling = SIBLINGS.some((n) => cmd.includes(n));
  const WRITE_VERBS = /\bgit\b[^\n]*\b(commit|push|add|rm|mv|reset|checkout|switch|merge|rebase|cherry-pick|revert|stash|tag|branch\s+-[dDmM])\b/;

  if (touchesSibling && segs.some((s) => gitSeg(s) && WRITE_VERBS.test(s))) {
    block('这条命令会改动兄弟仓库（oceania-bot / wangcai-cards）的 git 状态。这个工作区只改 kanu；旺财侧的改动按 SRS 6.4 到 oceania-bot 仓库单独走分支和 PR。');
  }
  if (touchesSibling) process.exit(0); // 只读兄弟仓库的命令（git log、cat 等）放行，下面的规则只管 kanu

  for (const s of segs) {
    if (!gitSeg(s)) continue;
    if (/\bgit\b.*\bpush\b/.test(s)) {
      const explicitMain = /\bpush\b.*\b(main|master)\b/.test(s) || /:(main|master)\b/.test(s);
      const implicitMain = !/\bpush\b\s+\S+\s+\S+/.test(s) && onMain();
      if (explicitMain || implicitMain) block('不能推 main / master。推自己的分支，然后用 gh pr create 开 PR。');
    }
    if (/\bgit\b.*\bcommit\b/.test(s)) {
      if (onMain()) block(`kanu 当前在 ${branch()} 分支上，不能直接 commit。先切到一个功能分支。`);
      const staged = git('diff', '--cached', '--name-only').split('\n').filter(Boolean);
      const willAddAll = /\bcommit\b.*\s-[a-zA-Z]*a/.test(s);
      const files = willAddAll ? [...staged, ...git('diff', '--name-only').split('\n').filter(Boolean)] : staged;
      const bad = files.filter((f) => /(^|\/)\.env(\..+)?$/.test(f) && !f.endsWith('.env.example') || /^data\//.test(f));
      if (bad.length) block(`暂存区里有不该进 git 的文件：${bad.join(', ')}。用 git restore --staged 撤出来。`);
    }
    if (/\bgit\b.*\badd\b/.test(s) && /(\s|^)(\.env(?!\.example)\S*|data\/\S*)/.test(s.replace(/^.*\badd\b/, ' '))) {
      block('不要把 .env 或 data/ 加进 git。');
    }
  }
  process.exit(0);
}

process.exit(0);

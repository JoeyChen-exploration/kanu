#!/bin/bash
# PostToolUse hook（Write|Edit|MultiEdit）：留一个 marker 文件，告诉 remind-sync-files.sh
# 这一轮确实发生过写文件操作，需要在 Stop 时提醒一次同步检查。
# marker 会在 remind-sync-files.sh 那边 stop_hook_active=true 时清掉，避免下一轮没改动也被提醒。

touch "$CLAUDE_PROJECT_DIR/.claude/hooks/.pending-sync-check" 2>/dev/null || true

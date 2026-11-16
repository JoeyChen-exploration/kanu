#!/bin/bash
# Stop hook：如果本轮有 Write/Edit/MultiEdit（见同目录 mark-pending-sync.sh 写的 marker），
# 提醒 Claude 检查相关文件是否需要同步更新。
#
# 修复过两个问题：
# 1）本机 Git Bash 环境没装 jq，之前的 `jq -r ... 2>/dev/null` 一直静默失败、$active 永远是空字符串，
#    从来不会等于 "true"，导致 stop_hook_active 防循环判断从没生效过，每次尝试结束都会被无条件 block，
#    表现为同一条提醒反复出现、无法正常结束。参考同目录 protect-prod-db.sh 等脚本，改成
#    jq 不存在时 fallback 到 python3 解析 JSON。
# 2）即使 jq 正常工作，stop_hook_active 也只在“同一轮里的第二次 Stop”为 true——用户发下一条新消息、
#    开新的一轮后，第一次 Stop 事件 stop_hook_active 又会是 false，不管这一轮有没有真的改动文件都会
#    再提醒一次。改成用 marker 文件记录“本轮是否发生过写文件操作”：没有 marker 就直接放行；
#    有 marker 才 block 一次，并在 Claude 完成自检、Stop 再次触发（stop_hook_active=true）时清掉 marker。

input=$(cat)

if command -v jq >/dev/null 2>&1; then
  active=$(printf '%s' "$input" | jq -r '.stop_hook_active // false' 2>/dev/null)
else
  active=$(printf '%s' "$input" | python3 -c "import json,sys
try:
    print(json.load(sys.stdin).get('stop_hook_active', False))
except Exception:
    print(False)" 2>/dev/null || echo false)
  # python3 打印的是 "True"/"False"（首字母大写），统一成小写方便下面比较
  active=$(printf '%s' "$active" | tr '[:upper:]' '[:lower:]')
fi

marker="$CLAUDE_PROJECT_DIR/.claude/hooks/.pending-sync-check"

if [ "$active" = "true" ]; then
  rm -f "$marker"
  exit 0
fi

if [ ! -f "$marker" ]; then
  exit 0
fi

cat <<'EOF'
{"decision":"block","reason":"自动同步检查：本轮修改过文件，请 view 项目中所有相关文件（CLAUDE.md、.claude/memory/、维护日志等），检查是否需要同步更新，需要则一并更新后再结束；同步已完成的话直接结束即可，不要重复此检查。"}
EOF

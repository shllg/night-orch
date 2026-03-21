#!/bin/bash
# .claude/hooks/review-gate.sh
# PreToolUse hook for ExitPlanMode: blocks exit if no codex/gemini review
# has been completed in this session. Uses session-based markers with stale cleanup.

INPUT=$(cat)
SID=$(echo "$INPUT" | jq -r '.session_id // empty')
[ -z "$SID" ] && exit 0

HOOK_STATE="${CLAUDE_PROJECT_DIR:-.}/.claude/hook-state"
mkdir -p "$HOOK_STATE"
REVIEWED="$HOOK_STATE/.codex-reviewed-${SID}"

# Stale marker cleanup (>20 min)
find "$HOOK_STATE" -name '.codex-reviewed-*' -mmin +20 -delete 2>/dev/null

# Review completed — allow exit and clean up
if [ -f "$REVIEWED" ]; then
  rm -f "$REVIEWED"
  exit 0
fi

# No review — block with directive message
echo "Reminder: A codex or gemini review is MANDATORY before exiting plan mode. Invoke the 'codex-review' skill (or use mcp__gemini__*) to get an external review of your plan, then call ExitPlanMode again."
exit 2

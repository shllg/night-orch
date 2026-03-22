#!/bin/bash
# .claude/hooks/review-marker.sh
# PostToolUse hook for mcp__codex__codex, Skill, and Task.
# Detects codex/gemini review calls and marks the review as completed
# so the ExitPlanMode gate (review-gate.sh) can allow plan exit.

INPUT=$(cat)
IFS=$'\t' read -r SID TOOL_NAME SKILL SUBAGENT <<< \
  "$(echo "$INPUT" | jq -r '[.session_id // "", .tool_name // "", .tool_input.skill // "", .tool_input.subagent_type // ""] | @tsv')"
[ -z "$SID" ] && exit 0

HOOK_STATE="${CLAUDE_PROJECT_DIR:-.}/.claude/hook-state"
mkdir -p "$HOOK_STATE"
REVIEWED="$HOOK_STATE/.codex-reviewed-${SID}"

case "$TOOL_NAME" in
  mcp__codex__*|mcp__gemini__*)
    touch "$REVIEWED"
    ;;
  Skill)
    if [[ "$SKILL" == *codex* || "$SKILL" == *gemini* || "$SKILL" == s-* || "$SKILL" == orch-* ]]; then
      touch "$REVIEWED"
    fi
    ;;
  Task)
    if [[ "$SUBAGENT" == *codex* || "$SUBAGENT" == *gemini* ]]; then
      touch "$REVIEWED"
    fi
    ;;
esac

exit 0

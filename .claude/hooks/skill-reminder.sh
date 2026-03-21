#!/bin/bash
# .claude/hooks/skill-reminder.sh
# PreToolUse hook: Maps file paths to relevant skills and outputs an advisory reminder.
# Non-blocking (exit 0) — Claude sees the reminder as context but is not prevented from editing.

INPUT=$(cat)
IFS=$'\t' read -r TOOL_NAME FILE_PATH <<< \
  "$(echo "$INPUT" | jq -r '[.tool_name // "", .tool_input.file_path // ""] | @tsv')"
[[ "$TOOL_NAME" == "Edit" || "$TOOL_NAME" == "Write" ]] || exit 0
[[ -z "$FILE_PATH" ]] && exit 0

SKILL=""
SECONDARY=""
case "$FILE_PATH" in
*/workers/env.ts)
  SKILL="security-review"
  SECONDARY="worker-adapter"
  ;;
*/workers/prompt/*)
  SKILL="worker-adapter"
  SECONDARY="security-review"
  ;;
*/workers/parsers/*)
  SKILL="worker-adapter"
  ;;
*/workers/*)
  SKILL="worker-adapter"
  SECONDARY="security-review"
  ;;
*/loop/*)
  SKILL="loop-engine"
  SECONDARY="code-review"
  ;;
*/forge/*)
  SKILL="forge-adapter"
  SECONDARY="code-review"
  ;;
*/config/*)
  SKILL="typescript-patterns"
  ;;
*/labels/*)
  SKILL="loop-engine"
  ;;
*/state/*)
  SKILL="typescript-patterns"
  SECONDARY="code-review"
  ;;
*/cli/*)
  SKILL="typescript-patterns"
  ;;
test/*)
  SKILL="typescript-patterns"
  ;;
*) exit 0 ;;
esac

MSG="Reminder: The skill '$SKILL' contains night-orch conventions for this file type. If not already loaded, consider loading it before editing."
if [[ -n "$SECONDARY" ]]; then
  MSG="$MSG Also consider: $SECONDARY."
fi
MSG="$MSG General: code-review and security-review are always available."
echo "$MSG"
exit 0

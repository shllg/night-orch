#!/usr/bin/env bash
set -euo pipefail

# Update helper for local development.
#
# Default behavior (same as before):
#   1) git pull --ff-only
#   2) pnpm install
#   3) pnpm build
#   4) pnpm install-global
#
# Optional environment variables:
#   UPDATE_PNPM_BIN=pnpm            Override pnpm executable.
#   UPDATE_SKIP_PULL=1              Skip git pull.
#   UPDATE_SKIP_INSTALL=1           Skip pnpm install.
#   UPDATE_SKIP_BUILD=1             Skip pnpm build.
#   UPDATE_SKIP_INSTALL_GLOBAL=1    Skip pnpm install-global.
#   UPDATE_DRY_RUN=1                Print commands without executing.

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

PNPM_BIN="${UPDATE_PNPM_BIN:-pnpm}"

is_truthy() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|on|ON) return 0 ;;
    *) return 1 ;;
  esac
}

run_step() {
  local label="$1"
  shift

  printf '==> %s\n' "$label"

  if is_truthy "${UPDATE_DRY_RUN:-0}"; then
    printf '[dry-run] %s\n' "$*"
    return 0
  fi

  "$@"
}

if ! command -v "$PNPM_BIN" >/dev/null 2>&1; then
  printf 'error: pnpm executable not found: %s\n' "$PNPM_BIN" >&2
  exit 1
fi

if ! is_truthy "${UPDATE_SKIP_PULL:-0}"; then
  run_step "Pull latest changes" git pull --ff-only
fi

if ! is_truthy "${UPDATE_SKIP_INSTALL:-0}"; then
  run_step "Install dependencies" "$PNPM_BIN" install
fi

if ! is_truthy "${UPDATE_SKIP_BUILD:-0}"; then
  run_step "Build project" "$PNPM_BIN" build
fi

if ! is_truthy "${UPDATE_SKIP_INSTALL_GLOBAL:-0}"; then
  run_step "Install CLI globally" "$PNPM_BIN" install-global
fi

printf 'Update complete.\n'

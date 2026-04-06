---
description: Create a PR after validating typecheck, lint, and tests pass
---

# /orch-pr — Create Pull Request

Validate the build and create a PR with auto-generated title and body from commits.

## Input

$ARGUMENTS — optional: target branch (default: main), PR description override

## Process

1. **Validate build**:
   ```bash
   pnpm typecheck
   pnpm lint
   pnpm test
   ```
   If any fail, STOP and report the failures. Do not create a PR with failing checks.

2. **Gather context**:
   ```bash
   # Current branch
   git branch --show-current
   # Commits not in main
   git log main..HEAD --oneline
   # Changed files
   git diff main..HEAD --stat
   ```

3. **Generate PR content**:
   - **Title**: From branch name or first commit subject (user can override)
   - **Body**: Summary of changes from commit messages, grouped by area:
     - Config/CLI changes
     - Core logic changes (loop, workers, forge)
     - Test changes
     - Infrastructure changes

4. **Present for approval**: Show the title, body, and target branch. Wait for user confirmation before creating.

5. **Create PR** (only after user approval):
   ```bash
   gh pr create --base main --title "..." --body "..."
   ```

## Notes

- Never force-push or push without user approval
- If there are uncommitted changes, warn the user
- If the branch is behind main, suggest rebasing first

# Spec Compliance Rules

## Before Implementing

1. Read the relevant phase spec in `docs/specs-active/`
2. Check the spec's **Interfaces** section for required types
3. Check the spec's **Files to Create** section for expected file paths
4. Check the spec's **Acceptance Criteria** for what must pass

## During Implementation

- Follow the spec's interface definitions exactly — do not add or remove fields without discussion
- Create files in the paths specified by the spec
- Implement all acceptance criteria items — they become your test cases

## After Implementation

- Verify every acceptance criterion is met
- Run `pnpm typecheck && pnpm lint && pnpm test` to confirm
- If a spec is ambiguous, flag it — do not guess

## Spec Index

See `docs/specs-active/index.md` for the full list of phases and their status.

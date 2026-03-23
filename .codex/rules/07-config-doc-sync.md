# Config Doc Sync Rule

Configuration authoring and behavior documentation lives in `docs/CONFIGURATION.md`.

## MUST

- When changing config schema (`src/config/schema.ts`), defaults, validation, or coercion behavior, update `docs/CONFIGURATION.md` in the same change.
- When changing config loading/resolution (`src/config/loader.ts`, `src/config/paths.ts`), update the relevant sections in `docs/CONFIGURATION.md` in the same change.
- When changing runtime behavior that is controlled by config fields (for example in `src/forge/`, `src/environment/`, `src/runner/`, `src/mentions/`, or `src/mcp/`), update `docs/CONFIGURATION.md` if user-visible config semantics changed.
- Keep `examples/config.example.yaml` aligned when introducing new required fields or changed config patterns.

## NEVER

- Ship config-related code changes with stale config docs.
- Rename, add, or remove config keys without reflecting that change in `docs/CONFIGURATION.md`.

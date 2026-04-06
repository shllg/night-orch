# Documentation Sync Rule

The project has a public docs site built with VitePress (`docs/` directory), deployed to GitHub Pages on each release.

- `docs/CONFIGURATION.md` — config authoring reference
- `docs/OVERVIEW.md` — architecture and concepts
- `docs/USAGE.md` — features and command reference
- `docs/deployment.md` — deployment guide

## MUST

- When changing config schema (`src/config/schema.ts`), defaults, validation, or coercion behavior, update `docs/CONFIGURATION.md` in the same change.
- When changing config loading/resolution (`src/config/loader.ts`, `src/config/paths.ts`), update the relevant sections in `docs/CONFIGURATION.md` in the same change.
- When changing runtime behavior that is controlled by config fields (for example in `src/forge/`, `src/environment/`, `src/runner/`, `src/mentions/`, or `src/mcp/`), update `docs/CONFIGURATION.md` if user-visible config semantics changed.
- When adding, removing, or changing CLI commands, update `docs/USAGE.md` in the same change.
- When adding, removing, or changing worker types, agent names, or role resolution logic, update both `docs/CONFIGURATION.md` and `docs/USAGE.md`.
- When changing architectural concepts (new loop phases, new forge adapters, new worker adapters), update `docs/OVERVIEW.md`.
- Keep `examples/config.example.yaml` aligned when introducing new required fields or changed config patterns.
- When adding new top-level doc pages, add them to the VitePress sidebar and nav in `docs/.vitepress/config.ts`.

## NEVER

- Ship user-visible behavior changes with stale docs.
- Rename, add, or remove config keys without reflecting that change in `docs/CONFIGURATION.md`.
- Add new CLI commands or surfaces without documenting them in `docs/USAGE.md`.

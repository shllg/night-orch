---
name: config-doc-sync
description: Keep docs/CONFIGURATION.md synchronized with config schema and config-driven runtime behavior
---

# Config Doc Sync Skill

Use this skill whenever you touch configuration logic.

Primary reference: `docs/CONFIGURATION.md`

## Trigger Files

- `src/config/**`
- `src/forge/factory.ts`
- `src/environment/manager.ts`
- `src/runner/poller.ts`
- `src/mentions/manager.ts`
- `src/mentions/resolver.ts`
- `src/mcp/tools/index.ts`

## Required Workflow

1. Identify whether config behavior changed:
   - key names, allowed values, defaults, validation, fallback behavior, path expansion, or env var behavior
2. Update `docs/CONFIGURATION.md` in the same change for every user-visible behavior change
3. If new required config is introduced, update `examples/config.example.yaml`
4. In your final summary, explicitly mention the config doc updates

## Quick Checklist

- [ ] Added keys documented
- [ ] Removed/renamed keys documented
- [ ] Default changes documented
- [ ] Validation constraints documented
- [ ] Runtime fallback/precedence behavior documented
- [ ] Example config updated if required

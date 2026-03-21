# Testing Rules

Applies to: `test/**`

## Framework

- vitest — tests live in `test/` mirroring `src/` structure
- Run: `pnpm test` (all), `pnpm test -- --run test/path/to/file.test.ts` (single)

## Mock Strategy

- Mock external dependencies: GitHub/Forgejo API, git CLI (`execa`), worker processes
- Use in-memory SQLite for DB tests (`:memory:` or temp file)
- NEVER mock internal pure functions — test them directly
- Forge contract tests (`test/forge/contract.test.ts`) are parameterized — both GitHub and Forgejo adapters must pass the same suite

## Pure Function Testing

- `decide()` and `computeLabelMutation()` are pure — test EXHAUSTIVELY
- Cover every branch, every edge case, every error path
- Use table-driven tests for combinatorial inputs

## Test Structure

```typescript
import { describe, it, expect, vi } from 'vitest';

describe('moduleName', () => {
  describe('functionName', () => {
    it('should do X when Y', () => {
      // arrange → act → assert
    });
  });
});
```

## Assertions

- Use `expect().toBe()` for primitives, `expect().toEqual()` for objects
- Use `expect().toThrow()` or `expect().rejects.toThrow()` for errors
- Use `vi.fn()` for mock functions, `vi.spyOn()` for spying

## What to Test

- All public functions exported from a module
- Error paths and edge cases (empty input, undefined, boundary values)
- Integration between loop phases (context flows correctly)
- Worker output parsing (valid, malformed, missing fields)
- Config validation (valid YAML, invalid YAML, missing required fields)

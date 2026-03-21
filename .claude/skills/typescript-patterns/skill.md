---
name: typescript-patterns
description: Night-orch TypeScript/ESM patterns — imports, Zod, noUncheckedIndexedAccess, vitest
---

# TypeScript Patterns for Night-Orch

## ESM Imports

All imports MUST use `.js` extension, even when the source is `.ts`:

```typescript
// CORRECT
import { RunContext } from './types.js';
import { logger } from '../utils/logger.js';
import { readFile } from 'node:fs/promises';

// WRONG
import { RunContext } from './types';
import { RunContext } from './types.ts';
import { readFile } from 'fs/promises';
```

## Zod Schema Patterns

```typescript
import { z } from 'zod';

// Define schema with defaults and transforms
export const RepoConfigSchema = z.object({
  url: z.string().url(),
  branch: z.string().default('main'),
  workdir: z.string().transform(p => p.replace(/^~/, homedir())),
  maxConcurrent: z.number().int().positive().default(2),
});

// Export inferred type alongside schema
export type RepoConfig = z.infer<typeof RepoConfigSchema>;
```

## Handling `noUncheckedIndexedAccess`

```typescript
// Array access — always check
const first = items[0];
if (!first) {
  throw new Error('Expected at least one item');
}
// first is now narrowed to non-undefined

// Map/Record access — always check
const value = record[key];
if (value === undefined) {
  continue; // or throw, or use default
}

// Destructuring with defaults does NOT help — still needs check
```

## Readonly Types

```typescript
// RunContext fields are readonly
interface RunContext {
  readonly runId: string;
  readonly repo: string;
  readonly issueNumber: number;
  readonly config: Readonly<Config>;
}

// Use Readonly<T> for function params that shouldn't be mutated
function process(ctx: Readonly<RunContext>): RunContext {
  return { ...ctx, phase: 'planning' };
}
```

## Discriminated Unions

```typescript
type Decision =
  | { readonly action: 'continue'; readonly reason: string }
  | { readonly action: 'stop'; readonly reason: string }
  | { readonly action: 'retry'; readonly reason: string; readonly delay: number };

// Exhaustive switch
function handle(d: Decision) {
  switch (d.action) {
    case 'continue': /* ... */ break;
    case 'stop': /* ... */ break;
    case 'retry': /* ... */ break;
    default: {
      const _exhaustive: never = d;
      throw new Error(`Unhandled: ${_exhaustive}`);
    }
  }
}
```

## Vitest Patterns

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock execa for git operations
vi.mock('execa', () => ({
  execa: vi.fn(),
}));

// Table-driven tests for pure functions
describe('decide', () => {
  it.each([
    { input: { phase: 'complete', errors: 0 }, expected: 'stop' },
    { input: { phase: 'coding', errors: 0 }, expected: 'continue' },
    { input: { phase: 'coding', errors: 3 }, expected: 'retry' },
  ])('returns $expected for $input', ({ input, expected }) => {
    expect(decide(input).action).toBe(expected);
  });
});
```

## Error Types

```typescript
export class NightOrchError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'NightOrchError';
  }
}

// Usage
throw new NightOrchError(
  `Failed to fetch issue #${num}`,
  'FORGE_FETCH_FAILED',
  originalError,
);
```

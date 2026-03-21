# TypeScript Patterns

## ESM Modules

- All imports use `.js` extension: `import { foo } from './bar.js'`
- Use `node:` prefix for Node.js builtins: `import { readFile } from 'node:fs/promises'`
- No `require()`, no `__dirname` — use `import.meta.url` if needed

## Zod Patterns

- Define schemas in `src/config/schema.ts`
- Export both the schema and the inferred type: `export type Config = z.infer<typeof ConfigSchema>`
- Use `.default()` for optional fields with defaults
- Use `.transform()` for path expansion (`~` → home dir)
- Validate at system boundaries (config load, API input) — trust internal types

## `noUncheckedIndexedAccess`

Every array/object index access may be `undefined`. Handle it:

```typescript
// WRONG
const item = items[0];
item.name; // Error: possibly undefined

// CORRECT
const item = items[0];
if (!item) throw new Error('Expected at least one item');
item.name; // OK
```

## Type Patterns

- Use `readonly` for immutable data (RunContext fields, config)
- Use discriminated unions for state machines (run status, loop phase)
- Prefer `interface` for object shapes, `type` for unions/intersections
- Use `Record<string, T>` not `{ [key: string]: T }`
- No `any` — use `unknown` and narrow with type guards

## Error Handling

- Use typed errors extending `Error` with a `code` field
- Catch specific error types, not bare `catch (e)`
- Always include context in error messages: `new Error(\`Failed to fetch issue #\${num}: \${cause}\`)`

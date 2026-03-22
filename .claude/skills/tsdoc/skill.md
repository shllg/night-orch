---
name: tsdoc
description: TSDoc documentation conventions for night-orch TypeScript code, adapted from Vendis YARD rules
---

# Night-Orch TSDoc Conventions

Document the **why**, not the what. Comments must be short and precise, but clear enough that a junior developer can understand them. Explain intent, trade-offs, constraints, and non-obvious behavior — not what the code already says plainly.

## When to Document

**Always document:**
- Public interfaces and their methods (`ForgeAdapter`, `RunContext`, etc.)
- Exported pure functions (`decide()`, `computeLabelMutation()`)
- Non-obvious parameters or return shapes
- Functions that throw deliberately
- Classes and functions where usage is non-obvious from the signature

**Skip documentation for:**
- Obvious getters and trivial one-liners
- Private helpers whose name fully explains their purpose
- Internal implementation details already covered by a parent doc
- Test files (describe/it blocks are the documentation)

## Format Rules

Use `/** */` blocks. One blank line between prose and tags.

```typescript
/**
 * Prose description first — what this does and why it exists.
 *
 * @remarks
 * Extended discussion goes here. Architecture decisions, edge cases,
 * cross-cutting concerns. Omit if the main description is sufficient.
 *
 * @param name - What this parameter represents and any constraints
 * @returns What is returned and when each variant applies
 * @throws {ErrorType} When and why this is thrown
 *
 * @example
 * ```typescript
 * const result = myFunction(input);
 * ```
 */
```

**Tags:**
- `@param name - description` (no type — TypeScript has it)
- `@returns` (not `@return`)
- `@throws {ErrorType} description` — only when thrown deliberately
- `@remarks` — extended prose, architecture notes
- `@example` — TypeScript code block, for non-obvious usage
- `@internal` — marks APIs not intended for external callers

## Night-Orch Examples

### Interface (ForgeAdapter)

```typescript
/**
 * Adapter interface for forge operations (GitHub, Forgejo).
 *
 * All forge API calls must go through this interface. Implementations live in
 * `forge/github.ts` and `forge/forgejo.ts` — never call Octokit directly elsewhere.
 */
export interface ForgeAdapter {
  /**
   * Fetches a single issue by number.
   *
   * @param repo - Owner/repo slug, e.g. `"acme/backend"`
   * @param number - Issue number
   * @returns The issue, or `null` if it does not exist
   * @throws {ForgeError} On API errors other than 404
   */
  getIssue(repo: string, number: number): Promise<Issue | null>;
}
```

### Pure Function (decide)

```typescript
/**
 * Determines the next action for a loop iteration.
 *
 * Pure function — no I/O, no side effects. Test exhaustively against every
 * branch: budget exceeded, max iterations reached, verify passed, etc.
 *
 * @param ctx - Current run context, including accumulated cost and iteration count
 * @returns Decision with action and human-readable reason
 */
export function decide(ctx: RunContext): Decision {
```

### RunContext step

```typescript
/**
 * Executes the planning phase and returns an updated context.
 *
 * Compiles the planner prompt, calls the worker, and parses the structured
 * plan output. Writes `phase_start` / `phase_complete` checkpoints to DB.
 *
 * @param ctx - Incoming run context
 * @param forge - Forge adapter for fetching issue comments
 * @returns New context with `planOutput` populated
 * @throws {PlannerError} When the worker returns an unparseable response
 */
export async function runPlanner(ctx: RunContext, forge: ForgeAdapter): Promise<RunContext> {
```

### Side-effect-only function

```typescript
/**
 * Applies a label mutation to the forge issue.
 *
 * Idempotent — calling with the same inputs multiple times produces the same
 * result. Compute the mutation first with `computeLabelMutation()`.
 *
 * @returns `undefined` — called for side effects only
 */
async applyLabels(repo: string, issue: number, mutation: LabelMutation): Promise<void> {
```

### Config schema entry (Zod)

```typescript
/**
 * Maximum cumulative token cost (USD) before the loop halts.
 *
 * Guards against runaway spending on a single issue. The `decide()` function
 * checks this after each worker call.
 */
budgetUsd: z.number().positive().default(1.0),
```

## Checklist

Before finishing a documentation pass:

- [ ] Every exported function and interface has a `/** */` block
- [ ] Prose describes intent/why, not a restatement of the signature
- [ ] `@param` present for every non-obvious parameter
- [ ] `@returns` present unless the function returns `void` or `Promise<void>`
- [ ] `@throws` present for every deliberate throw; absent for propagated errors
- [ ] `@example` added for non-obvious usage (interfaces, complex functions)
- [ ] No `@param {type}` — TypeScript carries the types
- [ ] No "obvious" comments (`// increment counter`, `// return result`)
- [ ] English only; no AI attribution
- [ ] Private helpers: bare `@returns` only if name is not self-explanatory

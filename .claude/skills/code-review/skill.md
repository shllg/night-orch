---
name: code-review
description: 8-point checklist for reviewing night-orch code changes against project conventions
---

# Night-Orch Code Review

Apply this checklist to all code changes. Every item must pass or have an explicit justification for deviation.

## Checklist

### 1. RunContext Immutability
- [ ] No mutations to RunContext — only spread-and-extend
- [ ] New fields added via `{ ...ctx, newField: value }`
- [ ] No `ctx.field = value` anywhere

### 2. ForgeAdapter Boundary
- [ ] All forge operations go through ForgeAdapter interface
- [ ] No direct Octokit/API calls outside `forge/github.ts` or `forge/forgejo.ts`
- [ ] New forge methods added to interface first, then both implementations

### 3. Worker Environment Isolation
- [ ] No `process.env` passed to workers
- [ ] `buildWorkerEnv()` used for worker process env
- [ ] No new sensitive vars added to worker whitelist without justification
- [ ] No forge tokens accessible to workers

### 4. Phase Checkpointing
- [ ] Every loop phase writes `phase_start` before work
- [ ] Every loop phase writes `phase_complete` or `phase_failed` after
- [ ] Timing data included for metrics

### 5. Metrics Best-Effort
- [ ] Metrics calls wrapped in try/catch
- [ ] Metrics never awaited in critical path
- [ ] Metrics never throw

### 6. Label Idempotency
- [ ] Label mutations use `computeLabelMutation()` (pure function)
- [ ] Applied via `LabelManager`
- [ ] Safe to call multiple times with same input

### 7. Error Handling
- [ ] Typed errors with `code` field
- [ ] Specific catch blocks, not bare `catch (e)`
- [ ] Context in error messages (runId, issue number, phase)
- [ ] No swallowed errors (catch without log or rethrow)

### 8. TypeScript Strictness
- [ ] No `any` types
- [ ] All indexed access checks for `undefined` (`noUncheckedIndexedAccess`)
- [ ] ESM imports with `.js` extension
- [ ] `node:` prefix for Node.js builtins
- [ ] Zod validation at system boundaries

## Process

1. Read the diff: `git diff --staged` or `git diff main...HEAD`
2. Walk through each changed file against the checklist
3. For each violation, note the file, line, and which checklist item fails
4. Summarize: pass/fail count, blocking issues, suggestions

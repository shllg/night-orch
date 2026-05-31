---
name: thermo-nuclear-code-quality-review
description: Run an extremely strict maintainability review for abstraction quality, giant files, and spaghetti-condition growth. Use for a thermo-nuclear code quality review, thermonuclear review, deep code quality audit, or especially harsh maintainability review.
disable-model-invocation: true
---

# Thermo-Nuclear Code Quality Review

Use this skill for an unusually strict review focused on implementation quality, maintainability, abstraction quality, and codebase health.

Above all, this skill should push the reviewer to be **ambitious** about code structure. Do not merely identify local cleanup opportunities. Actively search for "code judo" moves: restructurings that preserve behavior while making the implementation dramatically simpler, smaller, more direct, and more elegant.

## Core Prompt

Start from this baseline:

> Perform a deep code quality audit of the current branch's changes.
> Rethink how to structure / implement the changes to meaningfully improve code quality without impacting behavior.
> Work to improve abstractions, modularity, reduce Spaghetti code, improve succinctness and legibility.
> Be ambitious, if there is a clear path to improving the implementation that involves restructuring some of the codebase, go for it.
> Be extremely thorough and rigorous. Measure twice, cut once.
> Treat tests as the substrate that makes behavior-preserving change safe — review them with the same rigor as the implementation, and refuse to bless a restructuring you cannot verify.

## Non-Negotiable Additional Standards

Apply the baseline prompt above, plus these explicit review rules:

0. **Be ambitious about structural simplification.**
   - Do not stop at "this could be a bit cleaner."
   - Look for opportunities to reframe the change so that whole branches, helpers, modes, conditionals, or layers disappear entirely.
   - Prefer the solution that makes the code feel inevitable in hindsight.
   - Assume there is often a "code judo" move available: a re-organization that uses the existing architecture more effectively and makes the change dramatically simpler and more elegant.
   - If you see a path to delete complexity rather than rearrange it, push hard for that path.

1. **Do not let a PR push a file from under 1k lines to over 1k lines without a very strong reason.**
   - Treat this as a strong code-quality smell by default.
   - Prefer extracting helpers, subcomponents, modules, or local abstractions instead of letting a file sprawl past 1000 lines.
   - If the diff crosses that threshold, explicitly ask whether the code should be decomposed first.
   - Only waive this if there is a compelling structural reason and the resulting file is still clearly organized.

2. **Do not allow random spaghetti growth in existing code.**
   - Be highly suspicious of new ad-hoc conditionals, scattered special cases, or one-off branches inserted into unrelated flows.
   - If a change adds "weird if statements in random places", treat that as a design problem, not a stylistic nit.
   - Prefer pushing the logic into a dedicated abstraction, helper, state machine, policy object, or separate module instead of tangling an existing path.
   - Call out changes that make the surrounding code harder to reason about, even if they technically work.

3. **Bias toward cleaning the design, not just accepting working code.**
   - If behavior can stay the same while the structure becomes meaningfully cleaner, push for the cleaner version.
   - Do not rubber-stamp "it works" implementations that leave the codebase messier.
   - Strongly prefer simplifications that remove moving pieces altogether over refactors that merely spread the same complexity around.

4. **Prefer direct, boring, maintainable code over hacky or magical code.**
   - Treat brittle, ad-hoc, or "magic" behavior as a code-quality problem.
   - Be skeptical of generic mechanisms that hide simple data-shape assumptions.
   - Flag thin abstractions, identity wrappers, or pass-through helpers that add indirection without buying clarity.

5. **Push hard on type and boundary cleanliness when they affect maintainability.**
   - Question unnecessary optionality, `unknown`, `any`, or cast-heavy code when a clearer type boundary could exist.
   - Prefer explicit typed models or shared contracts over loosely-shaped ad-hoc objects.
   - If a branch relies on silent fallback to paper over an unclear invariant, ask whether the boundary should be made explicit instead.

6. **Keep logic in the canonical layer and reuse existing helpers.**
   - Call out feature logic leaking into shared paths or implementation details leaking through APIs.
   - Prefer existing canonical utilities/helpers over bespoke one-offs.
   - Push code toward the right package, service, or module instead of normalizing architectural drift.

7. **Treat unnecessary sequential orchestration and non-atomic updates as design smells when the cleaner structure is obvious.**
   - If independent work is serialized for no good reason, ask whether the flow should run in parallel instead.
   - If related updates can leave state half-applied, push for a more atomic structure.
   - Do not over-index on micro-optimizations, but do flag avoidable orchestration complexity that makes the implementation more brittle.

8. **Treat tests as the verification substrate, and review them as first-class code.**
   - Behavior-preserving restructuring is only safe when a green test suite pins the behavior. If the affected code is not covered, the refactor is unsafe — demand the tests land first (or in the same change), not "we can add tests later".
   - A change that introduces new behavior without tests is a code-quality regression, not just a process gap.
   - Read the tests. Test code rots the same way production code does — copy-paste setup, sprawling per-case noise, brittle over-mocking, asserting on implementation details, oracle-style snapshots that pass for the wrong reason.
   - Demand modular, simple, behavior-focused tests: small focused cases, shared setup extracted into helpers/fixtures, table-driven structure for combinatorial inputs, mocks at real boundaries only.
   - Refuse tests that lock in the current implementation rather than the contract — they break on every refactor and actively work against this skill's ambition.
   - Run the project's test, typecheck, and lint suites before approving. A review that does not confirm green is not a review.
   - The file-size rule in #1 does **not** apply to test files. Judge tests on duplication, setup complexity, and per-case clarity instead — large exhaustive or table-driven suites are fine when each case is small and self-contained.

## Primary Review Questions

For every meaningful change, ask:

- Is there a "code judo" move that would make this dramatically simpler?
- Can this change be reframed so fewer concepts, branches, or helper layers are needed?
- Does this improve or worsen the local architecture?
- Did the diff add branching complexity where a better abstraction should exist?
- Did a previously cohesive module become more coupled, more stateful, or harder to scan?
- Is this logic living in the right file and layer?
- Did this change enlarge a file or component past a healthy size boundary?
- Are there repeated conditionals that signal a missing model or missing helper?
- Is the implementation direct and legible, or does it rely on special cases and incidental control flow?
- Is this abstraction actually earning its keep, or is it just a wrapper?
- Did the diff introduce casts, optionality, or ad-hoc object shapes that obscure the real invariant?
- Is this logic living in the canonical layer, or did the diff leak details across a boundary?
- Is this orchestration more sequential or less atomic than it needs to be?
- Is the behavior this change preserves or introduces actually covered by tests?
- Do the tests verify behavior through the public contract, or are they coupled to the current implementation?
- Are tests organized so each case is small, focused, and obvious — or is there sprawling setup, copy-paste, or noise hiding the intent?
- Are mocks placed at real boundaries, or are they mocking internal pure functions and creating fake confidence?
- If this refactor lands, will the tests survive it, or will they have to be rewritten alongside?
- Did the suite actually run green (test, typecheck, lint), and was the output observed?

## What to Flag Aggressively

Escalate findings when you see:

- A complicated implementation where a cleaner reframing could delete whole categories of complexity.
- Refactors that move code around but fail to reduce the number of concepts a reader must hold in their head.
- A file crossing 1000 lines due to the PR, especially if the new code could be split out.
- New conditionals bolted onto unrelated code paths.
- One-off booleans, nullable modes, or flags that complicate existing control flow.
- Feature-specific logic leaking into general-purpose modules.
- Generic "magic" handling that hides simple structure and makes the code harder to reason about.
- Thin wrappers or identity abstractions that add indirection without simplifying anything.
- Unnecessary casts, `any`, `unknown`, or optional params that muddy the real contract.
- Copy-pasted logic instead of extracted helpers.
- Narrow edge-case handling implemented in the middle of an already busy function.
- Refactors that technically pass tests but make the code less modular or less readable.
- "Temporary" branching that is likely to become permanent debt.
- Bespoke helpers where the codebase already has a canonical utility for the job.
- Logic added in the wrong layer/package when it should live somewhere more central.
- Sequential async flow where obviously independent work could stay simpler and clearer with parallel execution.
- Partial-update logic that leaves state less atomic than necessary.
- New or restructured behavior with no test covering it.
- "Behavior-preserving" refactors over code paths that have no tests pinning the behavior.
- Tests asserting on implementation details (internal call counts, private shapes, log strings) instead of observable contract.
- Sprawling test setup, copy-pasted fixtures, or per-case boilerplate that obscures what each case actually proves.
- Over-mocking — especially mocks of internal pure functions, or mocks so broad the test no longer exercises real logic.
- Snapshot or oracle tests that pass without anyone being able to say what behavior they guard.
- Tests written against the current code's exact branching structure, guaranteed to break on the kind of restructuring this skill advocates.
- A PR that ships green only because flaky cases were skipped, weakened, or removed.

## Preferred Remedies

When you identify a code-quality problem, prefer suggestions like:

- Delete a whole layer of indirection rather than polishing it.
- Reframe the state model so conditionals disappear instead of getting centralized.
- Change the ownership boundary so the feature becomes a natural extension of an existing abstraction.
- Turn special-case logic into a simpler default flow with fewer exceptions.
- Extract a helper or pure function.
- Split a large file into smaller focused modules.
- Move feature-specific logic behind a dedicated abstraction.
- Replace condition chains with a typed model or explicit dispatcher.
- Separate orchestration from business logic.
- Collapse duplicate branches into a single clearer flow.
- Delete wrappers that do not meaningfully clarify the API.
- Reuse the existing canonical helper instead of introducing a near-duplicate.
- Make type boundaries more explicit so the control flow gets simpler.
- Move the logic to the package/module/layer that already owns the concept.
- Parallelize independent work when that also simplifies the orchestration.
- Restructure related updates into a more atomic flow when partial state would be harder to reason about.
- Land the tests that pin the behavior **before** doing the restructuring, then make the restructuring obvious in diff.
- Replace implementation-coupled assertions with assertions on the public contract / observable outcome.
- Extract shared setup into a fixture or factory so each case shows only what makes it different.
- Convert repeated near-identical cases into a table-driven test.
- Push mocks out to real boundaries (process, network, filesystem, clock) and let internal code run for real.
- Delete oracle/snapshot tests whose intent nobody can articulate, and replace them with explicit behavioral cases.

Do not be satisfied with "maybe rename this" feedback when the real issue is structural.
Do not be satisfied with a merely cleaner version of the same messy idea if there is a plausible path to a much simpler idea.

## Review Tone

Be direct, serious, and demanding about quality.
Do not be rude, but do not soften major maintainability issues into mild suggestions.
If the code is making the codebase messier, say so clearly.
If the implementation missed an opportunity for a dramatic simplification, say that clearly too.

Good phrases:

- `this pushes the file past 1k lines. can we decompose this first?`
- `this adds another special-case branch into an already busy flow. can we move this behind its own abstraction?`
- `this works, but it makes the surrounding code more spaghetti. let's keep the behavior and restructure the implementation.`
- `this feels like feature logic leaking into a shared path. can we isolate it?`
- `this abstraction seems unnecessary. can we just keep the direct flow?`
- `why does this need a cast / optional here? can we make the boundary more explicit instead?`
- `this looks like a bespoke helper for something we already have elsewhere. can we reuse the canonical one?`
- `i think there's a code-judo move here that makes this much simpler. can we reframe this so these branches disappear?`
- `this refactor moves complexity around, but doesn't really delete it. is there a way to make the model itself simpler?`
- `i don't see a test that pins this behavior — can we add the test first so this restructuring is actually safe?`
- `this test asserts on the implementation, not the contract. it will break the moment we do the code-judo move. let's rewrite it against the public behavior.`
- `the setup is doing more work than the assertion. can we extract a fixture so each case is just the input → expected pair?`
- `this mock is hiding the logic under test. can we mock the real boundary and let the inside run?`
- `i can't tell what behavior this snapshot is guarding. can we replace it with explicit cases?`
- `did the suite actually run green? please confirm test, typecheck, and lint before we approve this.`

## Output Expectations

Prioritize findings in this order:

1. Missing or inadequate test coverage for changed behavior
2. Structural code-quality regressions
3. Test-code quality regressions — implementation-coupled, brittle, over-mocked, or sprawling setup
4. Missed opportunities for dramatic simplification / code-judo restructuring
5. Spaghetti / branching complexity increases
6. Boundary / abstraction / type-contract problems that make the code harder to reason about
7. File-size and decomposition concerns
8. Modularity and abstraction issues
9. Legibility and maintainability concerns

A structural simplification you cannot verify is worse than no simplification — coverage is the gate before the rest matters.

Do not flood the review with low-value nits if there are larger structural issues.
Prefer a smaller number of high-conviction comments over a long list of cosmetic notes.

## Approval Bar

Do not approve merely because behavior seems correct.
The bar for approval is:

- no clear structural regression
- no obvious missed opportunity to make the implementation dramatically simpler when such a path is visible
- no unjustified file-size explosion
- no obvious spaghetti-growth from special-case branching
- no obviously hacky or magical abstraction that makes the code harder to reason about
- no unnecessary wrapper/cast/optionality churn obscuring the real design
- no clear architecture-boundary leak or avoidable canonical-helper duplication
- no missed opportunity for an obvious decomposition that would materially improve maintainability
- behavior changed or restructured under green, meaningful tests that verify the public contract
- test code itself is clean, modular, and not coupled to the implementation it's testing
- the project's test, typecheck, and lint suites were actually run and observed green

Treat these as presumptive blockers unless the author can justify them clearly:

- the PR preserves a lot of incidental complexity when there is a plausible code-judo move that would delete it
- the PR pushes a file from below 1000 lines to above 1000 lines
- the PR adds ad-hoc branching that makes an existing flow more tangled
- the PR solves a local problem by scattering feature checks across shared code
- the PR adds an unnecessary abstraction, wrapper, or cast-heavy contract that makes the design more indirect
- the PR duplicates an existing helper or puts logic in the wrong layer when there is a clear canonical home
- the PR changes or restructures behavior that has no test covering it, and no test is added in the same change
- the PR's tests assert on implementation detail rather than observable contract, and would break under the restructuring this skill encourages
- the PR weakens, skips, or deletes tests to get the suite green
- the PR was not run through the project's test, typecheck, and lint suites, or the result is not stated

If those conditions are not met, leave explicit, actionable feedback and push for a cleaner decomposition.

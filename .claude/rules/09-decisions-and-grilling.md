# Design sessions and decision records

## One grilling skill

`orch-grilling` is the only grilling skill in this repository. It reads the altitude of the
ask itself — a direction or a "should we" is grilled at product level, a named feature at
feature level — so there is no second command for the other altitude, and no variant that
writes documents as a side effect.

The vendored Matt Pocock skills predate this and still name `/grilling`, `/grill-me` and
`/grill-with-docs` in their prose. Those three skills are gone. Read any such reference as
`orch-grilling`. Those files are lock-owned (`skills-lock.json`) and so are corrected here
rather than edited in place.

## When an ADR is written

An ADR is written **by the slice that implements the decision**, in the same change as the
code, and never ahead of it.

An ADR written weeks before its implementation describes a system no reader can check
against reality, and drifts silently until the code contradicts it.

- `orch-grilling` writes **no ADR**. It carries settled decisions into the issue.
- `orch-work` writes the ADR for a decision its slice makes, and commissions it with the code.
- The three-part gate still applies: hard to reverse, surprising without context, and the
  result of a real trade-off. If any one fails, write no ADR.
- A decision that constrains the work before it starts — a regulatory or tenancy boundary —
  may still be recorded ahead of the code it governs.
- Superseding or retiring an existing ADR remains a standalone change.

Where a vendored skill's prose says to update ADRs inline as decisions land — `triage`,
`wayfinder` and `domain-modeling` all do — this rule overrides it. `CONTEXT.md` may still be
updated inline; it is a glossary, not a decision record.

## Decision and glossary formats

`ADR-FORMAT.md` and `CONTEXT-FORMAT.md` live beside the grilling skill, in
`.agents/skills/orch-grilling/`. The lock-owned `improve-codebase-architecture` skill still links to
them at their old `../grill-with-docs/` path; read those two links as pointing here.

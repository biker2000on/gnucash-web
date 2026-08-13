# Bug tracker

> **Where the open defects actually live.** This file tracks user-reported bugs
> only. It is *not* the whole picture, and for a period it wrongly implied it
> was. Engineering-found defects are tracked in two other places, and both
> currently hold open items:
>
> - **`TODOS.md`** — the `## P0` / `## P1` sections carry open data-integrity
>   and correctness findings from the 2026-08-12 adversarial review.
> - **`asi-review.md`** — the ASI pre-release audit findings.
>
> Re-verified against code at `1178c54` on 2026-08-13. Do not read an empty
> "Open" section below as "the codebase has no known defects."

## Open

No user-reported bugs are currently outstanding.

Engineering-found defects: see `TODOS.md` (P0/P1) and `asi-review.md`.
Highest-severity currently open — cross-book writes are still possible through
the general ledger create/update routes and through bulk reconcile
(`TODOS.md`, `## P0 — Cross-book writes still open`).

## Resolved

- 2026-07-26: Clearing all General Ledger filters now reloads the unfiltered
  transaction set.
- 2026-07-26: Transaction modals now reset their internal scroll position and
  open within the current viewport.
- 2026-07-26: Reconciliation selection and totals now operate on every
  account split represented by a ledger row, including transactions with
  multiple splits posting to the same account.

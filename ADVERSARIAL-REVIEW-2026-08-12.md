# Adversarial Review — gnucash-web

**Date:** 2026-08-12 · **Commit:** `c788906` (main, freshly pulled)
**Method:** 6 independent read-only audits across 3 vendors (codex, claude_code, agy),
plus an independent cross-vendor adjudication of the tax findings.
Every finding below was **spot-verified against the source by the orchestrator**;
claims that failed verification were removed and are listed in Appendix A.

---

## Bottom line

The engineering hygiene here is genuinely good — 4,689 tests green, clean strict
typecheck, zero lint errors, zero `console.log`/`TODO`/`any` in the form layer.
**That is exactly why the findings matter: every bug below is green-but-wrong.**
The test suite locks in several of them.

Two structural themes dominate, and both are cheap to fix:

1. **The correct implementation frequently already exists but isn't wired to the
   live path.** The reconcile guard, payment idempotency, decimal-safe amount
   parsing, income-vs-expense variance semantics — all present in the codebase,
   all bypassed by the code that actually runs.
2. **Exact stored fractions are converted to floats before aggregation** in 53
   places, so the ledger's arithmetic is not the arithmetic GnuCash guarantees.

---

## Gate status (verified by orchestrator)

| Gate | Result |
|---|---|
| `npm run test:run` | 4,689 passed / 338 files |
| `tsc --noEmit` (strict) | 0 errors |
| `npm run lint` | 0 errors, 7 warnings |

Two CI observations:
- **CI never runs typecheck.** `.github/workflows/deploy.yml` runs `docs:check`,
  `test:run`, `lint` — no `tsc --noEmit`, and no `typecheck` script exists. The
  repo currently passes, so this is free regression insurance being left unclaimed.
- A fresh clone cannot typecheck until `npx prisma generate` runs (produces ~1,268
  phantom errors otherwise). Worth a line in the README.

---

## CRITICAL

### C1 — Budget roll-up double-counts any subtree budgeted at two levels
`src/lib/budget-actuals.ts:436-445`

`periodTotals` flat-sums per-account rows that have *already* been rolled up, with
no exclusion of accounts that descend from another budgeted account.

> Budget `Expenses:Auto` $500 and `Expenses:Auto:Gas` $200. Spend $100 on Auto,
> $200 on Gas (true total **$300**). Headline reads **Budgeted $700 / Spent $500**.
> Correct: $500 / $300.

The code documents the hazard at `:682-683` but nothing enforces it, and
`/api/budgets/generate` emits both rows (`budget-generator.ts:409-424`). Drives the
budget page tiles, pacing card, status badges, and the Budget Report Net row.
**No test covers a parent/child pair.**

### C2 — Reconciled splits can be freely edited, deleted, or re-parented
`src/app/api/transactions/[guid]/route.ts:330-358`, `src/app/api/splits/bulk/move/route.ts:151-154`

**Verified:** the guard exists — `transaction.service.ts:158-161` raises *"Cannot
modify transaction with reconciled splits"* — but `TransactionService` has **zero
production callers**. The live routes bypass it entirely.

> Reconcile checking through 06-30 at $4,000. Edit a June txn $250 → $520.
> `summarizeReconciled` now returns $4,270. July's reconcile demands $270 no
> statement will ever explain.

The reconcile flow *itself* is well built (advisory lock, server-side re-tie-out,
single `$transaction`). Nothing protects the result afterwards.

### C3 — The core amount input silently books wrong or zero-value transactions
`src/components/TransactionForm.tsx:477`, `:70-72`; `math-eval.ts:177`

`validateForm` tests `parseFloat(amount) <= 0`; for `"$1,234.56"` that is
`NaN <= 0` → **false**, so validation passes. `buildSimpleModeSplits` then does
`parseFloat(amount) || 0`.

| Input | Booked | Reported as |
|---|---|---|
| `$1,234.56` | **$0.00** | success |
| `1,234.56` | **$1.00** (1000× off) | success |
| `1.2.3` | $1.20 | success |

A correct `parseAmount()` that strips commas and guards `Number.isFinite` already
exists at `src/components/business/invoice-ui.ts:150-155`. The core ledger form
doesn't use it.

### C4 — Keyboard save bypasses the in-flight guard → duplicate transactions
`TransactionForm.tsx:637`, `:671`, `:710-727`

`handleSubmit` and `saveAndAnother` contain no `if (saving) return`, and both are
bound to **window-level** keydown listeners. `disabled={saving}` guards only the
mouse path. Ctrl+Enter twice during a slow POST → two identical ledger entries.

No idempotency key is sent (`TransactionFormModal.tsx:127`) even though
`route.ts:348` honours one — and the *duplicate-transaction* feature does send it
(`AccountLedger.tsx:1191`). `InlineEditRow.tsx:121` also gets this right.

### C5 — Inventory permits cross-book ledger postings
`src/lib/inventory-engine.ts:708`

**Verified:** `assertPostableAccount` selects only `{guid, placeholder}` — it never
checks book membership. A Book A item configured with a Book B inventory asset
posts Dr Book A COGS / Cr **Book B Inventory**. Balances globally, corrupts both books.

---

## HIGH

### H1 — Unpriceable holdings are silently valued at $0
`src/lib/account-valuation.ts:187-194`

Price *selection* is correct (latest-on-or-before). The fallback is not:
`multiplierCache.set(guid, rate ?? 0)`. **Verified:** `isConvertible` and
`warnings[]` have **zero consumers** — balance sheet, net-worth, family-office,
and account-summary all multiply straight through.

Sibling bug at `:195-199`: a **currency** account with no FX path falls back to
`?? 1`, i.e. parity. €10,000 reports as $10,000; ¥1,500,000 reports as $1,500,000.
Neither records a warning.

### H2 — Commissions are dropped from basis and proceeds
`src/components/InvestmentTransactionForm.tsx:111-145`, `:148-182`

The security split is written with `total`, not `total + commission` (buy) and
gross, not net (sell); the commission is expensed instead of capitalised
(IRC §1012 / Pub 551).

> Buy 10 @ $100 +$5, sell 10 @ $100 −$5 → 8949 reports gain **$0**.
> Correct: proceeds $995, basis $1,005, **loss $10**.

Locked in by `investment-entry-regressions.test.ts:99-112`.

### H3 — Closed lots fabricate a realized loss equal to the entire basis
`src/lib/lots.ts:118-122`

**Verified:** `return -splits.filter(...).reduce((s,x)=>s+x.value,0) - carriedBasis`.
A transfer-out carries qty −N, value $0, so the whole buy cost becomes a
"realized loss". A transfer between your own accounts is not a §1001 disposition.

> Buy 10 @ $100, transfer out → realized gain **−$1,000**. Correct: **$0**.

Blast radius: `detectWashSales` uses the same function to decide "was this a loss
sale?", so a transfer-out manufactures phantom wash-sale disallowances. The mirror
error is asserted by `lots-realized-gain.test.ts:80-87`.

### H4 — `average` cost basis admits transferred shares at $0
`src/lib/cost-basis.ts:358-360`

**Verified:** `average` returns early, *before* the `isTransferInSplit` recursion
that FIFO and LIFO get. This is a user-selectable per-account preference.

> Transfer in 10 sh (real basis $1,000) + buy 10 @ $150 → average basis $1,500.
> Correct: $2,500. **$1,000 of basis destroyed → $1,000 phantom gain.**

### H5 — Wash-sale disallowance is matched per calendar *day* and double-counted
`src/lib/reports/capital-gains.ts:261-265`

**Verified:** the join is ticker + account + **day**. `WashSaleResult.splitGuid`
exists but is never used.

> Same day: sale A loss $1,000 (fully washed), sale B loss $3,000 (not replaced).
> Both absorb the day's $1,000 → net −$2,000. Correct: −$3,000.

### H6 — Investment Lots report re-implements basis math and gets it wrong
`src/app/api/reports/investment-lots/route.ts:126-179`

**Verified:** the slots query fetches `name: 'title'` only — `carried_basis` and
`acquisition_date` appear **nowhere** in the file. Consequences: transferred lots
show $0 basis; unrealized gain compares full-lot basis against *remaining* shares
(a partially-sold lot shows −$100 where `lots.ts` shows +$300); holding period
restarts on transfer (contra §1223).

### H7 — Payment API drops the idempotency key it already supports
`src/app/api/business/payments/route.ts:65-74`

**Verified:** `transactionGuid` appears nowhere in the route; `invoice-engine.ts:1377`
honours it. A retried $40 payment posts twice ($80 against a $100 invoice). The
engine-level idempotency test passes by calling the engine directly, bypassing the defect.

### H8 — "Unpost" deletes the posting transaction instead of reversing it
`src/lib/business/invoice-engine.ts:1258-1272`

**Verified:** hard `deleteMany` on splits → `deleteSlotsRecursive` →
`transactions.delete` → `lots.delete`. A $1,000 March invoice leaves **zero
evidence** it was ever posted. Asserted by `invoice-engine.test.ts:934`.

### H9 — Aging never ties to the A/R control account, and ignores explicit due dates
`src/lib/business/business-reports.ts:624,640,644`; `:75`

Totals only invoice-*lot* splits, so any non-lot A/R posting (write-off, credit memo,
opening balance) desynchronises aging from the GL. Separately, the explicit
`trans-date-due` slot written at posting (`invoice-engine.ts:1150`) is discarded;
aging recomputes `post date + duedays`.

> Invoice posted Aug 1, negotiated due Sep 30. On Aug 20 aging says **19 days
> overdue** instead of Current.

### H10 — COGS defaults to not posting
`src/lib/inventory-engine.ts:968`; `.../fulfillment/route.ts:68`

`if (!post) return null`, and the API forwards an omitted `body.post` as `undefined`.
Default fulfilment moves stock but books no COGS → gross profit $100 instead of $40,
inventory asset overstated.

### H11 — Reconciliation can be finished out of balance, and the statement balance is discarded
`src/components/ReconciliationPanel.tsx:293`, `:89-97`, `:141`

`disabled={saving || selectedSplits.size === 0}` — **no check on `difference`**.
GnuCash desktop refuses this. Worse, the POST body carries only
`{splits, reconcile_state, reconcile_date}` — **`statementBalance` is never
transmitted**, so nothing records what the reconciliation was reconciled *against*.
`parseFloat(statementBalance) || 0` at `:141` turns an empty field into a
confidently-wrong difference.

### H12 — FIRE Monte Carlo inflates withdrawals but not contributions
`src/lib/fire/monte-carlo.ts:264-268`

Withdrawals are correctly converted real→nominal; contributions are added as bare
nominal. Defaults (`contributionGrowthPct: 0`, historical inflation) always exhibit it.

> $30k/yr real, 3% inflation, 30 yrs → contributes ≈**$588k real instead of $900k**.
> One-term fix: `nominal += contribution * cumInflation`.

### H13 — Server validation errors are discarded on create but shown on edit
`TransactionFormModal.tsx:109` vs `api/transactions/route.ts:322`

POST returns `{errors:[...]}` with **no `error` key**; PUT returns both. The client
reads `errorData.error || 'Failed to create transaction'`, so every field-level
create error is replaced by a generic string.

Compounded by a genuine **tolerance drift** (verified): `TransactionForm.tsx:530`
rejects at `> 0.01`, but `validation.ts:103` and `AccountLedger.tsx:917` reject at
`> 0.001`. A transaction off by 0.005 passes the client, is refused by the server,
and the reason is swallowed — an unfixable, unexplained failure.
*(Bonus: the comment at `validation.ts:102` reads "1 cent / 100 = 0.01" above code
using `0.001`.)*

### H14 — Fixed-asset adjustment uses transaction VALUE instead of account QUANTITY
`src/lib/asset-transaction-service.ts:37`, `:173`

For a EUR asset holding €100 recorded at $120, "adjust to target 100" computes
`delta = 100 − 120 = −20` and posts €20 of depreciation. Correct adjustment: zero.

---

## Systemic: 53 float8 money casts

`src/lib/reports/utils.ts:42` is the worst instance — it feeds Balance Sheet, Trial
Balance, Income Statement, Cash Flow, General Ledger, Equity Statement and Portfolio:

```sql
SUM(s.quantity_num::float8 / NULLIF(s.quantity_denom,0)::float8)::float8
SUM(s.value_num::float8   / NULLIF(s.value_denom,0)::float8)::float8
```

**Verified: 53 such casts across 20+ files.** GnuCash's whole point is that money is
an exact rational; this converts to IEEE-754 *before* summing, so results depend on
row order (float addition is non-associative) and drift over large split counts.
Same pattern in the ledger's user-facing running balance
(`api/accounts/[guid]/transactions/route.ts:164,521,538`), which is float-summed in
both SQL and JS.

Fix direction: aggregate in PostgreSQL `numeric` (exact) rather than `float8`, and
keep BigInt end-to-end in JS.

> **Calibration note.** The auditor's reproductions used values above 2⁵³
> ($90 trillion), which is not a realistic book. I am reporting this on the
> *accumulation/ordering* argument, which is real at ordinary magnitudes — not on
> the 2⁵³ example. Same caveat applies to the "Duplicate transaction changes stored
> int64" finding (`TransactionJournal.tsx:353`): the mechanism is real, the cited
> trigger is not reachable in a normal book. Treat as **MEDIUM**, not critical.

### Related: no exact server-side balance check
`src/lib/validation.ts:94-104` sums splits as **floats** and accepts residuals up to
`0.001`, then stores the original fractions exactly. A crafted API call or import can
persist a genuinely unbalanced transaction. There is no DB-level balance constraint
(`schema.prisma:69`), and `data-health.ts:253` only detects it later, also with a
tolerance. The multi-currency path *does* verify exactly with BigInt
(`trading-accounts.ts:322`) — the same-currency path doesn't.

---

## Form UI — AI slop assessment

**The forms are better than expected.** Zero `console.log`, zero `TODO`/`FIXME`,
zero `: any`, zero commented-out blocks across the entire form surface. Two
hypotheses I asked the auditor to confirm were **disproved**:

- *TransactionForm family is 4 duplicated copies* — **false.** One real editor, a
  thin modal wrapper, a misnamed read-only viewer (`TransactionModal` contains zero
  inputs), and a row component. Real drift is limited to `InlineEditRow` being a
  genuine second editor.
- *CreateBookWizard vs NewBookWizard are duplicates* — **false.** Both delegate to
  the same `NewBookForm`, both are routed to.

Genuine slop that remains:

| Location | Issue |
|---|---|
| `CreateBookWizard.tsx:41-72,220-255` | Hand-rolls a *second* book-creation form hitting a **different endpoint** (`/api/books/from-template` vs `/api/books/default`) with duplicated validation |
| 7 sites incl. `AccountLedger.tsx:958`, `InvestmentTransactionForm.tsx:578` | **Seven** hand-rolled "read the server error body" implementations, four with different precedence, one discarding the body entirely |
| `InvestmentTransactionForm.tsx:57,75,908-914` | **Write-only field** — "Split Ratio (informational)" is typed by the user, never submitted, never redisplayed |
| `InvestmentTransactionForm.tsx:34,51,53,55` | Dead prop `accountCommodityGuid` + 3 write-only state vars + a dead `nameField` param |
| `AccountPickerDialog.tsx:137` | `focus:border-accent` — **`--accent` does not exist**; combined with `focus:outline-none` this input has **no focus indicator at all** |
| `AccountForm.tsx`, `BudgetForm.tsx`, `LoginForm.tsx` | `rounded-xl`/`2xl` off `DESIGN.md:91`'s radius scale; three different input recipes across sibling forms |
| 6 sites incl. `InvestmentTransactionForm.tsx:643` | Native `title=` — **banned by `DESIGN.md:116`**. At `:643` the only explanation of "Return of Capital" is in a tooltip invisible to touch and keyboard |
| `AccountLedger.tsx:2276,2288` | `☑`/`☐` text glyphs as checkbox chrome — screen readers announce "ballot box", not state |
| `NotificationBell.tsx:151` vs `AccountForm.tsx:344` | `bg-error` and `bg-negative` are the same colour (`#dc2626`) under two token names |

### Form UX gaps beyond slop

- **H15 — Escape destroys a half-typed multi-split transaction.**
  `TransactionFormModal.tsx:163-164`: `closeOnBackdrop={false}` (good) but
  `closeOnEscape={true}`, and `Modal` calls `onClose()` unconditionally. Pressing
  Escape to dismiss an account dropdown discards five splits. No dirty-state
  tracking exists anywhere in `TransactionForm`.
- Server errors are surfaced via toast rather than inline on the offending field,
  and are not announced (`role="alert"` / `aria-live`) to screen readers.

---

## Confirmed-correct controls (credit where due)

- Invoice posting rounds half-away-from-zero per line and builds A/R from the *same*
  rounded pieces, so a $0.05+$0.05 invoice at 10% stays balanced
  (`invoice-totals.ts:154,203`).
- Payment allocations are lot-derived; over-application rejected; duplicate
  allocations rejected; concurrent payments lock invoice rows
  (`invoice-engine.ts:1411,1481`).
- Posted-invoice edits/deletes rejected; paid invoices cannot be unposted.
- Invoice posting, payment application and inventory movement are each wrapped in a
  single Prisma transaction; negative stock guarded.
- Multi-currency posting verifies the full split set with exact BigInt rational
  arithmetic (`trading-accounts.ts:322`).
- Scheduled-transaction posting forces integer numerators to sum to exactly zero
  (`scheduled-tx-execute.ts:40`).
- XML import preserves BigInt fractions rather than floating them
  (`gnucash-xml/importer.ts:948`).
- Price selection is genuinely latest-on-or-before, so historical views pick the
  right price (`account-valuation.ts:68-72`).
- §6654(i) farmer/fisherman logic is implemented *correctly* in `federal.ts:877-921`.
- RSU equity comp is correct (basis = FMV at vest).
- Budget *detail* page already handles income-vs-expense variance correctly
  (`BudgetProgress.tsx:328,365,417-421`) — the fix pattern exists in-repo.

---

## Tax findings (adjudicated)

The tax audit was run by `agy`, which proved unreliable (see Appendix A), so every
claim was re-adjudicated by an independent vendor and spot-checked by me.

| Finding | Severity | Status |
|---|---|---|
| `NEC_THRESHOLD = 600` is a bare constant with **no tax-year parameter**, while `ssWageBase` right beside it *is* year-keyed (`PARAMS[year]`) | **HIGH** | Verified structural defect. Whether $600 is currently correct should be checked against IRS instructions — the point is it *cannot* vary by year. |
| Corporate exemption is dead code — `CORP_CLASSIFICATIONS` exported, **never read**; exclusion is solely a manual checkbox | MEDIUM | Verified (1 occurrence repo-wide). A `c_corp` with a W-9 and $50k paid shows `ready_to_file`. |
| TXF omits realized capital gains entirely | MEDIUM | Confirmed |
| TXF `N304` for Traditional IRA may collide with Sch C line 24b (meals) | MEDIUM | **Unprovable in-repo.** Circumstantially strong: the Sch C block runs N293→N307 in exact line order with a single gap exactly where 24b belongs. Needs GnuCash's `txf.scm` or the TXF V042 list to settle. |
| Credit-card payments not excluded from 1099-NEC (§6050W) | LOW-MED | Confirmed; matters mainly for card-heavy books |
| Farmer flag not plumbed into the *estimated-tax tracker* | LOW | Correct math exists two modules away; tracker doesn't pass the flag |
| Jan 1–15 estimated payments | LOW | Overstated by original auditor — the payment is displayed as "prior year" and correctly credited to year N−1 Q4. Real defect is only that the YTD stat card and quarter buckets disagree. |

Also worth deleting: `annualized-installments.ts:34-36` and `route.ts:345` advertise
a Schedule AI "simplification" that **does not exist** — the code is exact. That
misleading comment is what caused the false CRITICAL below.

---

## Appendix A — claims that failed verification

Recorded so they don't resurface.

| Claim | Verdict |
|---|---|
| **"Form 2210 Schedule AI fails to prorate the SS wage base — CRITICAL, $1,799.55 error"** | **WRONG.** W-2 wages are annualized by the *same* factor (`estimator-inputs.ts:33`, verified), so `f × prorated_limit` = the full annual base and the app's result is *identical* to Schedule AI. The auditor's "correct" figure omitted the entire Social Security line. Real error: **$0.00**. |
| **"Schedule C keyword collision routes 'Taxicab' to Line 23 Taxes"** | **FABRICATED.** `grep -rn Taxicab src/` → **zero occurrences** anywhere in the repo. |
| "Qualified dividends double-counted into ordinary dividends" | WRONG |
| "Sales-tax report ignores `i_taxable`" | Overstated → LOW |
| "Date ranges truncate the final second" | Overstated → LOW/cosmetic |
| "TransactionForm family is 4 duplicated copies" | Disproved |
| "CreateBookWizard / NewBookWizard are duplicate wizards" | Disproved |
| "1,268 TypeScript errors" (my own initial reading) | **Wrong** — artifact of an ungenerated Prisma client. Actual: 0. |

---

## Suggested fix order

**Tier 1 — silent money corruption, small diffs**
1. C3 amount parsing — reuse the existing `parseAmount()` (one import)
2. C4 double-submit — add `if (saving) return` + send `guid` as idempotency key
3. H7 payment idempotency — pass `body.transactionGuid` through (one line)
4. C1 budget rollup — exclude descendants of budgeted accounts from `periodTotals`
5. H12 FIRE contributions — `* cumInflation` (one term)

**Tier 2 — data integrity**
6. C2 reconcile guard — route the live paths through `TransactionService` (or inline the check)
7. C5 inventory book-scope — add a book check to `assertPostableAccount`
8. H11 reconcile balance check + persist `statementBalance`
9. H1 surface `warnings`/`isConvertible` instead of silently valuing at $0
10. H13 unify the split-balance epsilon; return `error` from POST

**Tier 3 — tax/investment correctness**
11. H2 capitalise commissions · H3 closed-lot formula · H4 average-cost tracing ·
    H5 wash-sale join on `splitGuid` · H6 delete the duplicate lots report and reuse `lots.ts`
12. Year-parameterize `NEC_THRESHOLD`; wire `CORP_CLASSIFICATIONS`

**Tier 4 — systemic**
13. Convert the 53 `float8` money casts to `numeric`; start with `reports/utils.ts`
14. H8 reverse instead of delete on unpost · H9 tie aging to the control account and honour `trans-date-due`
15. Add `tsc --noEmit` to CI

---

*Findings verified against source by the orchestrator. Unverified vendor claims were
removed rather than reported.*

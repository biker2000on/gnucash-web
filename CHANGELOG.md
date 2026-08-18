# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

Covers work landed since 0.23.2.0 (2026-07-29).

### ⚠️ Behavior changes you should read before upgrading

- **Mortgage detection now treats material multi-draw and HELOC activity as an
  estimate.** A book with a $50,000 initial draw followed by an $80,000 draw
  previously reported a $50,000 original amount, 7.06% rate, and high
  confidence. It now reports $130,000, 2.45%, and low confidence with an
  explanation, preventing the first draw from being treated as the whole loan.
  Credits posted on the opening date are now summed as exact opening principal.
  Later credits are assessed individually against the opening principal, so
  recurring small servicing charges do not accumulate into a draw. A later
  credit must exceed 2% *and* $10,000 before it increases principal and marks
  the result estimated; ordinary fees, escrow, points, and modifications stay
  high confidence even on small-balance loans. The displayed principal, APR,
  and confidence can therefore change for HELOC and small-loan users.

- **Unposting an invoice or bill now records a reversing transaction instead of
  deleting the original posting.** The ledger keeps both entries — the original
  and its reversal, which cancel out — and the invoice returns to draft. The
  reversal is dated today (never earlier than the posting it reverses), so a
  closed prior period keeps the figures it was reported with. Previously the
  posting transaction and its splits were deleted outright, which silently
  rewrote prior-period financials and left no audit trail. A posting that no
  longer balances, has lost its receivable line, or has vanished is now refused
  with an explanatory error rather than being quietly discarded.
- **Accounts receivable and payable aging now uses each posted invoice's stored
  due date.** Previously aging was recomputed from the invoice date plus the
  vendor's *current* payment terms, so editing terms retroactively moved
  historical invoices between buckets and any explicit due-date override was
  ignored. Existing items may move between aging buckets, and the accounts
  payable "due within 7 / 30 days" totals may change. Invoices posted before
  their due date was recorded show a **†** marker with an explanation, because
  their due date is inferred from the posting date. **Payment reminder emails
  are never sent for an invoice with an inferred due date** — an inferred date
  can be up to a full terms period too early, and the reminder schedule only
  ever sends its highest crossed level, so a first contact could otherwise have
  been a final notice. Those invoices still appear in aging; they simply are
  not dunned. Backfilling due dates on historical postings is planned.
- **Invoice pages now agree with the aging report, and never show customers a
  due date we guessed.** The invoice detail page, the payments page, the
  printed invoice, and the public share link all derived their due date and
  OVERDUE badge from the vendor's *current* terms, so they could contradict
  aging for the same invoice. They now read the stored due date. Where an
  invoice was posted before its due date was recorded, customer-facing
  surfaces — the share page and the printed invoice — **omit the due date and
  the OVERDUE badge entirely** rather than assert a deadline that was inferred;
  internal pages continue to show the inferred date with its **†** marker.
  Those invoices are not dunned either, so the two behaviors agree.
- **Reconciliation can no longer be completed while out of balance.** Finishing
  requires the difference to be exactly zero in the account's own commodity
  units — previously the difference was calculated and then ignored, so an
  account could be marked reconciled while it did not agree with the statement,
  and the statement balance you typed was discarded rather than recorded. When
  a statement genuinely cannot be tied out, you can now create an adjusting
  entry to an Imbalance account, the way GnuCash desktop does, so the next
  reconciliation starts from a balanced position. Share and other non-currency
  accounts are gated the same way but do **not** get the automatic adjustment;
  those must be entered manually.
- **Reverting a lot assignment on a reconciled or frozen split now fails safely
  when the assignment was made before this release.** Those sub-splits carry no
  revert-provenance marker, so the system cannot prove the reversal is
  balance-neutral. Unreconcile the affected split (set its reconcile state back
  to `n`) and retry. There is no data migration; this affects historical lot
  assignments only.
- **Reconciled and frozen splits are now protected on every write path.**
  Editing, deleting, re-parenting, or bulk-moving a split whose reconcile state
  is `y` or `f` returns **423 Locked**. Previously these writes silently
  succeeded and could change a balance you had already agreed to a statement.
  To edit such a split, set its reconcile state back to `n` first.
- **Cost of goods sold now posts by default when stock ships or an invoice is
  fulfilled.** Previously it posted only if a caller explicitly opted in, so
  inventory stayed on the balance sheet after the goods left and gross profit
  was overstated. On a book that has been fulfilling without posting, reported
  profit will drop in the first period after upgrade — that is the correction
  landing, not a new error. Historical fulfilments are not rewritten; correcting
  them needs manual journal entries. **Items lacking both a COGS account and an
  inventory asset account now fail fulfilment with a clear error naming them**,
  where they previously succeeded silently. **Returns that post their reversal
  now reverse at the original shipment's weighted cost**, not the item's current
  average cost. Previously a unit shipped at $10 and returned after the average
  moved to $20 reversed at $20, leaving a permanent $10 residual in both cost of
  goods sold and inventory that no later transaction ever cleared. Returns
  remain opt-in. Returning stock against a fulfilment recorded before this
  release still works, but posting its COGS reversal is refused for
  average-cost items, because no shipment cost was stored at the time.
- **Totals no longer include holdings we cannot value, and say so.** A security
  with no available price was previously counted as zero and an account in a
  currency with no exchange rate was counted as if one unit equalled one
  dollar — so an unpriceable holding quietly disappeared from your net worth
  and a foreign-currency balance was silently wrong. Those balances are now
  excluded and named in an explicit notice on the dashboard. Consequences worth
  knowing before you upgrade: your net worth figure may **drop** if you hold
  anything unpriceable, the net worth **change** is withheld when the two dates
  could not value the same holdings, and the balance sheet withholds its total
  (and the budget balance sheet its check) when any balance could not be
  valued. Withholding is deliberate — excluding an asset while its equity stays
  valued makes the statement stop balancing, and a residual you cannot explain
  is worse than no number. Supply the missing prices or exchange rates and
  everything returns. If every holding in your book is priced, nothing changes.
- **Investment lot and fixed-asset figures will change for some accounts.**
  Lots acquired by in-kind transfer now report their carried cost basis and
  their original acquisition date, so previously-inflated gains shrink and
  positions misreported as short-term become long-term. Fixed-asset value
  adjustments are now computed against the account's quantity — the same basis
  the ledger and the on-screen balance already use — which changes the
  adjustment for assets whose quantity and transaction-currency value differ
  (multi-currency holdings and books imported from GnuCash desktop). Reports
  produced before this release should be regenerated.
- **Transaction balance is now checked exactly, not within a tolerance.**
  Saving a transaction previously summed the split amounts in floating point
  and accepted anything within a thousandth of a currency unit, so a
  transaction that did not actually balance could be written and would sit in
  the ledger uncorrected. Balance is now verified with exact whole-number
  arithmetic — it either balances or it does not. For ordinary entries in
  ordinary currencies nothing changes; the tolerance was already smaller than a
  cent. What changes is that an imbalance the old check waved through is now
  refused at save time with the amount named.

  The same correction applies to **settlement imports** (Stripe, PayPal,
  Shopify, Square). A row whose net, fee and gross did not agree to the cent
  was previously imported anyway and produced an unbalanced transaction; such
  rows are now reported as errors in the import preview, with the row number
  and the discrepancy, and every other row still imports. If a file you
  imported before was silently producing unbalanced entries, re-importing it
  will now tell you which rows are wrong.
- **Transactions can no longer be written into a book you do not have access
  to.** Creating or editing a transaction validated only that the account
  identifiers you supplied *existed* — not that they belonged to your book — so
  a user with edit access to one book could post entries into another book's
  accounts. Editing and deleting a transaction were similarly addressed by
  identifier alone. Both now resolve the accounts belonging to your book and
  refuse anything outside it, and edit and delete act only on transactions
  wholly contained in your book. Out-of-book identifiers are rejected exactly
  as unknown ones are, so the API cannot be used to probe whether another
  book's account exists.

  A related fault in the same code path is fixed: the **currency trading
  accounts** used to balance multi-currency entries were looked up globally
  rather than per book, so the first `Trading` hierarchy in the database served
  every book. On installations with more than one book, a multi-currency entry
  in one book could place its balancing split in another book's trading
  account. Each book now resolves — and if necessary creates — its own trading
  hierarchy. **If your books share a single trading tree today, each will
  create its own on first use after this upgrade.** Existing entries are not
  rewritten.

  `scripts/find-cross-book-transactions.ts` ships as a read-only check that
  reports any transaction whose splits span more than one book. A transaction
  in that state cannot be edited or deleted through the API by design and needs
  manual repair; there are expected to be none.
- **Cost basis for shares transferred in from another account is now traced,
  and where it genuinely cannot be established the app says so instead of
  showing zero.** A transfer-in split carries no value of its own, so shares
  moved between your own accounts previously entered the receiving account at
  **$0 basis** under the average-cost method — which then contaminated the
  reported basis of every other share in that pool, because averaging is
  pooled. Basis is now carried through the transfer chain. Where the chain runs
  dry — typically shares transferred in from an account outside this book —
  those shares are excluded from the average and reported separately rather
  than being silently valued at nothing.

  Portfolio cost basis, the ledger's running cost-basis column, and the
  dashboard figures derived from them will change for any book that has moved
  holdings between accounts; previously-understated basis rises and the
  corresponding overstated gain falls. **Form 8949 and the capital-gains report
  were not affected** — they read the stored carried basis directly and never
  used this path — so this does not imply anything about a filed return.

  Two cases now report "coverage unknown" rather than a number: an account
  holding a **short or oversold position**, where a cost basis for shares you
  do not yet own has no honest value, and any request made with cost-basis
  carry-over **switched off**, where the app has deliberately not traced
  anything and so cannot claim the basis is complete. Previously both reported
  full coverage, which was simply untrue.
- **Moving shares between your own accounts no longer deletes the gain.** When
  a same-commodity transfer between two of your own accounts was recorded with
  a value (rather than as a zero-value in-kind move), the source account's gain
  was correctly suppressed — a transfer is not a disposition — but the
  destination lot took the *transfer value* as its cost basis instead of the
  original purchase cost. The difference between what you paid and what the
  transfer was booked at was therefore recognised at **neither** end: it left
  the book entirely, and a later sale under-reported the gain. The original
  basis is now carried across the transfer, and any commission paid to acquire
  those shares is carried with them (pro-rated when only part of a lot moves),
  so a fee is no longer lost on transfer. The Investment Lots report and the
  Form 8949 export now derive basis identically and agree to the cent.

  **Lots that were already processed before this release keep their previous
  figures until they are reprocessed.** Their original cost was never recorded
  at the destination, so there is nothing yet for the reports to read. Nothing
  regresses — those lots behave exactly as they did — but they are not yet
  corrected either. **Order matters if you are regenerating tax reports:**
  reprocess the affected investment accounts *first*, then regenerate. A
  backfill that repairs these lots without a full reprocess is planned; if you
  are deciding about a prior-year return, wait for it rather than regenerating
  from partially-corrected data.
- **Brokerage commissions are now included in cost basis and proceeds — your
  previously-generated Form 8949 output overstated gains.** GnuCash records a
  commission as a separate expense split on the trade transaction, and the lot
  engine only ever looked at the security account's own splits, so the fee was
  structurally invisible to every basis calculation. Buy commissions are now
  added to basis and sell commissions netted off proceeds, so reported gains
  fall (or losses grow) by roughly the round-trip commission per lot. **If you
  filed from a capital-gains report produced by this app, it very likely
  overstated your gain, meaning you overpaid.** Re-run prior-year reports and
  compare before deciding whether an amended return is worthwhile.

  A trade fee is now **always** capitalized into basis and **never** taken as a
  deduction, which is the correct treatment and does not depend on your filing
  situation. If you had mapped a commission account to a deductible tax
  category, you were previously getting both — the deduction *and*, after the
  first fix, the basis adjustment. That is now impossible: the fees added to
  basis are excluded from the tax estimator's deduction inputs, by construction.
  For most books total taxable income is unchanged (a deduction is removed and
  an equal amount comes off the capital gain), but your tax *liability* can
  still move, because ordinary income, capital-gain rates, self-employment tax,
  QBI and deduction caps all interact differently — and if that deduction was
  previously capped or unused, your taxable income now **falls**. Affected
  accounts are named in a warning on the capital-gains report.

  Charges the classifier cannot confidently identify as trade fees — including
  anything reading as interest or tax, such as accrued bond interest — are left
  exactly as they are today and reported as a warning rather than guessed at.
  Nothing is capitalized on a ticket where the fee cannot be attributed to a
  specific security.
- **Moving shares between your own accounts no longer books a loss.** An in-kind
  transfer out of a lot was treated as a disposal at zero proceeds, so the full
  cost of the transferred shares was reported as a realized loss even though
  nothing was sold and the shares never left your ownership. Realized gain and
  loss totals, the Investment Lots report, and wash-sale detection all change
  for any book that has transferred holdings between accounts — fabricated
  losses disappear, and wash-sale rows that were matched against them go with
  them. A genuine worthless-security write-off is still reported as the real
  loss it is; only same-commodity moves between your own accounts are exempt.
  Form 8949 output was **not** affected, because the tax export already skipped
  these zero-value entries.

### Added

- **Tax:** OBBBA individual provisions; MFJ vs MFS breakeven analysis; filing
  status derived from the household profile; Form 2210 Schedule AI; farmer safe
  harbor with NIIT and carryover handling.
- **GnuCash XML:** full-fidelity round-trip across three waves — slots and lots,
  scheduled and template transactions, and nine business object families.
- **Documents:** unified storage with evidence links; multi-file upload with
  staged detailing and a tax archive organized by year; staged bill-review
  queue; drag-and-drop upload; service periods and itemized charges.
- **UI:** abbreviation glossary with accessible tooltips; multi-window pop-out
  panes and a compact sidebar; memo and double-line editing; investment date
  shortcuts.

### Changed

- **Lots and investments:** transfer-close basis carryover, per-sale LIFO,
  oversell handling, and wash-sale plus long-term holding rules; closed lots
  with no offset are now swept.
- **Book scoping:** business entities and budgets are now isolated per book.

### Fixed

- **Pressing Escape no longer destroys a half-typed transaction.** Escape, the
  close button, and Cancel all discarded an in-progress transaction outright,
  with no confirmation and no way to recover it — a multi-split entry could be
  lost to a single keystroke. A form you have not typed into still closes
  instantly, with no extra prompt; a form with unsaved changes now asks first,
  and declining returns you to the form with every value intact and the cursor
  back where it was. Editing an existing transaction and changing nothing
  counts as unchanged, so closing it is still immediate.

- **Restored the missing keyboard focus indicator on the account picker.** The
  account search box removed the browser's focus outline and replaced it with a
  colour that did not exist, so keyboard users had no visible indication of
  where they were. It now uses the same focus treatment as the rest of the app.
  Ten other controls had the same defect and are fixed; a further sweep
  confirmed the remaining uses do supply a visible replacement.

- **The fixed-asset list and the asset detail page now report the same
  balance.** The list totalled each asset's recorded transaction value while
  the detail page totalled units held, so for any asset where the two diverge
  the screens disagreed and there was no way to tell which was right. Both now
  use one shared calculation. Assets whose value and unit count agree are
  unaffected.

- **AR/AP aging can now be tied back to the balance sheet.** The aging report
  gains a per-control-account reconciliation showing the control account's
  balance, the aged total, and any unreconciled residual between them.
  Previously there was no way to check the aging report against the receivable
  or payable balance it was supposed to describe. Both sides of that comparison
  are computed the same way — same as-of date, same currency valuation, same
  account set, hidden accounts excluded — so a non-zero residual now means real
  unreconciled activity rather than an artefact of two different derivations.
  Where a receivable's currency cannot be converted, the account is reported
  with an explicit valuation gap instead of being silently valued at parity.
  **Invoices dated after the as-of date no longer appear in aging**, because a
  receivable that is not yet on the balance sheet cannot be past due against
  it; they reappear once their date arrives.

- **Portfolio and holdings screens no longer present an incomplete cost basis
  as a complete one.** When some shares in an account arrived by transfer and
  their original cost could not be traced, the cost basis shown covered only
  the shares it could account for — but it was labelled plainly "Cost Basis",
  and gain, gain %, and yield-on-cost were computed from it as though it
  covered the whole position. The reported gain was overstated by whatever
  basis was missing. Affected the holdings table, the portfolio summary cards,
  the dividends view, and the Investment Portfolio report. Each of those now
  states what the basis covers, in visible text rather than a tooltip: a
  partially covered position reads "Covered Gain" with the share counts, and a
  position whose basis could not be verified at all reads "Gain (basis
  unverified)". **Yield-on-cost is now withheld rather than estimated** when
  coverage is partial — income is received on every share, so scaling a
  trailing-twelve-month yield to the currently covered fraction assumes those
  shares were held and paid dividends in the same ratio for the whole year,
  which a mid-year transfer, sale, purchase, or reinvestment breaks. Coverage
  is now part of the holdings data type itself, so a screen cannot display a
  basis or a gain without also saying what it covers.
- **Transaction saves are now checked for balance exactly rather than within a
  tolerance.** The server accepted a set of splits whose amounts differed by up
  to a tenth of a cent, so a genuine half-cent imbalance could be written to
  the ledger. Balance is now verified with exact whole-number arithmetic on the
  underlying fractions, matching how the multi-currency path already worked.
  Settlement imports, which previously tolerated a one-cent mismatch and wrote
  the unbalanced result, now report the affected row in the import preview
  instead of importing it.
- **Ledger search and filters no longer hide matching transactions.** The
  amount and reconciliation-state filters were applied *after* a page of
  results had already been fetched, so searching for a $500 transaction simply
  did not find it if it fell outside the first unfiltered page, filtered pages
  came back short, and paging walked the unfiltered set. Filtering now happens
  in the database in the same query that pages, so a filtered page is full
  whenever more matches exist and paging walks the matches. Amounts are
  compared exactly rather than in floating point, and a transaction is matched
  by its largest line, so "at most $100" no longer returns a $3,000 paycheque
  because it happened to contain a $12 fee line. Malformed filter values
  (`?minAmount=abc`, a blank list entry, a bad page size or date) are now
  rejected with a clear error instead of being silently ignored — previously
  ignoring them returned the *entire* ledger.
- **The per-account ledger's filters had the same defect, and one of them was
  badly wrong.** Its amount and reconciliation filters were also applied after
  paging, and both matched against *any* line in the transaction rather than
  the account's own. Because the offsetting side of a bank transaction is
  essentially never reconciled, "Not Reconciled" matched almost every row on a
  chequing ledger — including fully reconciled ones — on the same screen that
  hosts the reconcile workflow. Both filters are now evaluated in the database
  against the account's own splits, so they agree with the Reconciled and
  Amount columns beside them. The running balance is still calculated across
  the account's full history rather than the filtered subset, so it remains a
  true balance as of each row.
- **Failed inbound email is no longer discarded silently.** A message that
  could not be processed was marked as read and recorded as retryable at the
  same time, so it could never be listed again and never retried — an inbound
  receipt or transaction simply vanished with no signal anywhere. Failures are
  now classified: transient problems (network, rate limits, storage) are
  retried a bounded number of times with backoff, while genuinely unprocessable
  messages stop immediately. Either way the failure and its reason appear in a
  "Needs attention" panel in settings and raise a notification, with an exact
  count when the list is truncated. Claims that stall are reported rather than
  rewritten, so a slow but healthy import is never marked failed underneath
  itself. Re-sending the email remains the way to re-ingest it; per-message
  manual retry is planned.
- **Reconciled-split protection (C2).** The guard existed but had zero
  production callers, so every live write path bypassed it. It is now enforced
  in 11 write paths, inside the writing transaction, after parent transactions
  are locked in canonical order. Covers the lot engine, including the
  zero-value-trade rewrite that changes both legs to ±FMV.
- **Cross-book inventory postings (C5).** Inventory posting validated only that
  an account existed, permitting a Book A item to post against a Book B
  inventory asset — balancing globally while corrupting both books. Posting now
  resolves and matches the account's owning book, and fails closed on orphan or
  cyclic account chains.
- **Five Tier-1 integrity defects**, including budget roll-up double-counting a
  subtree budgeted at two levels, and FIRE Monte Carlo inflating withdrawals but
  not contributions.
- **Cross-book writes through bulk split operations.** Bulk reconcile and bulk
  move selected and updated splits by identifier alone with no book constraint,
  so an editor holding another book's split identifiers could change its
  reconciliation state, move its splits into their own account, or push their
  own splits into it. Bulk move also bumped the other book's transaction
  timestamps, invalidating its editors' concurrency checks. Both operations are
  now scoped to the caller's book and reject the whole batch if any identifier
  falls outside it, so a partially-applied batch cannot occur. A related
  diagnostic could name an account from another book in its error message;
  it no longer can.
- **Duplicated wash-sale disallowance on Form 8949.** The adjustment was matched
  to a sale by ticker, account and day, so two sales of the same security in one
  account on one day each absorbed the other's disallowed loss. Matching is now
  per disposal. Wash-sale rows that correspond to no reported disposal — zero
  value in-kind transfers out, and unlotted sells — now raise a warning instead
  of disappearing silently.
- **Investment lots report re-derived its own cost basis** rather than using the
  shared lot engine, ignoring basis carried through in-kind transfers and dating
  holding periods from the transfer instead of the original purchase. It now
  uses the engine. It also valued holdings from a price quote in any currency
  when a book had no reporting currency configured, and counted holdings with no
  available quote as zero — presenting a partial portfolio total as complete.
  Both now report no value rather than a wrong one.
- **Rounding drift in financial statement totals.** Split sums were divided and
  added in floating point, so error accumulated across thousands of splits —
  seven splits of one seventh summed to 0.99999999999999977796 rather than 1.
  Sums are now computed in exact decimal arithmetic and converted once at the
  end, affecting Balance Sheet, Trial Balance, Income Statement, Cash Flow,
  General Ledger, Equity Statement and Portfolio.
- **"Failed to save" no longer hides the reason a transaction was rejected.**
  The reason was computed and logged on the server but never sent, and the
  browser discarded the response body regardless. Validation failures now
  explain themselves. Relatedly, the form checked a looser balance tolerance
  than the server, so a half-cent imbalance passed the form and was refused by
  the API with no explanation — and a legitimate multi-currency entry whose
  rounded amounts balanced exactly could be rejected as "unbalanced by 0.00".
  The form now validates the same rounded amounts it submits. An amount typed
  on a line with no account selected is flagged on that line instead of being
  silently dropped from the saved transaction.
- Deployments now reach production reliably.

### Security

- **Bank sync can no longer resolve or create accounts outside the book it is
  syncing.** Account lookups on the SimpleFin path — including the mapped
  account, categorisation-rule targets, historical counterparts, investment
  sub-accounts, and the Imbalance account — were not constrained to the book,
  and a fallback could select *any* root account. On a multi-book install that
  allowed a sync to post into a different book's ledger. Every lookup and
  creation is now scoped to the book being synced, the unscoped fallback is
  removed, and concurrent syncs can no longer create duplicate Imbalance
  accounts. A connection whose mapped accounts all point outside its book now
  reports a **failure** with the reason, where it previously reported success
  having imported nothing.
- **Security headers are now sent on every response** — `X-Frame-Options:
  SAMEORIGIN`, `X-Content-Type-Options: nosniff`, a strict referrer policy, a
  restrictive Permissions-Policy, and HSTS. HSTS ships at a deliberately short
  `max-age=300`; raise it once you have confirmed a week of clean HTTPS
  operation. `SAMEORIGIN` rather than `DENY` is intentional: in-app PDF and
  receipt previews render in a same-origin frame, isolated by a per-response
  content security policy.
- **GnuCash XML imports are now bounded during decompression.** A highly
  compressed upload could previously expand without limit; the bound is now
  enforced inside the decompression loop rather than after the data is in
  memory. The default ceiling is 256 MiB of decoded XML, overridable with
  `GNUCASH_XML_MAX_DECOMPRESSED_BYTES`, and it applies equally to compressed
  and uncompressed uploads. The limit is set well above a realistic book
  because backups are gzipped GnuCash XML restored through this same parser.
- **PostgreSQL no longer has a default password**, and the production stack
  will refuse to start without one rather than starting insecurely.

### Infrastructure

- **Data-store ports now bind to `127.0.0.1` instead of all interfaces** —
  production PostgreSQL and MinIO, and development Redis and MinIO. The
  application's own port is unchanged. If you previously connected to the
  database or the MinIO console from another machine, use SSH port forwarding
  (`ssh -L 9001:127.0.0.1:<console-port> <user>@<host>`). Access from the host
  itself is unaffected, and no in-app functionality depends on these ports —
  document and receipt downloads are proxied through the application.
- Container logs are now size-bounded on every service, and local state
  directories are excluded from the Docker build context.
- CI now runs a **typecheck gate** (`npm run typecheck`) before the docs, test,
  and lint gates, and the image build and production deploy are blocked on it.
- `npm run typecheck` regenerates the Prisma client first (`pretypecheck`), so a
  stale generated client can no longer produce phantom local type errors after
  pulling a schema change.
- README documents the required `npx prisma generate` step for fresh clones.

### Known open

Cross-book writes remain possible through the general ledger create/update
routes and through bulk reconcile. See `TODOS.md`,
`## P0 — Cross-book writes still open`.

## [0.23.2.0] - 2026-07-29

### Changed — Folio branding completion
- The product is now simply **Folio** — the "for GnuCash" descriptor is
  retired from the brand lockup, PWA manifest, page titles, calendar-feed
  PRODID, and docs header.
- Marketing pages, README, and the docs site no longer describe the product
  as a GnuCash companion. GnuCash appears only where compatibility genuinely
  applies: XML import/export, desktop round-trip backups, the
  GnuCash-compatible core schema note in the admin docs, and the TXF format
  reference. The footer trademark disclaimer remains.
- In-app copy (account/investment empty states, settings descriptions,
  report footnotes, payslip/HSA/family-banking labels) refers to "your book"
  or "the ledger" instead of GnuCash.

## [0.23.1.0] - 2026-07-29

Adversarial-review follow-ups to the July 28 multi-user concurrency and
performance wave.

### Fixed — concurrency and freshness
- Account moves now verify the new parent belongs to the active book, closing
  a cross-book reparenting path that bypassed the per-book lock and could
  recreate the account-cycle corruption (and graft accounts into another
  book's tree).
- Every remaining ledger-writing path now invalidates the event-evicted Redis
  caches and publishes a data-change event: Stripe payment webhooks, inbound
  transaction webhooks, funding-rule sweeps, recurring-invoice generation,
  audit undo, payslip posting, ESPP/vest posting, asset valuation and
  depreciation, inventory movements/assembly/fulfillment/receiving,
  QuickBooks and settlement import commits, Safe Operator scheduled-command
  execute/undo, rule apply-to-history, farm account grafts, and transaction
  review/type/tag metadata edits. Previously these could leave every user
  seeing day-old balances until an unrelated write evicted the cache.
- A SimpleFin sync that creates accounts but imports no transactions now
  refreshes caches and notifies open UIs about the new accounts.
- Starting a reconciliation now supersedes a stale in-progress session
  (e.g. after a browser crash) instead of failing forever against the
  one-started-session-per-account constraint.
- Statement finalize locks the parent transactions of reconciled splits in
  canonical order and bumps their optimistic-lock token, so a user holding
  one of those transactions open in an editor gets a conflict instead of
  silently reverting the reconciliation on save.
- Lot auto-assign, clear, and scrub-run revert bump the optimistic-lock token
  on affected transactions, so concurrent editors can no longer silently
  strip fresh lot links.
- The in-transaction period-lock check now runs on the transaction's own
  connection instead of grabbing a second pool connection (removes a
  pool-starvation deadlock under load), and statement finalize's check
  bypasses the TTL cache like every other write path.
- Fixed two remaining lock-order inversions (single-split lot assignment and
  bulk recategorize) that could deadlock against concurrent transaction
  edits.

### Changed — API (breaking)
- `DELETE /api/transactions/{guid}` now requires the `original_enter_date`
  optimistic-lock token, matching PUT (missing → 428, stale → 409). All
  in-app callers already send it; external scripts must be updated — see
  docs/api-tokens.md.

### Removed — roadmap
- Dropped Phase 6 (GnuCash desktop `gnclock` coexistence) from the
  concurrency roadmap: this database is never opened by GnuCash desktop;
  interop is export-only. A dedicated mechanism may be designed later if
  needed.

## [0.23.0.0] - 2026-07-27

### Added
- Added reference documentation for every registered feature, including its
  purpose, prerequisites, permissions, operating steps, read/write boundaries,
  and verification checklist.
- Added concept guides for double-entry books, investment quantity and value,
  reconciliation and close, provenance and safe actions, and Family Office.
- Added administrator guides for upgrades, backups and recovery, security,
  workers and connections, and API automation.
- Added route-aware Help links throughout the authenticated application and
  documentation destinations to the command palette.
- Added a documentation coverage check and made it a required pre-build step
  in the release workflow.

### Changed
- Documentation search now covers tutorials, workflow guides, concepts,
  administration, API reference, and the complete feature registry.
- Public feature catalog entries now link directly to their matching operating
  guide.

### Fixed
- Corrected the commodity-verification OpenAPI annotation so the public API
  specification builds without YAML parser errors.

## [0.22.0.0] - 2026-07-27

### Added
- Added a public, version-labeled documentation site with searchable onboarding,
  seven core workflow guides, and a dedicated API reference at `/docs/api`.
- Added a searchable public catalog generated from the complete feature
  registry.
- Added a Platform marketing page for the Action Center, Living Plan, Money
  Timeline, Family Office, financial provenance, and Safe Operator.

### Changed
- Refreshed planning and business marketing coverage for the household,
  resilience, mobility, cash-conversion, rental, and entity-operation packs.
- Marketing navigation now links directly to documentation and the complete
  feature catalog.
- Public capability statistics now derive from the feature registry.
- Refined self-hosting and GnuCash compatibility claims to distinguish the
  compatible core ledger, web extension tables, and optional external
  connectors.

## [0.21.1.0] - 2026-07-26

### Added
- Added an administrator-triggered, book-scoped BullMQ job that upgrades
  legacy receipt extractions with the configured AI provider and reports live
  progress without overwriting reviewed metadata or reprocessing AI results by
  default.

### Changed
- Account API `fullname` values are now book-relative in flat and hierarchical
  responses, with the book name exposed separately as `book_name`.

### Fixed
- Clearing General Ledger filters now reloads the complete unfiltered result.
- Transaction modals reset their scroll state and open in the current viewport.
- Reconciliation selection, totals, and completion now include every account
  split represented by an aggregated ledger row.
- Command-palette transaction results no longer reuse hits from an earlier
  short query.

## [0.21.0.0] - 2026-07-26

### Added
- Added per-student education and 529 planning with tuition inflation, projected balances, required contributions, state deduction tracking, glide-path guidance, Timeline milestones, and funding actions.
- Added utility usage and unit-rate history with OCR-backed bill suggestions and an actual-rate solar payback scenario.
- Added liability-backed family banking with allowances, chore approvals, deposits, spending, parent savings matches, goals, and a read-only child view.
- Added trip and vacation envelopes with funding targets, current-trip Quick Add tagging, date-range transaction suggestions, live spending, and plan-versus-actual.
- Added vehicle total-cost-of-ownership reporting across Fuel Tracker, mileage, insurance, maintenance, registration, depreciation, and repair-versus-replace scenarios.
- Added Education, Utility, Family, Trip, and Vehicle evidence to the Action Center, Money Timeline, and shared calculation provenance.

## [0.20.0.0] - 2026-07-26

### Added
- Added Rental Portfolio management with properties, units, tenants, leases, escalation and late-fee terms, rent roll, security-deposit liabilities, payment ledgers, tenant statement export, and Schedule E links.
- Added a shared insurance policy and coverage-gap system with inventory and category sub-limit analysis, renewal signals, and a claims ZIP containing home inventory, photos, receipts, and masked policy evidence.
- Added an inflation-aware home capital-replacement forecast and DIME/survivor-cash-flow life insurance needs analysis.
- Added a receipt-backed Personal Price Index with normalized unit prices and live official BLS CPI benchmarks.
- Added a healthcare open-enrollment comparator that replays actual claims across premiums, deductibles, coinsurance, OOP limits, and HSA tax effects.
- Added a mobile mileage log with Schedule C/E/F substantiation and effective-date IRS rates, including the July 2026 mid-year adjustment.
- Added encrypted Fuel Tracker integration with vehicle mapping, paginated incremental fill-up import, source deduplication, transaction matching, manual sync, and nightly worker synchronization.
- Added Rental, Insurance, Capital, Healthcare, and Vehicle events to the Money Timeline and evidence-backed decisions to the Action Center.

## [0.19.0.0] - 2026-07-24

### Added
- Added previewable domain commands and a bounded Safe Operator with explicit approval, durable idempotency, audit history, evidence, and supported undo.
- Added scheduled-transaction editing and create-from-ledger actions through the shared preview workflow.
- Added per-book Stripe Connections, public invoice payment links and payment history, estimate accept/decline, signed webhook posting for payments and processor fees, and payment events in the Timeline and Action Center.
- Added job profitability across invoice revenue, collections, tracked labor, WIP, vendor/linked/tagged costs, gross margin, and operational alerts.
- Added employee receipt reimbursements with approval/rejection previews, automatic draft vouchers, posting-state synchronization, Action Center approvals, and Timeline due dates.
- Added Continuous Close reconciliation coverage, verified-through and stale-account status, session duration/interaction/abandonment telemetry, report drill-through, and close actions.

### Changed
- Ask Your Books now links into the Safe Operator for supported financial actions.
- Public invoice shares act as a lightweight customer portal without exposing authenticated book data.

## [0.18.0.1] - 2026-07-23

### Fixed
- Serialized the complete database initializer with a PostgreSQL advisory lock so concurrently starting app and worker containers cannot race while creating extension tables.

## [0.18.0.0] - 2026-07-23

### Added
- Added the Unified Money Timeline under Money with a shared evidence-backed `FinancialEvent` contract, day/month/year views, expected cash and confidence across eleven event domains, conflict detection, and per-domain iCal filters.
- Added the Living Financial Plan of Record under Planning: adopt Scenario Sandbox models, retain immutable versions, model life events and guardrails, reconcile actuals monthly, explain causes, and keep a decision journal.
- Added Family Office consolidation from the main navigation across the caller's authorized ownership graph, including ownership look-through, net worth/P&L/cash flow/investments/liquidity, explicit cross-currency exclusions, transfer matching, and approved presentation-only eliminations.
- Added family-scoped document/OCR search, Ask Your Books, Action Center, and Money Timeline views.

### Security
- Cross-book graph expansion now intersects every relationship endpoint with the caller's existing per-book permissions; book links never grant access.
- Consolidation never silently combines currencies when a required exchange rate is missing.

## [0.17.0.0] - 2026-07-23

### Added
- Existing books can now receive the complete Schedule F chart through an idempotent, type-aware farm-account graft.
- E-595QF and E-595CF certificates now carry issue, expiry, and return-copy dates in Documents; their obligations appear in the Action Center and compliance calendar/iCal feed.
- The Farm Analyzer now evaluates North Carolina's preceding-year OR three-preceding-year-average qualifying-farmer test from book history.

### Fixed
- Farm Analyzer configuration is now shared per book and protected by atomic singleton upserts and partial unique indexes; account-associated multi-instance tool configs remain supported.
- Farm Analyzer and Schedule F totals now convert foreign transaction values into the book currency at historical posting-date rates and fail clearly when a required rate is missing.
- Farm and S-corp analysis now share one tested household-income annualization and exclusion calculation.

### Changed
- Other singleton tool settings now use race-safe upserts, and startup removes legacy duplicate configuration rows.
- The farm correctness and reliability backlog is marked delivered.

## [0.16.0.0] - 2026-07-23

### Added
- Added the Financial Action Center: one keyboard- and mobile-friendly Fix / Decide / Do inbox fed by transaction review, receipts, statements, Data Health, insights, compliance, business close, failed jobs, and notifications.
- Added eight deterministic “Next Best Dollar” opportunity packs with inspectable value ranges, urgency, confidence, liquidity, reversibility, goal alignment, evidence, and outcome tracking.
- Added Universal Financial Provenance with stable calculation traces, “Explain this number” drill-through, stale-price warnings, per-book verified-through dates, retained decision snapshots, and an exportable evidence manifest.
- Added trace metadata to dashboard KPIs, account balances, estimated-tax results, and cash-flow forecasts.

### Changed
- Action detection is persisted and refreshed on a bounded five-minute cadence, with explicit refresh throttling and atomic, serialized materialization.
- P0 roadmap items are marked delivered and the next roadmap sequence now starts with the Money Timeline and Living Plan.

### Removed
- Removed the incomplete Amazon order-history importer, its dedicated APIs, parser/matching pipeline, database models, and stale product references.

## [0.15.0.1] - 2026-07-22

### Fixed
- SimpleFin syncs now request only what they need: the fetch window starts 7 days before the oldest account's last sync (90 days only for never-synced accounts) instead of always requesting ≥90 days. Keeps the new 2-hourly syncs inside SimpleFin's recommended 45-day range and stops the per-sync "range exceeds recommended" warning seen in the prod worker logs.

## [0.15.0.0] - 2026-07-22

### Added — Live job progress
- **Server work now reports back**: clicking Sync on SimpleFin (and other long-running actions — scrub all lots, index backfill, thumbnail regeneration, price refresh) streams live progress to the browser over SSE. A floating progress card shows per-step status ("Syncing Checking (3/7) — 42 imported so far") and finishes with a toast summarizing the result; the SimpleFin card on the Connections page shows the same progress inline and now populates its results panel even when the sync runs on the background worker.
- Failures surface as error toasts with the actual reason instead of silently landing in the notification bell; a polling fallback covers dropped connections, so a sync's outcome always reaches the page.

### Added — More frequent SimpleFin sync
- **SimpleFin syncs on its own schedule** — every 2 hours by default, configurable from 1 hour to daily in Settings → Schedules — instead of once a day with the evening price refresh. Late-posting bank transactions now land the same day. Scheduled runs are silent (no toasts) and only notify on failure; concurrent syncs of the same connection are guarded against double-importing.

### Fixed
- Notification/job SSE streams no longer leak their Redis subscription and heartbeat when a browser disconnects abruptly.
- "Run now" keeps refreshing prices and syncing SimpleFin together in both deployment modes.

## [0.14.1.0] - 2026-07-22

### Fixed — Tax-advantaged accounts
- **Form 8949 / Capital Gains report no longer includes retirement accounts**: sales inside 401k/IRA/HSA (and accounts mapped 'exclude' in the tax estimator) are now filtered out of the report, the CSV export, the 1099-B reconciliation, and the Year-End Tax Package — matching the Schedule D numbers the tax estimator already computed correctly.
- **Tax-Loss Harvesting no longer offers retirement lots as candidates** (losses inside tax-advantaged accounts aren't deductible). Wash-sale detection still deliberately spans all accounts, since an IRA repurchase can wash a taxable loss.
- **Tax Schedule / TXF export** gains the same sheltered-income guard as the tax estimator: dividends or interest earned inside a retirement account that credit a shared income account no longer appear on the schedule.

### Fixed — Compliance calendar
- **Deadlines now roll to the next business day** the way the IRS actually schedules them (IRC §7503): weekend and federal-holiday due dates move forward, including observed holidays and the DC Emancipation Day quirk (e.g. Sat Apr 15, 2028 correctly becomes Tue Apr 18). Previously the calendar only added a note while keeping the weekend date.

## [0.14.0.0] - 2026-07-22

### Added — Farm & Apiary
- **Farm & Apiary Analyzer** (/tools/farm-analyzer): decide whether to formalize a home farm — compares four ways of handling farm income side by side: unreported cash (shown for honesty, clearly flagged as not legal and never recommended), hobby reporting, Schedule F sole proprietorship, and Schedule F + NC LLC. Pulls your actual income and expenses from farm account subtrees you pick in your book, annualizes them, and models self-employment tax, QBI, §179 equipment expensing (with the wage-inclusive business-income limit), the NC qualifying-farmer sales-tax exemption ($10k threshold, conditional E-595CF path with clawback warnings), present-use value property-tax hints, and LLC formation/annual-report fees. The headline insight: a single-member LLC changes nothing about taxes — it buys liability protection for $125 + $200/yr.
- **Farm business activity**: label a sole proprietorship or LLC book as a "Farm or ranch" (Settings → entity profile, or at book creation). Farm-labeled books get a Schedule F-aligned chart of accounts (Honey Sales, Pollination Services, Feed & Syrup, Mite Treatments, Jars & Packaging, hives and equipment assets) instead of the generic business template.
- **Schedule F report** (/business/reports/schedule-f): farm income and expenses mapped onto IRS Schedule F lines with an apiary-aware keyword mapper (feed→16, treatments→31, jars→28, fuel→19…) and a per-account manual override panel. On a household book it scopes itself to the farm accounts selected in the analyzer.
- **Farm compliance deadlines**: farm-labeled books add the farmer estimated-tax options (March 1 file-and-pay, single Jan 15 payment) plus NC present-use value listing period and E-595QF certificate upkeep to the compliance calendar, reminders, and iCal feed.

### Fixed
- Business decision tools (S-Corp Analyzer and the new Farm Analyzer) no longer aggregate a linked household book's income for users who only have access to the business book.
- Schedule C/F mapping storage retries table creation after a transient database failure instead of failing until restart, and Schedule F mapping batches now save atomically.

### Changed
- The entity profile gains a business-activity field ('general' or 'farm') — additive column, no migration needed on existing books.

### Added — Home Inventory
- **Photos-first walk-through mode**: a "Photos only" / "Detail each" toggle in the room-by-room stepper (choice persists per browser). In photos-only mode you snap photos for each item (item + serial label group into one) and save it as an un-named draft — no typing — then move room to room. The recap flags how many items still need details.
- **Bulk detailing on the desktop**: the inventory page shows a "N items captured without details" banner that opens a room-grouped list of every draft, each with its photos beside inline fields (name, category, value, purchased, warranty, serial, room). "Save & file" names the item and drops it from the list; the count updates live.

### Changed
- A home inventory item can now be created without a name (a "draft"); the existing detail-as-you-go flow is unchanged. New `GET /api/home/items?draft=1` returns the un-detailed work list, and the home summary reports a `draftItems` count. No database migration required — a draft is simply an item with a blank name.

## [0.13.1.0] - 2026-07-17

### Added — Home Inventory
- **Multiple photos per item**: home inventory items now hold a photo gallery instead of a single image — capture the item plus its serial-number label in one pass. New `gnucash_web_home_item_photos` table (one row per photo, FK-cascade to the item) with a one-time backfill of the legacy single photo; new `POST /api/home/items/[id]/photos` and `GET`/`DELETE /api/home/items/[id]/photos/[photoId]` endpoints. The walk-through and room detail forms accept multiple files; the room detail view shows a per-item gallery with per-photo removal and a count badge on the list thumbnail.
- **Walk-through back navigation**: the room-by-room capture stepper gains a "← Previous room" button next to "Next room", so you can move in both directions (flushing any pending item entry before stepping).

### Changed
- Book deletion now cleans up per-photo storage files and rows via the new photos table.

## [0.13.0.0] - 2026-07-12

### Changed — Unification
- **Task-oriented navigation**: the sidebar regroups by life domain — Home, Money, Budgets & Goals, Investments, Taxes, Planning, Reports, Business, Settings — driven by a new single-source feature registry
- **Domain hubs**: /money, /taxes, and /planning are curated landing pages with stats and task-grouped feature cards, replacing the flat Tools/Reports card walls as entry points
- **Command palette upgrades**: entries derive from the registry, descriptions are searchable ("raise cash" finds the Sell Planner), recently used commands lead when opened, and a visible Search button in the sidebar opens it for mouse users
- **Feature Catalog** (/catalog): the searchable everything-directory with star pinning — pinned features appear in a Pinned sidebar group
- **Related links**: cross-link strips on key pages (8949 ↔ Sell Planner, budgets → Budget Income Statement, FIRE → Drawdown/Scenario, digest → Year in Review, holdings → rebalancing/lots)

### Added
- **iCal calendar feeds**: subscribe Google/Apple Calendar to tokenized feeds of upcoming scheduled transactions, bond maturities/coupons, and RMD deadlines
- **Price alerts**: per-commodity above/below thresholds checked after each daily price refresh, delivered through notifications/email/webhooks
- **Email-in ingestion**: forward receipts, statements, or payslips to an IMAP mailbox (INGEST_IMAP_*); the worker polls every 15 minutes with a sender allowlist and Message-ID dedupe, feeding the existing extraction pipelines
- **Accountant share links**: admin-created, time-boxed public URLs rendering a self-contained read-only report document — no app access, secret shown once, view counting
- **Time Machine** (/tools/time-machine): the whole book as of any date, with historical security prices and a two-date compare mode
- **Document Search** (/search): one query across receipt OCR text, statement lines, payslips, and transactions with highlighted snippets
- **FX Revaluation report**: foreign-currency holdings with average acquisition rates and unrealized/realized FX gains
- **Spending vs National Averages**: your categories against approximate BLS Consumer Expenditure Survey figures for your household size

## [0.12.0.0] - 2026-07-12

### Added
- **Sell Planner**: raise a target amount of cash tax-optimally — losses harvested first with wash-sale screening (incl. IRA buys per Rev. Rul. 2008-5), long-term gains by gain-per-dollar, partial final lots landing exactly on target, incremental federal+state tax via the real engine, and side-by-side savings vs naive FIFO and long-term-only plans
- **Net-Worth Attribution**: any period's change decomposed into savings, market gains, debt paydown, and an honest residual — cents-exact by construction — with waterfall summary, monthly stacked chart, and drill-downs
- **Year in Review**: the annual wrapped — net worth arc, savings rate, top categories with YoY deltas, dividends, best/worst holding, taxes paid, subscription changes, streaks
- **Scenario Sandbox**: one what-if (e.g. the Buy-a-House template) threaded through cash flow, 30-year net worth, current+next-year taxes (itemize-vs-standard decided), and FIRE date, side by side with baseline
- **Report Schedules**: email any saved report weekly/monthly/quarterly (HTML + CSV, idempotent per period), checked daily by the worker; plus global print stylesheets for clean PDFs from any page
- **API tokens & webhooks**: hashed personal access tokens (Bearer gcw_…) with live role capping, and HMAC-signed outbound webhooks on notifications with SSRF guards — docs in docs/api-tokens.md
- **Opt-in TOTP two-factor auth**: RFC 6238 with encrypted secrets and single-use recovery codes; strictly opt-in — nothing changes for un-enrolled users, OIDC untouched
- **In Case of Emergency**: per-account beneficiary/institution/contact metadata assembled into a printable, grouped account map with book-level instructions
- **Fixed Income ladder**: bonds/CDs/treasuries with Newton-solved YTM, per-year maturity ladder, weighted averages, 12-month maturity calendar, and coupon estimates
- **AI additions**: natural-language quick-add ("$40 gas yesterday" → prefilled entry), a factual narrative paragraph atop the monthly digest, and daily proactive insight cards (category spikes, first-time merchants, savings-rate drops, net-worth milestones, cash drops) on the dashboard

## [0.11.0.0] - 2026-07-12

Closes every "worth building" gap from the GnuCash desktop parity audit
(docs/gnucash-desktop-parity-2026-07.md).

### Added
- **Tax Schedule Report + TXF export**: tax-relevant accounts grouped by TXF code and IRS form (1040, Schedules A–E) with per-account drill-down, a per-account TXF override mapper, and a downloadable TXF V042 file for TurboTax/TaxCut import
- **Budget Income Statement**: budget-vs-actual P&L over any period range with favorable/unfavorable variances, % of budget, rollup subtotals, per-period barchart, and CSV export; **Budget Balance Sheet**: projected end-of-period balances (opening + budgeted flows) with an actual-basis comparison column
- **Close Book**: year-end closing entries that zero income/expense into a chosen equity account (per currency, cumulative-through-date so re-closing is safe), fully previewed and undoable via History
- **Account Breakdown**: one parameterized pie/bar report replacing desktop's eight account chart reports — type tabs, depth 1–4, click-to-drill with breadcrumbs, Other bucket
- **Price History** chart for any commodity's stored quotes with source badges; **Income & Expenses by Day of Week**; **Average Balance** (monthly average/min/max/ending daily balances)
- **Customer Summary**: per-customer sales, expenses, profit, and markup %
- **Jobs**: management UI (owner, desktop-compatible rate slot, deactivate) with per-job invoice rollup report
- **Employees & expense vouchers**: employee CRUD plus vouchers posted through the native invoice engine (A/P credit, expense debits, gncExpVoucher numbering) with reimbursement via the standard payment path and an Employee Report
- **Manual reconcile window**: reconcile any account against a statement ending balance — tick splits, exact integer-cents difference, server-verified tie-out before marking splits reconciled
- **QIF import**: Quicken files (bank/cash/card/asset/liability, multi-account, splits, categories) with transfer pairing, duplicate detection, category mapping overrides, and a preview-first flow

## [0.10.0.0] - 2026-07-12

### Added
- **Command palette (Ctrl+K)**: fuzzy search across actions (new transaction, switch book/account, help), every page, all reports, tools, and business pages, plus live account matches and transaction search with amount/date context
- **Ask Your Books**: chat at /tools/ask answers plain-English questions ("how much did we spend on restaurants in Q1?") via guard-railed, read-only SQL generated by the configured AI provider — single-SELECT-only validation, mandatory book scoping, LIMIT caps, 5s statement timeout, collapsible SQL, result tables, and drill-down links
- **Drawdown & Roth Conversion Planner**: year-by-year retirement spend-down at /tools/drawdown — withdrawal sequencing, SECURE 2.0 RMDs (Uniform Lifetime Table), bracket-filling Roth conversions solved exactly to the bracket top, annual federal+state tax via the tax engine, IRMAA tier warnings, depletion detection, conversions on/off comparison, and book-prefilled balances + Social Security
- **Equity compensation (RSU/ESPP)**: post vest events (FMV basis on net shares, gross value as W-2 income, sell-to-cover withholding) and ESPP purchases (FMV basis with the discount as ordinary income) as balanced GnuCash transactions with live split preview and history — the 8949 double-taxation trap avoided by construction
- **Schedule E (rental property)**: per-property income/expense rollups mapped to Schedule E lines with manual overrides, straight-line depreciation (27.5/39-year, mid-month convention), combined summary, and a property manager — works on household books
- **Year-End Tax Package**: one ZIP from /reports/tax-package with Form 8949 + Schedule D CSVs, contribution summary with IRS limit usage, Schedule C (when applicable), a new charitable-giving (Schedule A) detail report with $250+ acknowledgment flags, withholding snapshot, and a README manifest
- **Email notifications**: any notification (monthly digest, budget overspend, anomalies, low balances, reorders, bank-sync status) can be emailed via SMTP_* env config, with per-user opt-in, minimum severity, and per-type filters in Settings
- **Nightly book backups**: every book exported to desktop-compatible compressed GnuCash XML at 02:30 UTC through the storage backend (filesystem/S3) with retention (BACKUP_RETENTION, default 30), plus Settings list/download/delete and Run-now
- **Change history with undo**: full before/after snapshots on transaction mutations enable Restore (deleted), Revert (updated), and Delete (created) from Settings > History; audit coverage extended to accounts; every undo is itself audited
- **Bulk transaction editing**: ledger edit mode gains Edit description (set or find-and-replace), Recategorize (safe counter-split selection with per-row skip reasons), and bulk Tags
- **Retroactive categorization rules**: per-rule "Apply to history" with dry-run preview, date range, only-uncategorized (Imbalance/Orphan) toggle, and 500-per-batch application
- **Quick Add (mobile/offline)**: thumb-first capture at /quick-add with keypad entry, recent categories, and an IndexedDB offline queue that syncs idempotently on reconnect; PWA shortcut included

### Fixed
- **Realized gain/loss rows in the investment ledger rendered blank**: lot-close gains transactions (zero-share, income-offset) now classify as their own type, showing the signed gain in the Buy/Sell columns and on mobile cards with a Realized G/L badge; return-of-capital detection tightened to the GnuCash shape
- Audited the legacy lot-scrub sell-splitting sign corruption: prod is clean; dev retains 598 corrupted sub-splits with a ready repair script (`scripts/fix-lot-scrub-sign-corruption.ts`)

## [0.9.4.0] - 2026-07-11

### Fixed
- **Account performance chart now includes closed positions and cash**: the per-account chart resolved its accounts from *current* holdings, so any position since sold to zero (e.g. a fund liquidated in a 401k provider switch) had its entire history dropped — the pre-switch balance read far too low. The chart now resolves the selected account's full subtree server-side (every holding ever held under it, including closed ones) plus its cash balance, so historical value is complete and the line stays continuous through a rebalance (previously it cratered to ~$0 and broke TWR to −100%). Internal sell→cash→buy transfers net out of the return math, and the Account View "Total Value" includes cash to match.

## [0.9.3.0] - 2026-07-11

### Fixed
- **Account paths never include the root account**: the investments cash/portfolio views built paths from the book's top-level root account (e.g. `Root Account:Assets:…`); paths now start at the first real account, matching the rest of the app. Works regardless of the root's name.

### Data (prod + dev, not shipped in the image)
- **John Hancock "Industrial Insight 401k"**: its holdings were recorded under real tickers (VT, FSMDX) but priced in John Hancock *units* that differ from the market, which inflated the historical 401k balance (VT was ~4.8× overstated). Split these into separate JH-specific commodities (`JOHNHANCOCK` namespace) with market quoting disabled, and backfilled a daily price series = buy-derived ratio × the ticker's real market price. The real VT/FSMDX tickers are preserved for future use. Migration: `scripts/jh-401k-separate.mjs`.

## [0.9.2.0] - 2026-07-11

### Added
- **Cryptocurrency support**: crypto commodities are now handled as a distinct `CRYPTO` type/namespace (moved out of the misused `EUREX` namespace) with daily price quotes from Yahoo Finance via `{SYMBOL}-USD` pairs. Full historical prices backfilled from each holding's first transaction; ongoing daily refresh and the scheduled price job now include crypto automatically. Crypto is tagged sector "Crypto" for sector-exposure and rebalancing, `CRYPTO` is an offered commodity type in the editor, and symbol verification maps crypto to its Yahoo pair (so crypto rows verify correctly).

### Fixed
- **Price precision**: stored price quotes now use 1e8 resolution instead of the currency's 1/100 fraction, so sub-cent assets (e.g. SiaCoin, IOST) no longer round to $0.00.
- **Settings**: the top four settings cards (Commodity Quotes, IRS Limits, Categorization Rules, household Inventory) now collapse like the rest of the page.

## [0.9.1.0] - 2026-07-10

### Added
- **Inventory**: receive stock against posted vendor bills (unit costs from the bill lines, no double-posting), reorder points with automatic low-stock alerts (after bank sync and on demand), per-item **FIFO valuation** option with layer-based COGS, a Stock Valuation report, and a **setting to enable inventory on household books** (standalone Inventory nav item)
- **Recurring invoices**: define from any invoice or bill ("Make recurring..."), cadence with month-end anchoring, optional auto-post, runs automatically after bank sync plus Run-now, atomic claim-first generation (no duplicates), notifications per generated document
- **Customer statements**: printable per-customer statement with opening/closing balance, chronological activity, running balance, and an aging footer
- **Statements**: OFX account auto-detection (ACCTID) with a per-book learned account map — re-uploads skip the account picker; assign-account flow for unmapped files; create a categorization rule directly from a reconcile missing line
- **Dashboard**: sparkline and bar chart custom widgets (monthly balance or spend series) and per-book dashboard layouts
## [0.9.0.0] - 2026-07-10

### Added
- **Inventory management** (business books): items/SKUs with book-wide moving-average-cost valuation, stock locations, receive/ship/adjust/transfer/return movements with negative-stock protection, bills of materials with assembly costing, optional balanced GnuCash ledger postings (inventory asset + COGS), and explicit invoice-line fulfillment that links sales to items and posts cost of goods sold — plus a full UI (items, item detail with stock by location and movement history, BOM editor and assemble, locations, invoice Fulfillment section)
- **Composable dashboard**: a searchable widget gallery to add/remove widgets (goals, budget pacing, AR/AP, dividends, subscriptions, data health, plus all existing charts), business-only widgets gated by entity type, and a custom widget builder — define stat widgets from the UI over account balances or trailing spend, evaluated book-scoped on the server
- **Sector-based rebalancing**: allocate by sector in addition to symbol, with fund exposure spread via sector weights, sector targets mapped back to per-symbol trades, and a sector-data backfill for holdings missing metadata
- **Three new reports**: Budget Report (budgeted vs actual per account with subtotals), Sales by Customer, and Expenses by Vendor (new Business Reports category)
- Dividends: TTM tooltips ("trailing twelve months") and per-security links to account ledgers

### Changed
- **Budgets overview** overhauled: sortable and filterable table with status pills (Active/Past/No amounts), resilient per-row progress, per-row action menus (scenario/compare for any budget), and a proper mobile card layout
- **KPI/stat cards are dramatically more compact on mobile** (shared StatCard/StatGrid across 12 pages, ~75% less vertical space on phones; desktop unchanged)
- Navigation: Receipts, Payslips, and Statements folded into one Uploads group; Inventory added to the Business group
## [0.8.0.0] - 2026-07-09

### Added
- **Statement Import & Reconcile**: upload a bank or credit-card statement (PDF, CSV, or OFX/QFX), parse it (deterministic CSV/OFX parsers, or the AI extraction core for PDF), and reconcile it against the ledger. The workspace auto-matches statement lines to existing transactions, lists transactions that are on the statement but missing from the ledger (each with a suggested category to review before adding) and ledger entries not on the statement, and enforces a balance tie-out to the statement's closing balance before finalizing a full GnuCash reconciliation (matched + newly-added splits marked reconciled). Available on any book — household or business.

### Fixed
- Sidebar: **Invoices** and **Bills** now highlight independently (they share a path and differ only by query string); the Business nav group also auto-expands on business routes
## [0.7.1.0] - 2026-07-09

### Added
- **Schedule C account mapper**: a dense mapping panel on the Schedule C report (mirroring the tax estimator's mapper) to manually assign expense accounts to Schedule C lines; manual overrides win over the keyword heuristic and the report re-totals live on save
- **Keyboard shortcut nav chords**: g u (Budgets), g o (Goals), g t (Tags), g w (Tools), g s (Settings)

### Changed
- **Keyboard shortcuts modal** is now a dense 2-3 column grid and is page-aware: shortcuts contributed by the current page group under a "This Page" heading shown first, and disappear when you navigate away
- **Entity settings section** adapts its labels to the entity type (Household / Business / Organization) instead of always reading "Household & entity"

### Fixed
- Switching a book's entity type to a business or nonprofit now reveals the Business navigation group immediately, without a page refresh
## [0.7.0.0] - 2026-07-08

### Added — Business (AR/AP, shown only for business-entity books)
- **Customers, vendors, jobs, bill terms, and tax tables**: full CRUD over the native GnuCash business tables with auto-numbering, deactivate-not-delete referential safety, and management pages under /business
- **Invoice & bill engine**: GnuCash-desktop-compatible posting (real transaction + A/R-A/P lot + gncInvoice slot frames + book counters), GnuCash's own discount/tax semantics (PRETAX/SAMETIME/POSTTAX, tax-included), unposting, and payments with FIFO or explicit allocation that close lots on full payment
- **Invoice & bill UI**: filterable list, draft line-item editor with live totals, post/unpost, payment modal with per-invoice allocation, payment center, and a clean printable document
- **Business reports**: AR/AP aging (current/30/60/90+ per owner), sales tax collected with monthly filing summary, Schedule C estimate for sole proprietors, and a business dashboard (revenue, outstanding AR, AP due, top customers, avg days-to-pay)
- **Business navigation group** in the sidebar, gated on the book's entity type — household books never see it

### Added — Budgets
- **Budget vs Actual**: per-account progress with pace marker, projected end-of-period overspend (on-track/warning/over), period stepping via [ ] keys, YoY comparison, and compact progress bars on the budget list
- **Envelope/rollover budgeting**: unspent amounts carry forward (deficits too), sinking funds, per-line settings for rollover/threshold/goal link
- **Overspend alerts**: threshold/over/projected alerts through the notification stream, scanned automatically after bank sync and on demand
- **Goal-linked budget lines**: link a budget category to a financial goal, with inline goal progress
- **Auto-budget wizard**: generate a budget from trailing history (median or mean), 50/30/20-style percent-of-income or zero-based templates, editable preview before creation
- **Budget scenarios**: duplicate any budget scaled by a factor (lean/stretch) and compare two budgets side by side
## [0.6.0.0] - 2026-07-08

### Added
- **Capital Gains — Form 8949 / Schedule D**: realized stock/fund sales bucketed into IRS 8949 boxes with Schedule D totals, wash-sale adjustments, CSV export in IRS column order, and 1099-B reconciliation (paste/upload broker rows to confirm basis). Flags rows whose implied per-share price is wildly inconsistent with the same security's other sales, so a corrupt underlying transaction can't silently produce a wrong number on the form.
- **Spending Watch (anomaly & fraud alerts)**: detects duplicate charges, first-time merchants, amount outliers, and category spikes; runs automatically on each SimpleFIN sync and delivers deduplicated alerts through the notification stream, plus an on-demand review page
- **Financial Goals tracker**: emergency-fund (N months of expenses), savings-target, and debt-payoff goals with completion dates projected through the cash-flow forecast and debt engines, on-track/behind badges, and a per-goal "$X/mo to hit your date" hint
- **Monthly Digest**: a month-at-a-glance summary (net-worth change, cash flow, top categories with month-over-month deltas, subscription changes, upcoming bills, budget status) viewable in-app and deliverable to notifications
- **Investment Benchmark comparison**: portfolio time-weighted return vs S&P 500 / Dow / NASDAQ / Russell 2000 over 1Y/3Y/5Y/YTD/max, with a growth-of-100 chart and a one-click index-price backfill when coverage is missing
- **Dividend Income tracking & calendar**: trailing-12-month and per-year totals, yield-on-cost and current yield per holding, a monthly income chart, and a forward payment calendar that projects active payers from trailing income (stopped securities excluded)
- **Data Health dashboard**: checks for unbalanced transactions, structural corruption, missing/stale prices, quote-flag drift, and unreconciled aging, rolled into a 0-100 health score with fix links
- **Withholding Checkup**: projects year-end federal tax from year-to-date data, flags under-withholding, and computes the safe-harbor target with the remaining quarterly 1040-ES estimate and a recommended per-paycheck adjustment

### Fixed
- Dividend forward projection tracked a security's single most-recent payment (overshooting trailing income ~3x) and projected securities that stopped paying years ago; it now anchors to trailing-12-month income and excludes inactive payers

## [0.5.0.0] - 2026-07-08

### Added
- **Cash Flow Forecast tool**: projects cash account balances 30/60/90/180 days forward from scheduled-transaction occurrences plus a 90-day historical daily run rate, with per-account chart lines, a warning threshold, low-balance alerts, and an upcoming-events table
- **Subscription detection tool**: finds recurring charges (weekly/monthly/quarterly/annual) from spending history with merchant normalization, price-increase tracking, stopped/new status, and monthly/annualized cost totals
- **Debt Payoff Planner**: snowball vs avalanche vs minimum-only comparison across all liability accounts with freed-minimum rollover, mortgage APR/payment prefill from saved mortgage configs, balance-over-time chart, per-debt payoff dates, and payment-too-low warnings
- **Portfolio Rebalancing**: per-symbol target allocations with drift bars and an absolute tolerance band, threshold rebalancing (only out-of-band holdings are traded), buy-only cash-flow mode for new money, and tax-aware sell ordering (losses first, then long-term gains) annotated from lot data
- **Auto-categorization rules engine**: user-defined contains/exact/regex rules checked ahead of the history-based guess during SimpleFIN sync (rule hits import as high confidence), with a Settings → Rules page offering learned suggestions from transaction history, one-click rule creation, and a description test box

### Fixed
- Imbalance-routed SimpleFIN imports are now stored with low confidence (previously mis-stored as medium)
- Credit-card accounts no longer flood the cash-flow-forecast low-balance warnings; the combined net-cash warning is preserved
- Debt payoff chart windows to the longest completed plan instead of stretching to the 100-year simulation cap when minimums never pay off
- `fetchScheduledTransactions` moved from the scheduled-transactions route into `src/lib/scheduled-transactions.ts`, fixing production builds after a dev session

## [0.4.0.0] - 2026-06-12

### Added
- **Monte Carlo FIRE Calculator**: seeded bootstrap simulation over the Damodaran 1928–2024 stock/bond/CPI dataset with 10/25/50/75/90 confidence bands, FI-age distribution, retirement-age success sensitivity, and a full assumptions panel (allocation + glide path, inflation mode, withdrawal strategy, retirement tax, healthcare bump, contribution growth, end age, simulation count)
- **Social Security estimation from book data**: SSA benefit formula (AWI indexing, top-35 years, AIME → PIA bend points, claiming ages 62–70) computed from W-2-mapped or salary-account earnings history, feeding the FIRE calculator as a data-driven default with override
- **Tax Estimator tool**: federal liability for 2024–2026 (brackets, standard/itemized with OBBBA SALT cap and senior deduction, LTCG/QDI stacking, SE tax, NIIT, Additional Medicare, safe-harbor 1040-ES schedule), pluggable state modules (no-tax, flat, CA/NY, flat-rate fallback), account→tax-category mapper with auto-suggestions, and side-by-side contribution scenarios validated against IRS limits
- **Account & transaction tagging**: global tags with colors, tag chips in ledgers and the account tree, context-menu tag editor, `/tags` management page, and `#tag` search syntax in the general ledger and account ledgers (account tags propagate to their transactions)
- **Optional OIDC login (Pocket ID or any OIDC provider)**: env-configured (`OIDC_ISSUER`/`OIDC_CLIENT_ID`/`OIDC_CLIENT_SECRET`/`OIDC_PROVIDER_NAME`), PKCE S256, verified-email auto-link migrates existing manual accounts, explicit link/unlink in profile, OIDC-only users can set a password later
- **Granular roles**: readonly/edit/admin enforced on every mutating API route, per-book role management UI in Settings → Users with last-admin protection, read-only UX gating on ledgers, accounts, scheduled transactions, and tags

### Fixed
- Ledger deep links with a seeded search (e.g. `/ledger?search=%23tag`) now apply the filter on first load

## [0.3.0.0] - 2026-04-08

### Added
- **Amazon Order Import**: Upload Amazon order history (CSV or ZIP from "Request My Data" export) and match orders to existing credit card transactions with item-level splits
- Amazon CSV parser with ZIP extraction, supporting "Request My Data" and "Order History Reports" formats
- Order matching engine scores transactions by amount and date proximity
- Split generator with rounding absorber for balanced GnuCash transactions
- Category mapper with learned suggestions from prior imports
- Batch-based import flow: upload, review matches, confirm, and apply
- Searchable account picker (reuses existing AccountSelector) for credit card, tax, and shipping account selection
- Collapsible download instructions with direct links to Chrome extensions (Order History Reporter, Order Exporter, OrderPro) for instant export
- Amazon Import card on Tools hub page
- Database tables for import batches, Amazon orders, and category mappings
- 287 tests covering CSV parsing, matching, split generation, category mapping, and service layer

## [0.2.3.0] - 2026-03-28

### Added
- **Execute/skip scheduled transactions**: execute upcoming occurrences from the web UI, creating real GnuCash transactions from templates with proper GUID generation and fraction-based amounts. Skip advances metadata without creating a transaction.
- **"Since Last Run" batch mode**: contextual amber banner in the Upcoming view shows overdue count with a "Process All" button that batch-executes all overdue occurrences
- **Enable/disable toggle**: interactive toggle switch on each scheduled transaction row replaces the static enabled/disabled badge. Optimistic UI with rollback on failure.
- **Create new scheduled transactions**: slide-over panel with name, recurrence pattern (all 9 GnuCash period types), start/end dates, multi-split account picker, auto-create/notify options. Creates full GnuCash template structure (root account, child accounts, slot mappings, template transaction/splits, schedxaction, recurrence)
- **Mortgage dynamic amounts**: `MortgageService.computePaymentForDate()` provides a reusable principal/interest split calculation from current balance and detected rate; it is not yet wired to scheduled-transaction posting
- **Account editing modal**: notes, tax_related, retirement flags, reparenting support in account service
- Concurrency protection prevents double-execution when processing scheduled transactions from multiple tabs
- 18 new tests covering execute/skip, create, and mortgage payment computation

### Fixed
- Batch execute sent wrong field name (`scheduledTransactionGuid` instead of `guid`), causing "Process All" to always fail

## [0.2.2.0] - 2026-03-28

### Added
- **Contribution Summary report**: surfaces total contributions to retirement and brokerage accounts with per-account breakdowns, IRS contribution limit tracking with progress bars, and configurable grouping by calendar year or tax year
- **Contribution classification engine**: automatically categorizes deposits as contributions, employer match, rollovers/transfers, dividends, or fees based on the source account type, with hierarchy-aware retirement flag inheritance
- **IRS contribution limits service**: hardcoded defaults for 2024-2026 (401k, IRA, Roth IRA, HSA, 403b, 457) with user-editable overrides via database table, catch-up contribution support using birth date from user profile
- **Retirement account toggle**: investment accounts (STOCK, MUTUAL, ASSET, BANK) can be flagged as retirement accounts with a type selector (401k, IRA, Roth IRA, HSA, etc.) in the account detail page
- **Tax-year attribution**: per-transaction tax year overrides for prior-year contributions, with inline editing in the report and a backfill script for historical data
- **Tax-year backfill script** (`scripts/backfill-tax-year.ts`): parses transaction descriptions for year indicators and sets tax-year overrides for historical prior-year contributions
- API endpoints: `GET/PUT /api/contribution-limits`, `PUT/DELETE /api/contributions/[splitGuid]/tax-year`, `GET /api/reports/contribution-summary`
- 36 new tests (IRS limits: 12, contribution classifier: 13, report generator: 11)

### Fixed
- Floating-point drift in financial summation replaced with integer-cent accumulation
- Birthday read server-side to avoid PII in query parameters
- Account preferences COALESCE pattern replaced with CASE WHEN to allow clearing retirement_account_type to null
- Contribution limits PUT endpoint now validates account type, numeric ranges
- Tax-year override route now checks book scope (isAccountInActiveBook)
- Retirement account query scoped to active book, O(n) array lookup replaced with Set

## [0.2.1.0] - 2026-03-27

### Added
- SimpleFin reconciliation matching: automatically links bank-imported transactions to existing manually-entered ones based on amount, date proximity, and description similarity
- Transfer dedup matching: detects when the same transfer is imported from both sides (e.g., checking → savings) and links them instead of creating duplicates
- "Bank-verified" badge on reconciled transactions in the account ledger
- Match count display in sync results (reconciled + deduplicated)
- Schema migration: `match_type`, `match_confidence`, `matched_at`, `simplefin_transaction_id_2` columns on transaction meta

### Changed
- Project description updated from "read-only" to reflect current read-write capabilities

### Fixed
- Currency precision: matching now uses account's `commodity_scu` instead of hardcoded precision=2, supporting JPY, KWD, and other non-standard currencies
- Transfer dedup restricted to 2-split transactions only, preventing incorrect split selection on multi-split transactions
- Match writes wrapped in database transactions for atomicity
- Removed split mutation from transfer dedup (no longer rewrites `splits.account_guid`)

## [0.2.0.0] - 2026-03-22

### Added
- Receipt attachment and management system with upload, view, search, and OCR
- Drag-and-drop and mobile camera capture for receipt uploads
- Receipt gallery page (`/receipts`) with thumbnail grid, search, and filters
- Paperclip receipt indicator on transaction rows in ledger views
- Combined view/upload receipt modal with multi-receipt carousel
- Storage backend abstraction supporting filesystem (default) and S3/MinIO
- Thumbnail generation via sharp for uploaded images and PDF placeholder
- BullMQ OCR job with Tesseract auto-detection (system binary or WASM fallback)
- API endpoints: upload, serve, delete, link/unlink, list/search, thumbnails
- Receipt counts in transaction and account ledger queries
- Tesseract OCR in Docker image for production receipt text extraction
- Swap button to reverse From/To accounts in transaction form
- Mobile date input with native calendar picker and +/- buttons

### Fixed
- Swap button arrow orientation for mobile/desktop layouts
- FIFO/LIFO/Average dropdown styling alignment with investment page selects
- AutoAssignDialog rendering via portal to escape overflow-clip container

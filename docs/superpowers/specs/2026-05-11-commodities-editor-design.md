# Commodities Editor Design

**Date:** 2026-05-11
**Status:** Approved (pending user review)

## Problem

The current commodity settings page ([settings/commodities/page.tsx](../../../src/app/(main)/settings/commodities/page.tsx)) only allows editing three quote-related fields (`quote_flag`, `quote_source`, `quote_tz`) one row at a time. Users cannot:

- Add new commodities
- Edit the `fraction` (decimal precision) — directly tied to the recently-fixed FSMDX 6-vs-4-decimal bug, where new commodities defaulted to a fraction the user could not adjust
- Edit identifying fields (`namespace`, `mnemonic`, `fullname`, `cusip`)
- Save several edits in a single action

Manual symbol entry also risks creating commodities that don't exist on Yahoo Finance, which silently breaks price refresh.

## Solution

Convert the settings page into a fully editable bulk table with a **Save All** action, plus a reusable modal editor for create-new and per-row focused edits. Every editable mnemonic is verified against Yahoo Finance; unverified symbols trigger a confirmation prompt before save.

## Backend

### `PATCH /api/commodities`

Extend the request schema to accept every commodity field. Existing callers (per-row quote-flag toggle) keep working since fields stay optional.

Request body:
```ts
{
  guid: string;            // required
  namespace?: string;
  mnemonic?: string;
  fullname?: string | null;
  cusip?: string | null;
  fraction?: number;       // must be >= 1
  quote_flag?: boolean;
  quote_source?: string | null;
  quote_tz?: string | null;
}
```

Validation: `fraction` must be a positive integer; `namespace` and `mnemonic` non-empty if provided.

### `POST /api/commodities`

Create a new commodity. Required fields: `namespace`, `mnemonic`, `fraction`. Generates a GUID server-side. Returns the created row.

Conflict handling: `(namespace, mnemonic)` is the natural key — return 409 if a commodity with that pair already exists.

### `GET /api/commodities/verify-symbol?symbol=X&namespace=Y`

Calls `yahooFinance.quote(symbol)`. Returns:
```ts
{
  exists: boolean;
  fullname?: string;       // populated from quote.longName or shortName when exists
}
```

If `namespace === 'CURRENCY'`, returns `{ exists: true }` without contacting Yahoo (currencies aren't verifiable as symbols). Verification failures (network, rate limit) return `{ exists: false }` with a 200 — the UI treats this the same as "unverified" and shows the confirmation prompt.

## Frontend — Bulk Table Editor

Every column becomes editable in-cell:

| Column | Control |
|---|---|
| Namespace | `<select>` with options `CURRENCY`, `STOCK`, `MUTUAL`, `FUND`, `ETF`, `BOND`, `OTHER` |
| Symbol (mnemonic) | text input with Yahoo verify indicator (✅/⚠️) appearing on blur |
| Full Name | text input |
| CUSIP | text input |
| Fraction | numeric input (`min=1`, `step=1`) |
| Quote Flag | checkbox (unchanged) |
| Quote Source | text input (unchanged) |
| Quote TZ | text input (unchanged) |

Header actions (above the table):
- **+ Add Commodity** button → opens modal in create mode
- **Save All** button — disabled when no rows are dirty; shows "Save N changes"
- **Discard All** button — disabled when no rows are dirty; reverts all edits to last loaded state

Per-row actions stay minimal: an **Edit (pencil)** icon button that opens the modal in edit mode for that row. The per-row Save button is removed (Save All replaces it).

### Save All flow

1. Collect dirty rows.
2. Collect all dirty mnemonics whose row's namespace ≠ CURRENCY. Verify each against `/api/commodities/verify-symbol` in parallel.
3. If any return `exists: false`: show a single confirmation dialog listing them ("FOO, BAR not found on Yahoo Finance — save all anyway?"). On cancel, abort the save.
4. On confirm (or no unverified): issue PATCH requests in parallel. Display per-row error toasts on failure; keep failed rows dirty so the user can retry.
5. On success, refresh the rows with the server response, clearing dirty flags.

## Frontend — Modal Editor

A single reusable modal component used for both create and edit modes.

Fields: namespace (dropdown), mnemonic (text + verify indicator), fullname (text), cusip (text), fraction (numeric), quote_flag (checkbox), quote_source (text), quote_tz (text).

### Behavior

- **Open** via:
  - "+ Add Commodity" button → create mode (empty form)
  - Per-row pencil icon → edit mode (pre-filled)
  - **Alt+N** keyboard shortcut → create mode (page-scoped listener)
- **Close** via:
  - X button
  - Click outside
  - **Esc** key
- **Save** via:
  - Save button
  - **Ctrl+Enter** keyboard shortcut

### Yahoo verification (live)

After the mnemonic field blurs, fire `/api/commodities/verify-symbol`. Show inline status next to the input:
- ✅ "Verified: <fullname>" — if verified
- ⚠️ "Not found on Yahoo Finance" — otherwise
- spinner while pending

If verification succeeds and the `fullname` input is blank, auto-fill it with the Yahoo-returned name. Don't overwrite a user-provided value.

If `namespace === 'CURRENCY'`, suppress the verification indicator entirely.

### Save flow

1. On submit: if the mnemonic was edited (or is being created) and the last verification result was `not found` (and namespace ≠ CURRENCY), show a confirmation dialog: "Symbol X wasn't found on Yahoo Finance. Save anyway?"
2. On confirm or already-verified, POST or PATCH as appropriate.
3. On success: close modal, refresh the table, toast.
4. On 409 conflict: keep modal open, show inline error on mnemonic ("A commodity with this namespace + symbol already exists").

## Component layout

- New file: [src/components/commodities/CommodityEditorModal.tsx](../../../src/components/commodities/CommodityEditorModal.tsx) — modal component (mode: 'create' | 'edit', initial values, onSaved callback)
- New hook: [src/lib/hooks/useYahooSymbolVerify.ts](../../../src/lib/hooks/useYahooSymbolVerify.ts) — debounced verification helper, used by both modal and inline-table edit
- Updated: [src/app/(main)/settings/commodities/page.tsx](../../../src/app/(main)/settings/commodities/page.tsx) — table inputs, Save All / Discard All, Add button, Alt+N listener
- Updated: [src/app/api/commodities/route.ts](../../../src/app/api/commodities/route.ts) — extended PATCH schema, new POST handler
- New: [src/app/api/commodities/verify-symbol/route.ts](../../../src/app/api/commodities/verify-symbol/route.ts) — Yahoo verification endpoint

## Error handling

- PATCH validation errors → 400 with field-specific messages, displayed inline next to the offending cell (or in modal)
- POST conflict → 409, surfaced in modal as inline error
- Yahoo verify endpoint failures → returned as `{ exists: false }`; UI treats as "unverified" and prompts for confirmation rather than blocking the save outright
- Network failure during Save All → per-row toast, dirty flag preserved, rest of the batch continues independently

## Out of scope

- Deleting commodities (cascades to accounts; needs a separate "in use" check + flow)
- Bulk import/export
- Editing a commodity's quote provider beyond `quote_source` string

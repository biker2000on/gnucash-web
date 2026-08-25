# beez-trackz Sync

Two-way transaction sync between folio and a [beez-trackz](https://github.com/)
hive-management install, over `/api/integrations/beez/*`.

## What it is for

beez-trackz records the operational side of an apiary — hives, inspections,
harvests, and the money that goes with them. Folio holds the books. Without a
link between them, every jar sale and every frame purchase has to be typed
twice, and the two copies drift.

This integration makes beez the system of record for the records it owns, and
folio the system of record for the ledger:

- beez **pushes** each of its financial records into folio as a balanced
  transaction, addressed by the id beez already uses for it.
- beez **pulls** a change feed so edits a human makes directly in folio — a
  corrected date, a recategorized expense, a deletion — flow back.

It operates on exactly **one book**: the book the API token was issued for. A
caller cannot name a book, so it cannot name the wrong one.

## Before you begin

1. **Create an API token.** Settings → API Tokens → Create token. Give it the
   **read/write (edit)** role if beez should post transactions; **read-only** is
   enough if you only want the change feed. The token is scoped to the book that
   was active when you created it, and the full secret is shown exactly once.
2. **Confirm the handshake.** `GET /api/integrations/beez/status` returns the
   book and its base currency. Version 1 writes **book-currency amounts only** —
   check that `rootCurrency` is what you expect before mapping anything.
3. **Map your accounts.** `GET /api/integrations/beez/accounts` returns every
   account under the book root with a colon-joined `fullName`. Only accounts
   where `placeholder` is `false` and `commodityMnemonic` equals `rootCurrency`
   can be posted to.
4. **Decide about closed periods.** If the book has a period lock date, beez
   cannot post or change anything on or before it. That is deliberate: a closed
   period keeps the figures it was reported with.

## How to use it

Authenticate every request with the token as a bearer credential:

```bash
curl -H "Authorization: Bearer gcw_0123456789abcdef0123456789abcdef" \
     https://your-server.example.com/api/integrations/beez/status
```

### Push a record

```bash
curl -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: beez-8412-attempt-1" \
  -d '{
        "externalId": "beez-8412",
        "postDate": "2026-08-25",
        "description": "Frames and foundation",
        "splits": [
          { "accountGuid": "<expense-guid>", "amountCents": 1250, "memo": "supplies" },
          { "accountGuid": "<checking-guid>", "amountCents": -1250 }
        ]
      }' \
  https://your-server.example.com/api/integrations/beez/transactions
```

- **Amounts are signed integer cents** and must sum to exactly `0`. Nothing is
  parsed from a decimal string and nothing is rounded.
- **`externalId` is the address.** Repeating the POST for an id that is already
  linked returns `200` with `alreadyLinked: true` and writes nothing — so a
  retry after a timeout can never post a second ledger entry.
- **`Idempotency-Key` is optional but recommended.** It makes an interrupted
  request return its original response instead of attempting a second write.
  Use a fresh key per attempt-group, not per record.

### Edit and delete

`PUT /api/integrations/beez/transactions/{externalId}` takes the same body minus
`externalId` and replaces the description, post date, num, and the complete
split set. There is no version token to send: folio locks the row for the
duration of the write and bumps its `enter_date`, which invalidates any browser
tab holding a stale copy.

`DELETE /api/integrations/beez/transactions/{externalId}` removes the
transaction and the link.

Both refuse with `409 { "error": "reconciled" }` when any split has been
reconciled to a bank statement. A reconciled split records an agreement a human
made with their bank, and beez does not get to break it silently — clear the
reconciliation in folio first if the change is genuinely wanted.

### Pull the change feed

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "https://your-server.example.com/api/integrations/beez/changes?since=$CURSOR&limit=100"
```

Store `nextCursor` and send it back as `since` on the next poll. An empty page
returns the cursor you sent, so polling never rewinds. Three item shapes matter:

| Shape | Meaning | What beez should do |
|---|---|---|
| `externalId` set, `deleted: false` | A record beez owns changed in folio | Apply the change locally |
| `externalId: null` | A transaction entered directly in folio | Ignore, or offer to adopt it |
| `deleted: true` | A record beez owns was deleted in folio | Delete locally, then `DELETE` the external id to acknowledge |
| `unrepresentable: true` | At least one split is not a whole number of cents | Surface as a conflict for a human — never guess |

Deletion tombstones repeat on **every** response until they are acknowledged
with `DELETE`. That is what makes a client that was offline for a week still
learn about the deletion.

## What it reads and changes

**Reads:** the token's book — its root commodity, its chart of accounts, its
transactions and splits, and the external-link rows this integration owns.

**Writes, on POST and PUT:**

- a row in `transactions` and one row per split in `splits`, with
  `value_num = amountCents` and `value_denom = 100` (quantity mirrors value,
  because version 1 is currency-only and no exchange rate applies);
- a `gnucash_web_transaction_meta` row with `source = 'beez-trackz'` and
  `reviewed = true`, so every folio surface can say where the entry came from;
- a `gnucash_web_external_links` row tying the transaction to `externalId`;
- a `gnucash_web_audit` row recording the change, attributed to the token owner.

**Writes, on DELETE:** removes the transaction, its splits, their slots, the
meta row, and the link, and records an audit row.

Everything in a single request commits or rolls back together, inside one
database transaction that also holds the idempotency claim.

Two database-enforced uniqueness rules do the real work, and neither is an
application check that could race:

- `UNIQUE (book_guid, source, external_id)` — one folio transaction per beez id;
- `UNIQUE (book_guid, source, entity_guid)` — one beez id per folio transaction.

### Limits of version 1

- **Book base currency only.** An account in another commodity (a stock account,
  a foreign-currency account) is refused with `422 currency_mismatch` rather
  than approximated.
- **Cents only.** GnuCash stores amounts as rationals whose denominator is not
  always a power of ten. A stored value that is not exactly a whole number of
  cents is reported as `unrepresentable`, never rounded — rounding would invent
  money.
- **`entity_type` is always `transaction`.** The link table is generic so a
  second integration adds rows rather than columns, but nothing else uses it yet.

## Verify the result

1. **Check the ledger.** Open the account you mapped in folio. A synced entry
   shows the description beez sent, on the date beez sent, balancing to zero.
2. **Check provenance.** Open the transaction's detail view: its source reads
   `beez-trackz`, not `manual`.
3. **Check the audit trail.** Settings → Change History lists a CREATE, UPDATE,
   or DELETE row per operation, attributed to the token owner, with the beez
   `external_id` in its payload. If an operation is not there, it did not
   happen.
4. **Check idempotency.** Repeat the same POST. You must get `200` with
   `alreadyLinked: true`, and the ledger must still show exactly one entry.
5. **Check the feed converges.** Poll `changes` until `hasMore` is `false` and
   no `deleted` items remain. Tombstones that keep reappearing mean the
   acknowledging `DELETE` is not being sent.

## Error reference

Every error body is `{ "error": "<code>", "detail": "<sentence>" }`.

| Status | `error` | Cause |
|---|---|---|
| 401 | — | Missing, malformed, revoked, or expired token |
| 403 | — | Token grants `readonly` but the endpoint writes |
| 404 | `account_not_found` | An account guid is not in this book (a foreign account and a missing one deliberately share this response) |
| 404 | `unknown_external_id` | No transaction is linked to that external id |
| 409 | `reconciled` | A split of the target transaction is reconciled |
| 409 | `idempotency_in_flight` | An identical `Idempotency-Key` is still being processed |
| 409 | `idempotency_exhausted` | That key failed its retry budget; an operator must re-arm it |
| 409 | `link_orphaned` | The external id points at a transaction deleted in folio; acknowledge with `DELETE` first |
| 422 | `validation` | Malformed body, path, `limit`, or `since` |
| 422 | `unbalanced` | The splits do not sum to zero cents |
| 422 | `placeholder_account` | A named account is a placeholder |
| 422 | `currency_mismatch` | A named account is not in the book's base currency |
| 400 | `PERIOD_LOCKED` | The post date falls in a closed period |

## Related

- [API Tokens & Webhooks](./api-tokens.md) — creating, scoping, and revoking the
  `gcw_` token this integration authenticates with.
- Settings → API Documentation (`/settings/api-docs`) — the in-app endpoint
  reference, including the interactive OpenAPI spec at `/api/docs`.

# n8n Recipes — Inbound Webhooks

GnuCash Web exposes two convenience endpoints designed for automation tools
like [n8n](https://n8n.io):

| Endpoint | Purpose |
| --- | --- |
| `POST /api/webhooks/inbound/transaction` | Create a simple two-split transaction |
| `POST /api/webhooks/inbound/membership-payment` | Record a membership dues payment |

Both authenticate with the same **personal access tokens** as the rest of the
API (`Authorization: Bearer gcw_...` — create one under Settings → API Tokens
with the **edit** role). Requests land in the token's book and respect the
book's period lock (a mutation dated into a closed period returns `400` with
code `PERIOD_LOCKED`). Full endpoint reference: in-app at
**Settings → API Documentation** (`/settings/api-docs`).

In every n8n **HTTP Request** node below, set:

- **Method**: `POST`
- **Authentication**: *Generic Credential Type* → *Header Auth*, with
  - Name: `Authorization`
  - Value: `Bearer gcw_<your token>`
- **Body Content Type**: JSON

Storing the token as an n8n credential (rather than pasting it into the node)
keeps it out of exported workflow JSON.

---

## Recipe 1 — Log an expense from anywhere (webhook → transaction)

Push a quick expense into the ledger from a phone shortcut, a Slack slash
command, or any tool that can POST JSON to n8n.

**Workflow: `Quick expense logger`**

1. **Webhook** node (trigger)
   - HTTP Method: `POST`
   - Path: `quick-expense`
   - Respond: *When Last Node Finishes*
   - Expected incoming payload (from your shortcut/tool):

     ```json
     { "description": "Coffee", "amount": 4.75 }
     ```

2. **Set** node — *Map to ledger fields*
   - `date` → `{{ $now.format('yyyy-MM-dd') }}`
   - `description` → `{{ $json.body.description }}`
   - `amount` → `{{ Number($json.body.amount) }}`
   - `fromAccountGuid` → your checking account GUID (fixed value)
   - `toAccountGuid` → your expense account GUID (fixed value)

   Find account GUIDs with `GET /api/accounts?flat=true` (any REST client),
   or from the account page URL in the app (`/accounts/<guid>`).

3. **HTTP Request** node — *Create transaction*
   - URL: `https://your-server.example.com/api/webhooks/inbound/transaction`
   - Body: *Using Fields Below* → send `date`, `description`, `amount`,
     `fromAccountGuid`, `toAccountGuid` from the previous node.

   A successful call returns `201` with the new `transactionGuid`. Validation
   problems (bad date, unknown account, amount ≤ 0, same from/to account)
   return `400` with an `error` message — add an **IF** node on
   `{{ $json.success }}` if you want failure alerts.

Variation: replace the Webhook trigger with n8n's Email or Telegram trigger
and parse the amount/description out of the message text.

---

## Recipe 2 — Record dues payments from a payment processor

When a payment processor (Zeffy, Stripe, PayPal, ...) emails a receipt or
fires its own webhook, record the dues payment against the member —
membership coverage periods extend automatically based on the member's
membership type.

**Workflow: `Dues payment sync`**

1. **Webhook** node (trigger) — receives the processor's event, e.g.

   ```json
   { "payer_email": "pat@example.com", "amount": 50, "paid_at": "2026-07-14", "id": "ZFY-98765" }
   ```

2. **HTTP Request** node — *Look up the member*
   - Method: `GET`
   - URL: `https://your-server.example.com/api/membership/members`
   - Same Header Auth credential.

3. **Code** node — *Match payer to memberId*

   ```js
   const payerEmail = $('Webhook').first().json.body.payer_email.toLowerCase();
   const members = $input.first().json;
   const member = members.find(m => (m.email || '').toLowerCase() === payerEmail);
   if (!member) throw new Error(`No member with email ${payerEmail}`);
   return [{ json: { memberId: member.id } }];
   ```

4. **HTTP Request** node — *Record payment*
   - URL: `https://your-server.example.com/api/webhooks/inbound/membership-payment`
   - JSON body:

     ```json
     {
       "memberId": {{ $json.memberId }},
       "amount": {{ $('Webhook').first().json.body.amount }},
       "paidDate": "{{ $('Webhook').first().json.body.paid_at }}",
       "method": "zeffy",
       "reference": "{{ $('Webhook').first().json.body.id }}"
     }
     ```

   Returns `201` with the recorded payment and the member's new
   `paidThrough` date. An unknown `memberId` returns `404`; a member without
   a membership type returns `400` (assign one in the Membership page first).

5. *(Optional)* **IF** + notification node — alert yourself when the member
   lookup fails so unmatched payments don't silently disappear.

---

## Troubleshooting

- `401 Invalid or expired API token` — token revoked/expired, or the
  `Authorization` header isn't reaching the server (check reverse-proxy
  header forwarding).
- `403 Requires edit role...` — the token was created read-only; create a new
  one with the edit role.
- `400 PERIOD_LOCKED` — the date falls on or before the book's period lock
  date (Settings → book settings).
- Transactions land in the wrong book — tokens are scoped to the book that
  was active when the token was created; create a separate token per book.

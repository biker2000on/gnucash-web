# API Tokens & Webhooks

GnuCash Web supports **personal access tokens** for authenticating API requests
without a browser session, and **outbound webhooks** that deliver signed
notification events to external services.

## API Tokens

### Creating a token

Settings → API Tokens → **Create token**. Choose a name, an access level
(read-only or read/write), and an expiration. The full secret
(`gcw_` + 32 hex characters) is shown **exactly once** — only its SHA-256 hash
is stored server-side. Tokens are scoped to the book that was active when you
created them.

### Authenticating

Send the token as a Bearer token in the `Authorization` header:

```bash
curl -H "Authorization: Bearer gcw_0123456789abcdef0123456789abcdef" \
     https://your-server.example.com/api/accounts
```

> Note: the middleware must pass Bearer-token requests through to the route
> handlers (see the middleware note in the repo). Session cookies are not
> needed when a token is supplied.

### Role semantics

Roles per book are `readonly` < `edit` < `admin`.

- A token carries its own role: `readonly` or `edit`. Tokens can **never**
  carry `admin`.
- The effective role of a token request is the **minimum** of:
  1. the token's role, and
  2. the token owner's actual role for the book at request time.

  So a token can narrow permissions but never escalate them. If the owner's
  book access is revoked or downgraded, every token follows immediately.
- Endpoints that require `admin` always reject token-authenticated requests.
- Token and webhook **management** endpoints (`/api/settings/api-tokens*`,
  `/api/settings/webhooks*`) reject token authentication outright — a leaked
  token cannot be used to mint more tokens or exfiltrate webhook secrets.
- Expired (`expires_at` in the past) and revoked tokens return `401`.

### Revocation

Settings → API Tokens → **Revoke**, or:

```bash
curl -X DELETE -b <session-cookie> https://your-server/api/settings/api-tokens/<id>
```

Revocation is immediate.

## Webhooks

Webhooks POST a JSON body to your endpoint whenever a matching in-app
notification is created (budget alerts, spending anomalies, bank sync status,
monthly digests, etc.).

### Payload

```json
{
  "id": 123,
  "type": "budget_alert",
  "severity": "warning",
  "title": "Budget overspend: Dining",
  "message": "Dining is 120% of budget with 10 days left.",
  "href": "/budgets/abc",
  "bookGuid": "0123456789abcdef0123456789abcdef",
  "createdAt": "2026-07-12T15:04:05.000Z"
}
```

Headers on every delivery:

| Header | Value |
| --- | --- |
| `Content-Type` | `application/json` |
| `X-GnucashWeb-Event` | the notification `type` (e.g. `budget_alert`) |
| `X-GnucashWeb-Signature` | `sha256=<hex HMAC-SHA256 of the raw request body, keyed with the webhook secret>` |

Deliveries time out after 5 seconds and are retried once. The most recent
delivery status is shown in Settings → Webhooks.

### Verifying the signature

Always compare signatures with a constant-time function against the **raw**
request body bytes (before any JSON parsing/re-serialization).

**Node.js:**

```js
const crypto = require('node:crypto');

function verifyGnucashWebhook(rawBody, signatureHeader, secret) {
  const expected = 'sha256=' +
    crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(signatureHeader || '', 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Express example (needs the raw body):
// app.post('/hooks/gnucash', express.raw({ type: 'application/json' }), (req, res) => {
//   if (!verifyGnucashWebhook(req.body, req.get('X-GnucashWeb-Signature'), SECRET)) {
//     return res.status(401).end();
//   }
//   const event = JSON.parse(req.body);
//   res.status(204).end();
// });
```

**Python:**

```python
import hashlib
import hmac

def verify_gnucash_webhook(raw_body: bytes, signature_header: str, secret: str) -> bool:
    expected = "sha256=" + hmac.new(
        secret.encode("utf-8"), raw_body, hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(signature_header or "", expected)

# Flask example:
# @app.post("/hooks/gnucash")
# def gnucash_hook():
#     if not verify_gnucash_webhook(request.get_data(),
#                                   request.headers.get("X-GnucashWeb-Signature", ""),
#                                   SECRET):
#         abort(401)
#     event = request.get_json()
#     return "", 204
```

### URL restrictions

By default, webhook URLs must be `http(s)` and may not point at localhost,
private (RFC 1918), or link-local addresses. Self-hosted users who want to
target LAN services (e.g. Home Assistant, n8n) can check **Allow
private/internal hosts** when creating the webhook. The check inspects the
URL's literal hostname only — it does not resolve DNS.

### Testing

Settings → Webhooks → **Test** sends a signed `webhook_test` event to the
endpoint and reports the HTTP status.

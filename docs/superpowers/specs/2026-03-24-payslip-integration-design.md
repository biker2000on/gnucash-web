# Payslip Integration Design

## Overview

Import payroll stubs into GnuCash Web, store PDFs alongside receipts, and auto-generate detailed split transactions from payslip line items. Phase 1 uses PDF upload + AI extraction. Phase 2 adds QuickBooks Online API as a structured data source.

## Goals

- Parse payslip PDFs into structured line items (earnings, taxes, deductions) via AI extraction
- Map line items to GnuCash accounts with reusable per-employer templates
- Generate proper double-entry split transactions from payslips
- Store payslip PDFs using existing S3/filesystem storage
- Reconcile with SimpleFin lump-sum deposit imports
- Phase 2: Pull structured payslip data directly from QuickBooks Online API

## Data Model

### `gnucash_web_payslips`

| Column | Type | Description |
|--------|------|-------------|
| id | UUID | Primary key |
| book_guid | TEXT (FK) | Book this payslip belongs to |
| pay_date | DATE | Date of payment |
| pay_period_start | DATE | Pay period start |
| pay_period_end | DATE | Pay period end |
| employer_name | TEXT | Employer name |
| gross_pay | NUMERIC | Gross pay amount |
| net_pay | NUMERIC | Net pay amount |
| currency | TEXT | Currency code |
| source | TEXT | `'pdf_upload'`, `'qbo_api'`, or `'manual'` |
| source_id | TEXT (nullable) | QBO paycheck ID or SimpleFin txn ID for dedup |
| transaction_guid | TEXT (FK, nullable) | Linked GnuCash transaction once posted |
| storage_key | TEXT (nullable) | PDF in S3/filesystem (reuses receipt storage) |
| thumbnail_key | TEXT (nullable) | Thumbnail for list view |
| line_items | JSONB | Array of extracted line items |
| raw_response | JSONB (nullable) | Raw AI extraction or QBO API response (for debugging) |
| status | TEXT | `'processing'`, `'needs_mapping'`, `'ready'`, `'posted'`, `'error'` |
| error_message | TEXT (nullable) | Extraction failure reason |
| created_by | INTEGER (FK) | User who uploaded (FK to `gnucash_web_users.id`) |
| created_at | TIMESTAMP | |
| updated_at | TIMESTAMP | |

### Line items JSONB structure

```json
[
  { "category": "earnings", "label": "Regular Pay", "normalized_label": "regular_pay", "hours": 80, "rate": 50.00, "amount": 4000.00 },
  { "category": "tax", "label": "Federal Income Tax", "normalized_label": "federal_income_tax", "amount": -600.00 },
  { "category": "tax", "label": "Social Security", "normalized_label": "social_security", "amount": -248.00 },
  { "category": "deduction", "label": "401(k)", "normalized_label": "401k", "amount": -400.00 },
  { "category": "deduction", "label": "Health Insurance", "normalized_label": "health_insurance", "amount": -150.00 },
  { "category": "employer_contribution", "label": "401(k) Match", "normalized_label": "401k_match", "amount": 200.00 }
]
```

Categories: `earnings`, `tax`, `deduction`, `employer_contribution`, `reimbursement`

**Label normalization:** Each line item has a `label` (display name from the PDF) and a `normalized_label` (lowercase, stripped of whitespace/punctuation, used for mapping lookups). The AI extraction prompt instructs the model to produce both. This prevents "Fed Income Tax" and "Federal Income Tax" from creating separate mappings. Users can edit the normalized label in the detail view if the AI gets it wrong.

### `gnucash_web_payslip_mappings`

| Column | Type | Description |
|--------|------|-------------|
| id | UUID | Primary key |
| book_guid | TEXT (FK) | |
| employer_name | TEXT | Employer name |
| normalized_label | TEXT | Normalized key, e.g. "federal_income_tax" |
| line_item_category | TEXT | e.g. "tax" |
| account_guid | TEXT (FK) | Target GnuCash account |
| created_at | TIMESTAMP | |
| updated_at | TIMESTAMP | |

Unique constraint: `(book_guid, employer_name, normalized_label, line_item_category)`

## Account Mapping

1. First payslip from an employer — no mappings exist. UI presents each line item and asks the user to pick a GnuCash account (with smart suggestions: "Federal Income Tax" suggests accounts containing "Tax" or "Federal").
2. Mappings saved per employer + line item label.
3. Future payslips auto-map known line items. Only new/changed labels need manual mapping.
4. Net pay (deposit side) maps to a user-selected bank account.

### Transaction Generation

Each payslip produces one GnuCash transaction with N splits:
- One split per line item mapped to its account
- Net pay split mapped to bank account
- All splits sum to zero (double-entry)

**Employer contributions** (e.g., 401(k) match) are excluded from the main payslip transaction — they don't flow through the employee's bank account. They are stored as line items for informational display on the payslip detail view but do not generate splits. If the user wants to track employer contributions as GnuCash transactions (e.g., debit 401k asset, credit employer-match income), they can optionally post them as a separate transaction.

**Balance validation:** Before posting, the system verifies that `sum(earnings) + sum(taxes) + sum(deductions) + sum(reimbursements) - net_pay == 0`. If there is a discrepancy (common with AI extraction rounding), the difference is shown to the user. They can either: (a) edit line item amounts to fix, or (b) post with the remainder assigned to a configurable imbalance account (matching the SimpleFin import pattern).

If a SimpleFin lump-sum deposit already exists for this paycheck, the user can replace it with the detailed split transaction.

## PDF Upload + AI Extraction Pipeline (Phase 1)

### Flow

1. User uploads payslip PDF via `POST /api/payslips/upload`
2. PDF stored via existing S3/filesystem storage backend
3. Thumbnail generated via existing `regenerate-thumbnails` BullMQ job
4. New `extract-payslip` BullMQ job enqueued
5. Job sends PDF to user's configured AI provider with structured extraction prompt
6. AI returns JSON — validated against line item schema
7. Payslip record created with extracted line items
8. System checks mappings for this employer:
   - All line items mapped → status `ready`, auto-generates draft transaction
   - Some unmapped → status `needs_mapping`

### Status Flow

```
processing → needs_mapping → ready → posted
         ↘ error (extraction failure)
```

On extraction failure, status moves to `error` with `error_message` populated (following the receipt OCR `ocr_status: 'failed'` pattern). User can retry extraction.

User can review and edit extracted data before posting. Batch upload supported (multiple PDFs queue independently).

## SimpleFin Enrichment

### Matching existing deposits

When a payslip is posted:
- Look for SimpleFin-imported transactions within +/- 3 days of pay date where deposit amount matches net pay (exact or within $0.01)
- If exactly one match, offer to replace the lump-sum transaction with the detailed split transaction
- If multiple matches (e.g., two deposits of the same amount in the same week), present the candidates and ask the user to confirm which one
- Preserve SimpleFin transaction ID in payslip's `source_id` for dedup

### Preventing future duplicates

When SimpleFin imports a new deposit:
- Check if a payslip with matching net pay + date (same +/- 3 day, $0.01 tolerance) already exists and is posted
- If so, skip importing the duplicate lump-sum

## UI

### Payslips list page (`/payslips`)

- Table: pay date, employer, gross, net, status
- Upload button with drag-and-drop PDF zone
- Filter by employer, date range, status
- Click row to open detail view

### Payslip detail view (`/payslips/[id]`)

- Left: PDF viewer (reuse receipt viewer component)
- Right: extracted line items in editable table
  - Each row: category, label, amount, mapped account (dropdown from account tree)
  - Unmapped rows highlighted
  - "Save mappings" persists to mappings table for future auto-mapping
- Bottom: transaction preview showing splits
- "Post transaction" button creates GnuCash transaction and links it
- Option to match against existing SimpleFin deposit (date + amount fuzzy match)

### Payslip settings (under existing settings area)

- Default deposit account selection (global default, overridable per employer)
- Manage saved mappings per employer (edit/delete)
- Phase 2 placeholder: "Connect QuickBooks Online" (disabled with explanation)

## Phase 2: QuickBooks Online API (Future TODO)

### Auth

- User registers Intuit Developer app — client ID + secret stored encrypted (AES-256-GCM + scrypt, same as SimpleFin)
- OAuth 2.0 authorization code flow via `/api/qbo/connect`
- Refresh tokens auto-rotate (100-day expiry, 1-hour access tokens)
- Token storage in `gnucash_web_qbo_connections` table

### Sync

- Manual trigger or scheduled BullMQ job (`sync-qbo-payslips`)
- Calls QBO Payroll API for paychecks
- Each paycheck has structured line items — no AI parsing needed
- Creates payslip records with `source: 'qbo_api'`, dedup via `source_id`
- Downloads PDF if available
- Feeds into same mapping → transaction pipeline as PDF upload

### Key Constraint

Intuit's payroll API requires approval and a paid QuickBooks Payroll subscription. The PDF path is always available as fallback. UI should make this clear.

## Non-Goals

- Issuing payroll (this is read/import only)
- Supporting QuickBooks Desktop (no usable API)
- Auto-categorizing without user confirmation on first encounter

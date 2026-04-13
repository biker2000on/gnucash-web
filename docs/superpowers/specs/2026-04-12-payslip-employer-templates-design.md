# Payslip Employer Templates Design

## Overview

Make payslip extraction work without AI by introducing employer templates — saved line item structures that enable regex-based amount extraction from OCR text. The extraction pipeline becomes 3-tier: AI → template+regex → regex-only with manual entry.

## Goals

- Payslip upload works without AI configured (regex fallback + manual entry)
- First payslip from an employer builds a reusable template (whether via AI or manual entry)
- Subsequent payslips from the same employer auto-populate line items using the template + regex amount matching
- User can always correct any extracted data before posting

## Data Model

### `gnucash_web_payslip_templates`

| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL | Primary key (`@default(autoincrement())`) |
| book_guid | VARCHAR(32) | Book scope |
| employer_name | VARCHAR(255) | Employer name |
| line_items | JSONB | Template structure (labels + categories, no amounts) |
| created_at | TIMESTAMP | `@default(now())` |
| updated_at | TIMESTAMP | `@default(now())` |

Unique constraint: `@@unique([book_guid, employer_name])`

### Template line_items JSONB structure

```json
[
  { "category": "earnings", "label": "Regular Pay", "normalized_label": "regular_pay" },
  { "category": "tax", "label": "Federal Income Tax", "normalized_label": "federal_income_tax" },
  { "category": "tax", "label": "Social Security", "normalized_label": "social_security" },
  { "category": "deduction", "label": "401(k)", "normalized_label": "401k" },
  { "category": "employer_contribution", "label": "401(k) Match", "normalized_label": "401k_match" }
]
```

Templates store structure only — no amounts, no hours, no rates. These change every pay period; the structure doesn't.

## Extraction Pipeline

### 3-Tier Fallback

```
PDF uploaded → OCR text extracted
  ├─ Tier 1: AI configured? → AI extraction (existing) → save/update template
  ├─ Tier 2: Template exists for employer? → apply template + regex amounts
  └─ Tier 3: No AI, no template → regex top-level fields only → manual entry
```

All tiers extract OCR text first (existing `extractTextFromPdf`). The tier determines how line items are populated.

### Tier 1: AI Extraction (existing + template auto-save)

Works as currently built. After successful AI extraction, upsert the template for the employer with the extracted line item structure (labels + categories, strip amounts).

### Tier 2: Template + Regex Amounts

When AI is unavailable but a template exists for the employer:

1. Load template for employer
2. For each template line item, scan OCR text for the label and extract the adjacent dollar amount
3. Also regex-extract top-level fields (employer name, dates, gross/net)
4. Populate payslip with template line items + regex-extracted amounts
5. Set status to `needs_mapping` so user can review/correct

### Tier 3: Regex-Only (Manual Entry)

When neither AI nor template is available:

1. Regex-extract what we can from OCR text (employer name, dates, gross/net)
2. Set status to `needs_mapping` with empty line items array
3. User manually adds line items in the detail panel
4. On first post, save the line item structure as a template

## Regex Extraction

### Amount Matcher (`extractAmountForLabel`)

For a given label string, find its value in OCR text:

1. Build a regex from the label: escape special chars, allow flexible whitespace between words
2. Search for the label (case-insensitive)
3. Look for the nearest dollar amount within ~80 characters after the match: `/-?\$?\s*[\d,]+\.\d{2}/`
4. Parse the matched string to a number
5. If the label is a tax or deduction, ensure the amount is negative
6. Return the amount, or null if not found

### Top-Level Field Extraction (`extractPayslipFields`)

Scan OCR text for common payslip fields:

- **Employer name**: First substantive non-date, non-number line in the first 5 lines of text. Heuristic: skip lines that are purely numeric, purely date-like, or very short (<3 chars).
- **Pay date**: Look for amount near keywords: "Pay Date", "Check Date", "Payment Date", "Date Paid". Match common date formats: `MM/DD/YYYY`, `YYYY-MM-DD`, `Mon DD, YYYY`.
- **Pay period**: Look for "Period" keywords with date ranges: `MM/DD/YYYY - MM/DD/YYYY` or `MM/DD/YYYY to MM/DD/YYYY`.
- **Gross pay**: Amount near "Gross Pay", "Gross Earnings", "Total Earnings", "Gross".
- **Net pay**: Amount near "Net Pay", "Net Amount", "Net Check", "Take Home", "Total Net Pay".

All extracted values are suggestions — user can override in the detail panel.

## Template Auto-Save

When `postPayslipTransaction` is called:

1. Extract the line item structure (labels + categories) from the payslip being posted
2. Upsert into `gnucash_web_payslip_templates` for the employer
3. This happens for both AI-extracted and manually-entered payslips

This means the template library builds up automatically through normal usage.

## Employer Name Resolution

The extraction job needs to determine the employer name to look up templates. Three sources, in priority order:

1. AI extraction (Tier 1) — AI returns employer name
2. Regex extraction — scan first few lines of OCR text
3. Fallback — remains "Unknown" until user edits it

For Tier 2 (template lookup), the job needs the employer name before it can find the template. Approach: regex-extract the employer name first, then look up the template. If regex can't determine employer, check if only one employer exists in the templates table for this book — if so, use it. Otherwise, fall back to Tier 3.

## UI Changes

### PayslipDetailPanel

- **Employer name field**: Editable text input (pre-filled from extraction, user can correct). Currently displays employer name as read-only text in the header — change to an editable input when status is not `posted`.
- **"Add Line Item" button**: Appears below the line item table when status is not `posted`. Adds an empty row with category dropdown, label input, normalized_label input (auto-generated from label), and amount input.
- Template auto-saves on post — no explicit "Save as Template" button needed.

### PayslipLineItemTable

- **Add row**: New empty row with:
  - Category: dropdown select (earnings/tax/deduction/employer_contribution/reimbursement)
  - Label: text input
  - Normalized label: auto-generated from label (lowercase, spaces→underscores, strip punctuation), editable
  - Amount: number input
  - Account: AccountSelector (existing)
  - Delete button (X) to remove the row
- **Remove row**: Only available when `editable=true` and status is not `posted`

## Non-Goals

- Template sharing across books
- Template import/export
- Template editing UI (templates are implicitly managed via payslip posting)
- Multi-format template matching (e.g., different PDF layouts from same employer)

# Account New/Edit Modal — Full Field Support

**Date:** 2026-03-27
**Status:** Approved

## Problem

The account create/edit modal (`AccountForm.tsx`) is missing several fields that GnuCash desktop exposes: Notes, Tax Related, and Retirement settings. Additionally, edit mode hides Account Type, Parent, and Currency/Commodity entirely rather than showing them as read-only context. The retirement toggle currently lives only on the account detail page, creating a fragmented editing experience.

## Design

### Modal Layout (single-panel, top to bottom)

**Create mode** — all fields editable:

1. **Name** — text input (required)
2. **Account Type** — dropdown grouped by category (Assets, Liabilities, Income, Expenses, Equity, Other)
3. **Parent Account** — searchable account picker
4. **Currency/Commodity** — dropdown (auto-inherits from parent, user can override)
5. **Account Code** — text input (optional)
6. **Description** — text input (optional)
7. **Notes** — textarea (optional)
8. **Checkboxes row**: Hidden, Placeholder, Tax Related
9. **Retirement section** (conditional — visible only for STOCK, MUTUAL, ASSET, BANK types):
   - Retirement Account toggle
   - Retirement Account Type dropdown (401k, 403b, 457, Traditional IRA, Roth IRA, HSA, Brokerage) — shown when toggle is on

**Edit mode** — same layout, but:

- Account Type, Parent Account, Currency/Commodity displayed as **read-only text** (visible, not editable)
- Parent Account is editable (reparenting allowed freely)
- All other fields remain editable

### Data Storage

| Field | Storage Location | Details |
|-------|-----------------|---------|
| Notes | `slots` table | `obj_guid = account.guid`, `name = 'notes'`, `slot_type = 4`, `string_val = <notes text>` |
| Tax Related | `gnucash_web_account_preferences` table | New `tax_related` boolean column |
| Retirement fields | `gnucash_web_account_preferences` table | Existing `is_retirement` + `retirement_account_type` columns |
| Core fields | `accounts` table | Existing columns: name, account_type, parent_guid, commodity_guid, code, description, hidden, placeholder |

### API Changes

**POST `/api/accounts`** (create):
- Accept new fields: `notes`, `tax_related`, `is_retirement`, `retirement_account_type`
- After creating the account row, write `notes` to `slots` table if provided
- Upsert `tax_related`, `is_retirement`, `retirement_account_type` into `gnucash_web_account_preferences`

**PUT `/api/accounts/{guid}`** (update):
- Accept new fields: `notes`, `tax_related`, `is_retirement`, `retirement_account_type`, `parent_guid`
- Upsert `notes` in `slots` table (insert if new, update if exists, delete if cleared)
- Upsert preferences fields in `gnucash_web_account_preferences`
- Allow `parent_guid` changes (reparenting)

**GET account info** (read for edit modal population):
- Include `notes` from slots table via LEFT JOIN (`slots.obj_guid = accounts.guid AND slots.name = 'notes'`)
- Include `tax_related`, `is_retirement`, `retirement_account_type` from `gnucash_web_account_preferences`

### Detail Page Changes

- Remove the retirement account toggle section from `/accounts/[guid]/page.tsx`
- The modal becomes the single place to manage all account settings

### Validation Rules

- Name is required
- Account type, parent, and commodity are required on create; immutable on edit (except parent)
- Retirement section only appears for STOCK, MUTUAL, ASSET, BANK account types
- Retirement account type required when retirement toggle is on
- Notes is freeform text, no length limit enforced in UI

### Migration

- Add `tax_related BOOLEAN DEFAULT FALSE` column to `gnucash_web_account_preferences` table
- No other schema changes needed (slots table and preferences table already exist)

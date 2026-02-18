# Design: Security, SimpleFin, New User Workflow & Ledger Improvements

**Date:** 2026-02-18
**Status:** Approved

## Overview

Four interconnected improvements to GnuCash Web:

1. **Route security & RBAC** — Lock down all routes, implement 3-tier role system
2. **New user workflow** — Onboarding with templates and import (shared with "Create Book" flow)
3. **SimpleFin integration** — Pull bank transactions, map accounts, review imports
4. **Inline editable ledger** — Keyboard-navigable editing in account ledger pages
5. **Tax rate bug fix** — Fix cursor jump in settings tax rate input

---

## 1. Route Security & RBAC

### Authentication: Next.js Middleware

A new `middleware.ts` at the project root intercepts all requests.

**Public routes** (no auth required):
- `/` (landing page)
- `/login`
- `/api/auth/login`
- `/api/auth/register`
- `/_next/*`, `/icon.svg` (static assets)

**Protected routes** (require valid session):
- All other `/api/*` routes → return `401 JSON` if no session
- All other page routes → redirect to `/login`

The middleware only checks **authentication** (is the user logged in?). It reads the `iron-session` cookie and validates it. No database queries in middleware — just cookie validation.

**Current state:** 69 API routes, only 11 have auth checks. The rest are wide open.

### Authorization: RBAC at Handler Level

Following the existing research doc's 3-tier model (`docs/security-rbac-research.md`).

**Database tables** (created via raw SQL in `db-init.ts`):
- `gnucash_web_roles` — `readonly`, `edit`, `admin`
- `gnucash_web_book_permissions` — user + book + role mapping (UNIQUE on user_id + book_guid)
- `gnucash_web_invitations` — invitation codes with expiry, max uses, revocation

**Permission service** (`src/lib/services/permission.service.ts`):
- `getUserRoleForBook(userId, bookGuid)` → role string or null
- `requireRole(minRole)` → helper that checks session + active book + returns 403 if insufficient
- Role hierarchy: `readonly (0) < edit (1) < admin (2)`

**Per-route enforcement:**
- `GET` data endpoints → `requireRole('readonly')`
- `POST/PUT/DELETE` data endpoints → `requireRole('edit')`
- User/book management endpoints → `requireRole('admin')`
- Full matrix follows the research doc's Section 4.5

**Migration:** On first run, all existing users get `admin` on all existing books (backward compatible).

### Landing Page

A feature showcase page at `/` for unauthenticated visitors:
- App name + tagline ("View and manage your GnuCash data on the web")
- 3-4 feature cards with icons (Dashboard analytics, Transaction management, Reports, Investment tracking)
- Login / Register CTA buttons
- Matches existing dark theme

### Session Extension

Extend `SessionData` in `src/lib/auth.ts`:
```typescript
export interface SessionData {
    userId?: number;
    username?: string;
    isLoggedIn: boolean;
    activeBookGuid?: string;     // already exists
    activeBookRole?: string;     // new: cached role for active book
    bookRoles?: Record<string, string>; // new: all book→role mappings
    rolesCachedAt?: number;      // new: cache expiry timestamp
}
```

Roles cached in session with 5-minute TTL. Force refresh on book switch or permission change.

---

## 2. New User Workflow

### Shared "Create Book" Flow

The template/import flow is a **shared component** used in two places:
1. **Onboarding** (`/onboarding`) — shown to users with zero book permissions after login
2. **Book Management** — accessible from the book selector or settings to create additional books

### Onboarding Page

After login, if user has no book permissions → redirect to `/onboarding`.

The page shows:
- Welcome message
- Two side-by-side cards:
  - **Start from Template**: Choose from 3 prebuilt account hierarchy templates
  - **Import from GnuCash**: Upload a `.gnucash` file (XML)

### Account Templates

JSON files in `src/lib/templates/`:

**Personal Finance:**
- Assets: Checking, Savings, Cash
- Liabilities: Credit Card, Mortgage, Auto Loan
- Income: Salary, Interest, Dividends
- Expenses: Groceries, Dining, Utilities, Rent, Transportation, Insurance, Entertainment, Healthcare, Clothing

**Small Business:**
- Assets: Checking, Savings, Accounts Receivable, Inventory, Equipment, Accumulated Depreciation
- Liabilities: Accounts Payable, Credit Card, Line of Credit, Loans Payable, Sales Tax Payable
- Income: Revenue, Service Revenue, Interest Income
- Expenses: COGS, Payroll, Rent, Utilities, Insurance, Office Supplies, Marketing, Professional Fees

**Non-Profit:**
- Assets: Checking, Savings, Grants Receivable, Pledges Receivable
- Liabilities: Accounts Payable, Deferred Revenue
- Income: Donations, Grant Revenue, Program Revenue, Fundraising Revenue
- Expenses: Program Services, Management & General, Fundraising Expenses, Salaries & Benefits

### Create Book API

`POST /api/books` (admin required, or public for first book):
- Accepts `{ name, template?: string, file?: FormData }`
- Creates `books` row + root account + template accounts (or imported accounts)
- Grants `admin` role to creating user
- Returns new book guid

---

## 3. SimpleFin Integration

### How SimpleFin Bridge Works

SimpleFin Bridge ($1.50/month) is a third-party bank aggregation service:
- Users connect bank accounts on SimpleFin's website (handles bank login, MFA, credentials)
- SimpleFin provides a setup token → exchanged for a permanent access URL
- Our app uses the access URL to pull account balances and transactions (read-only)
- Bank connections are managed on SimpleFin's site, not in our app

### Setup Flow

**Settings > Connections page:**

1. **Before setup** (no connection stored):
   - Explanation of SimpleFin Bridge, pricing, benefits
   - Link to [simplefin.org/bridge](https://simplefin.org/bridge) to sign up
   - Step-by-step instructions: (1) Sign up, (2) Connect banks on SimpleFin, (3) Get setup token, (4) Paste token here
   - Input field for setup token + "Connect" button

2. **Token exchange**:
   - `POST` setup token to SimpleFin's claim endpoint
   - Receive access URL (permanent API credential)
   - Store access URL encrypted in `gnucash_web_simplefin_connections` table

3. **After setup** (connection active):
   - Connection status indicator (connected, last sync time)
   - "Manage bank connections on SimpleFin" link (opens SimpleFin in new tab)
   - "Sync Now" button
   - Account mapping section (see below)
   - "Disconnect" button (deletes stored credentials)

### Account Mapping

After setup, the Connections page shows:
- List of all SimpleFin accounts (fetched via `GET /accounts`)
- Each account shows: institution name, account name, last 4 digits
- Dropdown to select corresponding GnuCash account for each
- Unmapped accounts flagged — won't sync until mapped

**Mapping stored in:** `gnucash_web_simplefin_account_map` table (simplefin_account_id → gnucash_account_guid)

### Transaction Sync

**Trigger:** Nightly schedule (alongside price refresh) + manual "Sync Now"

**Process per mapped account:**
1. Fetch transactions from SimpleFin since `last_sync_at`
2. Dedup: skip transactions matching existing ones (date + amount + description)
3. For new transactions:
   - Create GnuCash transaction + two splits:
     - Split 1: mapped bank account (debit/credit based on amount sign)
     - Split 2: guessed destination account
   - Store metadata in `gnucash_web_transaction_meta` with `reviewed = false`

**Category guessing (payee-based):**
- Search historical transactions with same/similar description
- Use the most frequent destination account as the guess
- If < 2 historical matches → mark as "low confidence", default to `Imbalance-{currency}`

### Nightly Integration

The existing Settings > Price Refresh Schedule gains:
- "Sync SimpleFin transactions" checkbox
- When enabled, SimpleFin sync runs after price refresh in the nightly job
- Manual "Sync Now" available on the Connections page

### Database Tables

```sql
-- SimpleFin connection credentials
CREATE TABLE IF NOT EXISTS gnucash_web_simplefin_connections (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES gnucash_web_users(id) ON DELETE CASCADE,
    access_url_encrypted TEXT NOT NULL,
    last_sync_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Account mapping: SimpleFin account → GnuCash account
CREATE TABLE IF NOT EXISTS gnucash_web_simplefin_account_map (
    id SERIAL PRIMARY KEY,
    connection_id INTEGER NOT NULL REFERENCES gnucash_web_simplefin_connections(id) ON DELETE CASCADE,
    simplefin_account_id VARCHAR(255) NOT NULL,
    simplefin_account_name VARCHAR(255),
    gnucash_account_guid VARCHAR(32) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(connection_id, simplefin_account_id)
);

-- Transaction metadata for tracking import source and review status
CREATE TABLE IF NOT EXISTS gnucash_web_transaction_meta (
    id SERIAL PRIMARY KEY,
    transaction_guid VARCHAR(32) NOT NULL UNIQUE,
    source VARCHAR(50) NOT NULL DEFAULT 'manual',  -- 'simplefin' | 'manual'
    reviewed BOOLEAN NOT NULL DEFAULT TRUE,
    imported_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    simplefin_transaction_id VARCHAR(255),
    confidence VARCHAR(20)  -- 'high' | 'low' | null
);
```

---

## 4. Inline Editable Ledger

### Scope

Account ledger pages only (`/accounts/[guid]`), not the general ledger.

### Keyboard-First Navigation

**Navigation mode** (default):
- **Up/Down arrows**: Move focus between transaction rows (visual focus indicator — subtle highlight)
- **Enter**: Begin editing the focused row (transforms to inline inputs)
- **`r`**: Toggle `reviewed` status of the focused row (for SimpleFin imports)
- **`n`**: Open new transaction form (existing shortcut)
- **Delete/Backspace**: Delete transaction (with confirmation)

**Edit mode** (after pressing Enter on a row):
- Row cells transform into inline input fields
- **Tab/Shift+Tab**: Move between fields (Date → Description → Account → Amount)
- **Enter**: Save changes and return to navigation mode
- **Escape**: Cancel edit, revert changes, return to navigation mode
- Date field supports all existing shortcuts (`+`/`-` increment/decrement, `t` for today)
- Description field has autocomplete (same as TransactionForm)
- Account field uses AccountSelector dropdown
- Amount field supports tax shortcut (Ctrl+T)

### Visual Indicators for Unreviewed Imports

- **Amber/yellow left border** on unreviewed rows
- Small "Imported" badge or icon next to description
- After editing and saving (or pressing `r`), the `reviewed` flag flips to `true` and highlight disappears
- **Filter toggle** at top: "Show unreviewed only" to quickly find imports needing attention

### Implementation

- New `InlineEditRow` component renders editable cells inside `<tr>`
- Shares form logic with existing `TransactionForm` (extract into shared hooks)
- Parent table tracks: `focusedRowIndex` (navigation) and `editingRowGuid` (edit mode)
- Only one row editable at a time

---

## 5. Tax Rate Bug Fix

### Root Cause

In `settings/page.tsx` line 316, the input value is:
```tsx
value={defaultTaxRate > 0 ? (defaultTaxRate * 100).toFixed(2) : ''}
```

On every keystroke, `setDefaultTaxRate` triggers a re-render, reformatting the value (e.g., "6" → "6.00"), moving the cursor to the end.

### Fix

Use a local string state for the input:
- `taxRateInput` (string) — stores what the user types, unformatted
- `onChange`: update local state only (no formatting, no API call)
- `onBlur`: parse, validate, format, update context (which persists to API)
- On mount/context change: initialize local state from context value

Standard React controlled input pattern for formatted numeric fields.

---

## Implementation Order

1. **Tax rate bug fix** — Quick standalone fix, no dependencies
2. **Route security (middleware + RBAC tables)** — Foundation for everything else
3. **Landing page** — Depends on middleware (public route)
4. **New user workflow + Create Book** — Depends on RBAC (role assignment)
5. **Inline editable ledger** — Independent of SimpleFin, can be built in parallel
6. **SimpleFin integration** — Depends on RBAC + inline ledger for review workflow
7. **Nightly sync integration** — Depends on SimpleFin core

## Key Files to Create/Modify

**New files:**
- `middleware.ts` — Route protection
- `src/lib/services/permission.service.ts` — RBAC utilities
- `src/lib/templates/*.json` — Account hierarchy templates (personal, business, non-profit)
- `src/app/(public)/page.tsx` — Landing page
- `src/app/(main)/onboarding/page.tsx` — Onboarding page
- `src/app/(main)/settings/connections/page.tsx` — SimpleFin connections
- `src/lib/services/simplefin.service.ts` — SimpleFin API client
- `src/components/InlineEditRow.tsx` — Inline editable ledger row
- `src/app/api/simplefin/*` — SimpleFin API routes
- `src/app/api/books/route.ts` (POST handler) — Create book from template/import

**Modified files:**
- `src/lib/auth.ts` — Extended SessionData
- `src/lib/db-init.ts` — Create RBAC + SimpleFin tables
- `src/app/(main)/layout.tsx` — Auth check + onboarding redirect
- `src/app/(main)/settings/page.tsx` — Tax rate fix + SimpleFin schedule toggle
- `src/components/AccountLedger.tsx` — Inline editing + keyboard navigation
- `src/contexts/BookContext.tsx` — Book creation support
- All 58 unprotected API routes — Add `requireRole()` calls

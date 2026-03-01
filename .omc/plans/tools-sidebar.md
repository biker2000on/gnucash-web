# Work Plan: Tools Section in Sidebar (v2 - Revised)

## Context

### Original Request
Add a "Tools" section to the sidebar of the GnuCash Web app with three tools:
1. **FIRE Calculator** - Financial Independence / Retire Early calculator for testing retirement strategies
2. **Mortgage Calculator** - Link a GnuCash account as a mortgage, set interest rate, save to database
3. **Mortgage Payoff Calculator** - Estimate with extra payments how soon mortgage is paid off; given a target payoff date/year, calculate needed extra monthly payment

### Research Findings
- Sidebar is in `src/components/Layout.tsx` with a flat `navItems` array (lines 118-126) and `iconMap` registry (lines 104-112). Icons are inline SVG components.
- Extension tables follow the `gnucash_web_*` naming convention. The `gnucash_web_saved_reports` table with JSONB `config` column is the established pattern for storing user-scoped configuration.
- Migration pattern: `db-init.ts` uses `CREATE TABLE IF NOT EXISTS` and `ALTER TABLE` with `IF NOT EXISTS` guards inside `DO $$ ... $$` blocks.
- Prisma 7.3 schema at `prisma/schema.prisma` needs a matching model for the new table.
- Pages are `'use client'` components using `useState`/`useEffect`/`fetch()` or React Query hooks.
- API routes follow the pattern: auth check -> parse body -> validate -> service layer -> response.
- Reports hub page (`src/app/(main)/reports/page.tsx`) is a card-grid hub that links to sub-pages -- ideal model for the Tools hub.
- `useAccounts({ flat: true })` returns a flat list of all accounts suitable for an account selector dropdown.
- The `AccountSelector` component exists at `src/components/ui/AccountSelector.tsx` but does NOT currently accept an `accountTypes` filter prop. It excludes ROOT but shows all other types.
- Service layer pattern: **class-based with static methods + Zod schemas** (used by `AccountService`, `BudgetService`, `TransactionService`, `AuditService`).
- `/api/accounts/[guid]/info` returns hierarchy metadata only (name, fullname, account_type, commodity info, depth) -- it does NOT return balance data.
- `isAccountInActiveBook(guid)` from `src/lib/book-scope.ts` is the standard guard for account-scoped endpoints.
- `getActiveBookGuid()` from `src/lib/book-scope.ts` returns the current book GUID from session.
- Existing extension tables (`gnucash_web_saved_reports`) do NOT have a `book_guid` column -- this will be a new pattern for multi-book scoping of extension data.

### Revision History
- **v1**: Initial plan
- **v2**: Addressed 4 critical + 4 minor issues from Critic review (see Appendix A)

---

## Work Objectives

### Core Objective
Add a "Tools" section to the sidebar navigation that provides three financial planning calculators, with the mortgage calculator persisting account-linked configuration to the database, scoped per user and per book.

### Deliverables
1. New "Tools" nav item in sidebar with wrench/tool icon
2. Tools hub page at `/tools` with card grid linking to each tool
3. FIRE Calculator page at `/tools/fire-calculator` -- fully client-side, no API needed
4. Mortgage Calculator page at `/tools/mortgage` -- links GnuCash accounts, persists to DB
5. Mortgage Payoff Calculator tab/section on the mortgage page -- calculates payoff with extra payments
6. New `/api/accounts/[guid]/balance` endpoint for fetching account aggregate balance
7. New `gnucash_web_tool_config` database table + Prisma model (with `book_guid` column)
8. API routes for CRUD on tool configurations (book-scoped)
9. Service layer for tool config operations (class-based with static methods + Zod schemas)
10. `AccountSelector` enhancement with optional `accountTypes` filter prop

### Definition of Done
- All three tools are accessible from sidebar -> Tools
- FIRE calculator computes FI number, years to FI, and safe withdrawal income from user inputs
- Mortgage calculator allows selecting a GnuCash LIABILITY account, setting interest rate and term, and saves to database
- Mortgage payoff section shows amortization schedule with extra payments and reverse-calculates extra payment needed for a target payoff date
- All new pages follow existing codebase patterns (semantic CSS, client components, auth-gated API)
- Build passes (`npm run build`) with zero TypeScript errors
- Lint passes (`npm run lint`)

---

## Must Have / Must NOT Have (Guardrails)

### Must Have
- Wrench/tool icon in sidebar for "Tools" entry
- Tools hub page with cards for each tool
- FIRE Calculator: inputs for current savings, annual savings, annual expenses, expected return rate, safe withdrawal rate; outputs FI number, years to FI, projected annual income
- FIRE Calculator: exact Years to FI formula (see T8 details)
- Mortgage Calculator: account selector (filtered to LIABILITY accounts via `accountTypes` prop), interest rate, original loan amount, loan term; save/load from database per user per book
- Mortgage Payoff: amortization table with extra payment column; target date reverse-calculation using annuity payment formula
- Database persistence for mortgage configurations via `gnucash_web_tool_config` with `book_guid` column
- Auth-gated API routes
- New `/api/accounts/[guid]/balance` endpoint for aggregate balance
- Class-based service layer with static methods + Zod schemas (matching AccountService, BudgetService pattern)
- Consistent JSONB field naming between schema and component state

### Must NOT Have
- No write-back to GnuCash core tables (read-only access to accounts)
- No external API calls (all calculations are client-side math)
- No new npm dependencies (pure math, no financial libraries needed)
- No modification to existing GnuCash tables or views
- No SSR data fetching -- all pages are client components consistent with existing patterns
- No foreign key from `book_guid` to GnuCash `books` table (extension tables avoid FKs into core schema)
- No investment price logic in balance endpoint (mortgage = LIABILITY = CURRENCY, no price conversion needed)

---

## Database Schema Changes

### New Table: `gnucash_web_tool_config`

```sql
CREATE TABLE IF NOT EXISTS gnucash_web_tool_config (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES gnucash_web_users(id) ON DELETE CASCADE,
    book_guid VARCHAR(32) NOT NULL,         -- scoped to active book (NO FK to books table)
    tool_type VARCHAR(50) NOT NULL,         -- 'mortgage', 'fire', etc.
    name VARCHAR(255) NOT NULL,             -- user-given label, e.g. "Primary Mortgage"
    account_guid VARCHAR(32),              -- optional link to GnuCash account
    config JSONB NOT NULL DEFAULT '{}',    -- tool-specific configuration
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tool_config_user_id ON gnucash_web_tool_config(user_id);
CREATE INDEX IF NOT EXISTS idx_tool_config_tool_type ON gnucash_web_tool_config(tool_type);
CREATE INDEX IF NOT EXISTS idx_tool_config_user_book ON gnucash_web_tool_config(user_id, book_guid, tool_type);
```

**Mortgage config JSONB shape:**
```json
{
  "interestRate": 6.5,
  "originalAmount": 300000,
  "loanTermMonths": 360,
  "startDate": "2023-01-15",
  "extraPayment": 200
}
```

**FIRE config JSONB shape (optional, for saving scenarios):**
```json
{
  "currentSavings": 150000,
  "annualSavings": 30000,
  "annualExpenses": 50000,
  "expectedReturn": 7,
  "safeWithdrawalRate": 4,
  "inflationRate": 3
}
```

**CRITICAL: JSONB key names MUST match component state field names exactly.** The component `useState` fields for FIRE must use `currentSavings`, `annualSavings`, `annualExpenses`, `expectedReturn`, `safeWithdrawalRate`, `inflationRate` -- identical to the JSONB keys above. Same for mortgage: `interestRate`, `originalAmount`, `loanTermMonths`, `startDate`, `extraPayment`.

### Prisma Model Addition

```prisma
model gnucash_web_tool_config {
  id           Int       @id @default(autoincrement())
  user_id      Int?
  book_guid    String    @db.VarChar(32)
  tool_type    String    @db.VarChar(50)
  name         String    @db.VarChar(255)
  account_guid String?   @db.VarChar(32)
  config       Json      @default("{}")
  created_at   DateTime  @default(now())
  updated_at   DateTime  @updatedAt

  user         gnucash_web_users? @relation(fields: [user_id], references: [id], onDelete: Cascade)

  @@index([user_id, book_guid, tool_type])
}
```

### Migration in db-init.ts

Add a new `CREATE TABLE IF NOT EXISTS` block and an `updated_at` trigger following the saved_reports pattern.

---

## Task Flow and Dependencies

```
Phase 1: Database & Backend Foundation
  [T1] Schema + migration ──> [T2] Prisma model ──> [T3] Service layer (class-based) ──> [T4] API routes (import from service class)

Phase 2: Account Balance Endpoint (parallel with Phase 1, after T1)
  [T5] /api/accounts/[guid]/balance endpoint

Phase 3: Sidebar & Hub (can start in parallel with Phase 1 and 2)
  [T6] Sidebar icon + nav item
  [T7] Tools hub page
       NOTE: T7's "#payoff" card link depends on T10 being complete for the anchor to resolve.
             The link will be a dead anchor until T10 is done -- acceptable during development.

Phase 4: AccountSelector Enhancement (can start in parallel)
  [T8a] Add accountTypes filter prop to AccountSelector

Phase 5: FIRE Calculator (independent of Phase 1)
  [T8] FIRE calculator page + computation logic (exact formulas specified)

Phase 6: Mortgage Calculators (depends on Phase 1 + Phase 2 + Phase 3 + Phase 4)
  [T9] Mortgage calculator page (account linking via enhanced AccountSelector, save/load, balance from T5 endpoint)
  [T10] Mortgage payoff section (amortization + reverse calc with exact formula)

Phase 7: Verification
  [T11] Build + lint + manual verification
```

**Parallelism opportunities:**
- T6, T7 can run in parallel with T1-T4
- T5 can run in parallel with T2-T4 (only needs DB to exist)
- T8a can run in parallel with everything
- T8 can run in parallel with T1-T7 (no DB dependency for FIRE)
- T9 and T10 are sequential (T10 extends T9's page)
- T9 depends on T4 (API routes), T5 (balance endpoint), T8a (AccountSelector filter)

**Dependency graph (critical path):**
```
T1 -> T2 -> T3 -> T4 -> T9 -> T10 -> T11
                        T5 ──┘
                       T8a ──┘
```

---

## Detailed TODOs

### T1: Database Migration in db-init.ts
**File:** `src/lib/db-init.ts`
**What:** Add `gnucash_web_tool_config` table creation to `createExtensionTables()`
**Details:**
- Add `CREATE TABLE IF NOT EXISTS gnucash_web_tool_config` DDL with columns: id (SERIAL PK), user_id (FK to gnucash_web_users), book_guid (VARCHAR 32 NOT NULL -- NO foreign key to books table), tool_type (VARCHAR 50), name (VARCHAR 255), account_guid (VARCHAR 32 nullable), config (JSONB DEFAULT '{}'), created_at, updated_at
- Add indexes: `idx_tool_config_user_id` on (user_id), `idx_tool_config_tool_type` on (tool_type), `idx_tool_config_user_book` on (user_id, book_guid, tool_type)
- Add updated_at trigger following the `gnucash_web_saved_reports` pattern (reuse the existing `update_updated_at_column()` function if it exists, or create idempotently)
- Execute the DDL in the `createExtensionTables()` function

**Acceptance Criteria:**
- Table is created on app startup if it doesn't exist
- `book_guid` column is NOT NULL and has NO foreign key constraint
- Existing databases are not affected (idempotent migration)
- Composite index exists on (user_id, book_guid, tool_type)

---

### T2: Prisma Schema Model
**File:** `prisma/schema.prisma`
**What:** Add `gnucash_web_tool_config` model to the Extension Tables section
**Details:**
- Add model with fields matching the SQL DDL from T1 (including `book_guid`)
- Add `@@index([user_id, book_guid, tool_type])` composite index
- Add relation to `gnucash_web_users` (add `tool_configs gnucash_web_tool_config[]` relation field to `gnucash_web_users` model)
- Place after `gnucash_web_saved_reports` model

**Acceptance Criteria:**
- `npx prisma validate` passes
- Model matches the SQL table structure exactly (including book_guid)
- gnucash_web_users model has `tool_configs` relation field

---

### T3: Tool Config Service Layer (Class-Based)
**File:** `src/lib/services/tool-config.service.ts` (new file)
**What:** Create class-based service with static methods for tool config CRUD operations
**Pattern:** Follow `AccountService` / `BudgetService` pattern exactly: class with static async methods + Zod schemas at top of file
**Details:**

```typescript
// Zod schemas at module level
export const CreateToolConfigSchema = z.object({
  toolType: z.string().min(1).max(50),
  name: z.string().min(1).max(255),
  accountGuid: z.string().length(32).optional().nullable(),
  config: z.record(z.unknown()).default({}),
});

export const UpdateToolConfigSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  accountGuid: z.string().length(32).optional().nullable(),
  config: z.record(z.unknown()).optional(),
});

export class ToolConfigService {
  static async listByUser(userId: number, bookGuid: string, toolType?: string) { ... }
  static async getById(id: number, userId: number, bookGuid: string) { ... }
  static async create(userId: number, bookGuid: string, data: CreateToolConfigInput) { ... }
  static async update(id: number, userId: number, bookGuid: string, data: UpdateToolConfigInput) { ... }
  static async delete(id: number, userId: number, bookGuid: string) { ... }
}
```

- Every method takes `bookGuid` parameter and scopes all queries by `(user_id, book_guid)`
- `listByUser`: WHERE user_id = $userId AND book_guid = $bookGuid, optionally AND tool_type = $toolType
- `getById`: WHERE id = $id AND user_id = $userId AND book_guid = $bookGuid (ownership + book check)
- `create`: Insert with book_guid from parameter (injected server-side from `getActiveBookGuid()`)
- `update`/`delete`: Ownership + book check before mutation
- Use Zod schemas for input validation
- Export input types: `CreateToolConfigInput`, `UpdateToolConfigInput`

**Acceptance Criteria:**
- Class-based with static methods (NOT standalone functions)
- All five CRUD operations implemented
- Every query scoped by both user_id AND book_guid
- Ownership check prevents cross-user and cross-book access
- Zod validation on inputs

---

### T4: API Routes for Tool Configs
**Files:**
- `src/app/api/tools/config/route.ts` (GET list, POST create)
- `src/app/api/tools/config/[id]/route.ts` (GET one, PUT update, DELETE)

**What:** REST API for tool config CRUD
**Pattern:** Import from `ToolConfigService` class (NOT standalone functions). Follow auth -> validate -> service -> response pattern.
**Details:**
- Every route handler calls `getActiveBookGuid()` from `@/lib/book-scope` and passes it to the service
- GET `/api/tools/config?toolType=mortgage` - list configs for current user + active book
- POST `/api/tools/config` - create new config; body: { toolType, name, accountGuid?, config }; book_guid injected server-side
- GET `/api/tools/config/[id]` - get single config (scoped by user + book)
- PUT `/api/tools/config/[id]` - update config (scoped by user + book)
- DELETE `/api/tools/config/[id]` - delete config (scoped by user + book)
- All routes: auth check via `getCurrentUser()`, 401 if not authenticated

```typescript
// Example pattern for each route handler:
import { ToolConfigService } from '@/lib/services/tool-config.service';
import { getActiveBookGuid } from '@/lib/book-scope';
import { getCurrentUser } from '@/lib/auth';

export async function GET(request: Request) {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const bookGuid = await getActiveBookGuid();
    const configs = await ToolConfigService.listByUser(user.id, bookGuid, toolType);
    // ...
}
```

**Acceptance Criteria:**
- All five endpoints return correct HTTP status codes
- Auth check on every endpoint
- book_guid injected server-side (never from client request body)
- Validation errors return 400 with descriptive message
- Successful create returns 201

---

### T5: Account Balance API Endpoint
**File:** `src/app/api/accounts/[guid]/balance/route.ts` (new file)
**What:** New endpoint that returns aggregate balance for a single account
**Why:** The existing `/api/accounts/[guid]/info` endpoint returns only hierarchy metadata, NOT balance data. The mortgage calculator needs the current account balance to show how much has been paid down.
**Details:**

```typescript
import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { isAccountInActiveBook } from '@/lib/book-scope';

export async function GET(
    request: Request,
    { params }: { params: Promise<{ guid: string }> }
) {
    const { guid } = await params;
    const { searchParams } = new URL(request.url);
    const asOfDate = searchParams.get('asOfDate'); // optional: ISO date string

    // Guard: verify account belongs to active book
    if (!await isAccountInActiveBook(guid)) {
        return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }

    // Aggregate query for total balance
    let result;
    if (asOfDate) {
        result = await prisma.$queryRaw<[{ total_balance: string }]>`
            SELECT COALESCE(SUM(
                CAST(s.quantity_num AS DECIMAL) / CAST(s.quantity_denom AS DECIMAL)
            ), 0)::text as total_balance
            FROM splits s
            JOIN transactions t ON s.tx_guid = t.guid
            WHERE s.account_guid = ${guid}
            AND t.post_date <= ${asOfDate}::timestamp
        `;
    } else {
        result = await prisma.$queryRaw<[{ total_balance: string }]>`
            SELECT COALESCE(SUM(
                CAST(s.quantity_num AS DECIMAL) / CAST(s.quantity_denom AS DECIMAL)
            ), 0)::text as total_balance
            FROM splits s
            JOIN transactions t ON s.tx_guid = t.guid
            WHERE s.account_guid = ${guid}
        `;
    }

    return NextResponse.json({
        guid,
        total_balance: result[0].total_balance,
        as_of: asOfDate || new Date().toISOString(),
    });
}
```

- Uses `isAccountInActiveBook(guid)` guard (same as `/api/accounts/[guid]/info`)
- Returns `{ guid, total_balance, as_of }`
- Optional `asOfDate` query param for historical balance (ISO date string)
- NO investment price logic (mortgage accounts are LIABILITY/CURRENCY -- no price conversion needed)
- Auth is implicitly handled by `isAccountInActiveBook` which reads the session

**Acceptance Criteria:**
- GET `/api/accounts/[guid]/balance` returns correct aggregate balance
- GET `/api/accounts/[guid]/balance?asOfDate=2025-01-01` returns historical balance
- Returns 404 if account not in active book
- Returns numeric string for total_balance (avoids floating point issues)

---

### T6: Sidebar Icon and Nav Item
**File:** `src/components/Layout.tsx`
**What:** Add "Tools" entry to sidebar navigation
**Details:**
- Add new `IconWrench` SVG component (wrench icon, matching existing icon style: `fill="none"`, `stroke="currentColor"`, `strokeWidth={1.8}`, `viewBox="0 0 24 24"`)
- SVG path: wrench shape (standard wrench outline path)
- Register `Wrench: IconWrench` in `iconMap`
- Add `{ name: 'Tools', href: '/tools', icon: 'Wrench' }` to `navItems` array (after Import/Export, i.e. last item)

**Acceptance Criteria:**
- "Tools" appears in both desktop and mobile sidebar
- Icon renders correctly at 20x20
- Active state highlights when on `/tools` or `/tools/*` paths
- Tooltip shows "Tools" when sidebar is collapsed

---

### T7: Tools Hub Page
**File:** `src/app/(main)/tools/page.tsx` (new file)
**What:** Hub page with card grid linking to each tool
**Details:**
- Follow the Reports hub page pattern (`src/app/(main)/reports/page.tsx`)
- Header: "Tools" title + "Financial planning and analysis tools." subtitle
- Three cards in a responsive grid (sm:grid-cols-2 lg:grid-cols-3):
  1. **FIRE Calculator** - icon: flame/fire, description: "Calculate your Financial Independence number and estimate years to retirement."
     - Links to `/tools/fire-calculator`
  2. **Mortgage Calculator** - icon: house, description: "Link your mortgage account and track loan details with interest rate configuration."
     - Links to `/tools/mortgage`
  3. **Mortgage Payoff** - icon: calendar/target, description: "Estimate payoff timeline with extra payments or calculate the payment needed for a target date."
     - Links to `/tools/mortgage#payoff`
     - **NOTE:** The `#payoff` anchor only resolves after T10 is complete. During development, this link will navigate to the mortgage page but will not scroll to the payoff section until T10 adds the `id="payoff"` element.
- Cards use the same styling: `bg-surface/30 backdrop-blur-xl border border-border rounded-xl p-6 hover:border-cyan-500/50`
- Inline SVG icons in each card (no external library)

**Acceptance Criteria:**
- Page renders at `/tools`
- Three cards visible with correct descriptions
- Cards link to correct paths
- Responsive grid layout matches reports hub

---

### T8a: AccountSelector Enhancement
**File:** `src/components/ui/AccountSelector.tsx`
**What:** Add optional `accountTypes` filter prop to restrict displayed account types
**Details:**
- Add `accountTypes?: string[]` to `AccountSelectorProps` interface
- In the `filteredAccounts` computation, when `accountTypes` is provided, add filter: `accountTypes.includes(account.account_type)`
- When `accountTypes` is NOT provided, behavior is unchanged (show all except ROOT)
- This allows the mortgage calculator to pass `accountTypes={['LIABILITY']}` to only show liability accounts

```typescript
interface AccountSelectorProps {
    value: string;
    onChange: (accountGuid: string, accountName: string) => void;
    placeholder?: string;
    disabled?: boolean;
    className?: string;
    hasError?: boolean;
    accountTypes?: string[];  // NEW: optional filter by account type
}

// In filteredAccounts:
const filteredAccounts = accounts.filter(account => {
    if (account.account_type === 'ROOT') return false;
    if (accountTypes && !accountTypes.includes(account.account_type)) return false;
    // ... existing search filter logic
});
```

**Acceptance Criteria:**
- Existing usage without `accountTypes` prop is unaffected
- When `accountTypes={['LIABILITY']}` is passed, only LIABILITY accounts appear
- TypeScript types are correct (optional string array)

---

### T8: FIRE Calculator Page
**File:** `src/app/(main)/tools/fire-calculator/page.tsx` (new file)
**What:** Client-side FIRE calculator with no database dependency
**Details:**
- `'use client'` component
- **Input fields** (with labels and reasonable defaults):
  - Current age (number, default: 30)
  - Target retirement age (number, default: 55, optional -- can also compute)
  - Current savings/investments (currency, default: 0)
  - Annual savings rate (currency, default: 0)
  - Annual expenses (currency, default: 50000)
  - Expected annual investment return (%, default: 7)
  - Safe withdrawal rate (%, default: 4)
  - Expected inflation rate (%, default: 3)
- **Outputs** (calculated on every input change, no submit button):
  - **FI Number** = annualExpenses / (safeWithdrawalRate / 100)
  - **Years to FI** = exact formula (see below)
  - **FI Age** = currentAge + yearsToFI
  - **Annual income at FI** = fiNumber * (safeWithdrawalRate / 100)
  - **Monthly income at FI** = annualIncome / 12
  - **Progress bar** showing currentSavings / fiNumber as percentage

- **EXACT Years to FI Formula:**
  ```
  Let:
    FI = FI Number (target portfolio value)
    P  = currentSavings (present value)
    C  = annualSavings (annual contribution)
    r  = expectedReturn / 100 (annual return rate as decimal)

  If r == 0:
    n = (FI - P) / C

  If r != 0:
    n = ln((FI * r + C) / (P * r + C)) / ln(1 + r)
  ```

  With **inflation toggle ON**, use real return rate instead:
  ```
  r_real = (1 + r_nominal) / (1 + r_inflation) - 1
  ```
  Then substitute r_real for r in the formula above.

  **Edge cases:**
  - If P >= FI: yearsToFI = 0 (already at FI)
  - If C == 0 and r == 0: yearsToFI = Infinity (can never reach FI)
  - If the formula result is negative: yearsToFI = 0
  - If the formula result is NaN: display "N/A"

- **Projection chart** (recommended): line chart showing savings growth over time using recharts (already a project dependency at v3.7)
  - X-axis: years, Y-axis: portfolio value
  - Horizontal line at FI Number
- **Inflation toggle**: show nominal vs real (inflation-adjusted) values
- **JSONB field naming**: Component state field names MUST match FIRE config JSONB keys exactly: `currentSavings`, `annualSavings`, `annualExpenses`, `expectedReturn`, `safeWithdrawalRate`, `inflationRate`
- All math is pure client-side JavaScript, no API calls
- Use semantic CSS classes consistent with the rest of the app

**Acceptance Criteria:**
- All inputs render with sensible defaults
- Outputs update reactively as inputs change
- FI number = expenses / SWR is correct
- Years to FI uses the exact logarithmic formula specified above
- Inflation toggle switches between nominal and real return rates
- Edge cases handled (already at FI, zero savings, zero return)
- Page works without database or authentication

---

### T9: Mortgage Calculator Page
**File:** `src/app/(main)/tools/mortgage/page.tsx` (new file)
**What:** Mortgage calculator with account linking and database persistence
**Details:**
- `'use client'` component
- **Saved Mortgages section** (top of page):
  - On mount, fetch `GET /api/tools/config?toolType=mortgage`
  - Display saved mortgage configs as cards
  - Each card shows: name, linked account name, interest rate, original amount
  - Click card to load its config into the calculator form
  - Delete button on each card
- **Calculator Form**:
  - Name (text input, for labeling the saved config)
  - Account selector: use existing `AccountSelector` component WITH `accountTypes={['LIABILITY']}` prop (from T8a)
  - Original loan amount (currency input)
  - Annual interest rate (% input, e.g. 6.5)
  - Loan term (select: 10, 15, 20, 25, 30 years -- or custom months input)
  - Loan start date (date input)
  - Monthly extra payment (currency input, default: 0)
  - "Save" button -> `POST /api/tools/config` or `PUT /api/tools/config/[id]` if editing
- **Calculator Output**:
  - Monthly payment (P&I) = standard amortization formula: `M = P * [r(1+r)^n] / [(1+r)^n - 1]` where P = principal, r = monthly rate, n = total months
  - Total interest over life of loan
  - Total amount paid
  - If account is linked: fetch current balance from **`GET /api/accounts/[guid]/balance`** (T5 endpoint) and compute remaining principal
- **JSONB field naming**: Component state field names MUST match mortgage config JSONB keys exactly: `interestRate`, `originalAmount`, `loanTermMonths`, `startDate`, `extraPayment`
- **Integration with actual GnuCash data**: When an account is linked, fetch the account's balance via `/api/accounts/[guid]/balance` to show how much has been paid down vs. amortization schedule

**Acceptance Criteria:**
- Can create, save, load, and delete mortgage configurations
- Account selector shows ONLY LIABILITY accounts (via `accountTypes` prop)
- Monthly payment calculation matches standard amortization formula
- Saved configs persist across page reloads
- Current balance fetched from `/api/accounts/[guid]/balance` (NOT `/api/accounts/[guid]/info`)
- Configs are scoped to current book (switching books shows different configs)

---

### T10: Mortgage Payoff Section
**File:** Same as T9: `src/app/(main)/tools/mortgage/page.tsx` (extends the page)
**What:** Payoff estimator and reverse calculator, rendered as a section below the main mortgage calculator
**Details:**
- **Section header**: "Payoff Calculator" with an `id="payoff"` anchor
- **Mode toggle**: two tabs/buttons
  1. "Extra Payment -> Payoff Date" (default)
  2. "Target Date -> Required Payment"
- **Mode 1: Extra Payment -> Payoff Date**
  - Inputs pre-filled from the mortgage calculator above (principal, rate, term)
  - Extra monthly payment input (separate from the one above, or linked)
  - Output:
    - Original payoff date (without extra payments)
    - New payoff date (with extra payments)
    - Time saved (years and months)
    - Interest saved (dollar amount)
    - **Amortization table**: Month | Payment | Principal | Interest | Extra | Remaining Balance
    - Table should be scrollable with sticky header, showing all months
    - Highlight the payoff month
  - **Amortization math** (iterative month-by-month):
    ```
    for each month:
      interest = balance * monthlyRate
      principalPortion = basePayment - interest + extraPayment
      balance = balance - principalPortion
      if balance <= 0: paid off (adjust final payment)
    ```

- **Mode 2: Target Date -> Required Payment**
  - Input: Target payoff date (month/year picker or "payoff in X years" slider)
  - **EXACT Reverse Calculation Formula** (annuity payment formula solved for PMT):
    ```
    Let:
      PV = remaining balance (current principal)
      r  = monthly interest rate (annual rate / 12 / 100)
      n  = months until target payoff date

    Required total monthly payment:
      PMT = PV * r / (1 - (1 + r)^(-n))

    Required extra payment:
      extra = PMT - baseMonthlyPayment

    Where baseMonthlyPayment is the standard amortization payment from the mortgage calculator.
    ```

    **Edge cases:**
    - If n <= 0: display error "Target date must be in the future"
    - If extra < 0: display "No extra payment needed -- standard payments pay off before target"
    - If r == 0: PMT = PV / n (simple division, no interest)

  - Output:
    - Required total monthly payment (PMT)
    - Required extra monthly payment (PMT - basePayment)
    - Interest saved vs. original schedule
    - Comparison summary: Original vs. Accelerated (payoff date, total interest, total paid)
- All calculations are client-side

**Acceptance Criteria:**
- Both modes work and toggle correctly
- Amortization table renders correctly with all months
- "Extra Payment -> Payoff Date" correctly computes savings via iterative method
- "Target Date -> Required Payment" uses the exact annuity formula `PMT = PV * r / (1 - (1+r)^(-n))`
- Edge cases: extra payment larger than remaining balance, already paid off, zero balance, target date in past
- Anchor link from tools hub (`#payoff`) scrolls to this section

---

### T11: Verification
**What:** Build, lint, and manual verification
**Details:**
- Run `npm run build` -- must pass with zero errors
- Run `npm run lint` -- must pass
- Verify sidebar shows "Tools" item in both desktop and mobile views
- Verify tools hub page renders three cards
- Verify FIRE calculator computes correctly with known inputs (see Success Criteria)
- Verify mortgage calculator saves to and loads from database
- Verify amortization table renders and payoff calculations are accurate
- Verify book scoping: switch books and verify tool configs are isolated
- Verify AccountSelector shows only LIABILITY accounts in mortgage calculator
- Verify `/api/accounts/[guid]/balance` returns correct balance

**Acceptance Criteria:**
- Zero build errors
- Zero lint errors
- All three tools are functional end-to-end
- Book-scoped configs verified

---

## File Manifest

### New Files
| File | Purpose | Task |
|------|---------|------|
| `src/app/(main)/tools/page.tsx` | Tools hub page | T7 |
| `src/app/(main)/tools/fire-calculator/page.tsx` | FIRE calculator | T8 |
| `src/app/(main)/tools/mortgage/page.tsx` | Mortgage calculator + payoff | T9, T10 |
| `src/app/api/tools/config/route.ts` | API: list + create tool configs | T4 |
| `src/app/api/tools/config/[id]/route.ts` | API: get + update + delete tool config | T4 |
| `src/app/api/accounts/[guid]/balance/route.ts` | API: aggregate account balance | T5 |
| `src/lib/services/tool-config.service.ts` | Class-based service for tool config CRUD | T3 |

### Modified Files
| File | Change | Task |
|------|--------|------|
| `src/components/Layout.tsx` | Add IconWrench, iconMap entry, navItems entry | T6 |
| `src/lib/db-init.ts` | Add tool_config table creation + trigger (with book_guid) | T1 |
| `prisma/schema.prisma` | Add gnucash_web_tool_config model + relation on users | T2 |
| `src/components/ui/AccountSelector.tsx` | Add optional `accountTypes?: string[]` filter prop | T8a |

---

## Risk Identification

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Prisma schema out of sync with DB migration | Medium | High | Run `npx prisma validate` after schema change; `db-init.ts` migration is idempotent |
| AccountSelector `accountTypes` prop breaks existing usage | Low | High | Prop is optional with no default -- existing callers unaffected |
| Amortization floating-point drift | Low | Low | Use `Math.round()` to nearest cent in each iteration; display with `toFixed(2)` |
| `gnucash_web_users` model missing `tool_configs` relation | Low | Medium | Add the relation field in the same schema change (T2) |
| FIRE projection chart depends on recharts | Low | Low | recharts 3.7 is already in project dependencies; graceful fallback to no chart if import fails |
| Sidebar getting crowded with 8 items | Low | Low | Wrench icon is visually distinct; consider a divider/separator before "Tools" in future |
| Balance endpoint returns incorrect sign for liabilities | Medium | Medium | GnuCash liabilities are stored with negative splits -- document that the returned value will be negative for liabilities |
| Book switching shows stale tool configs | Low | Medium | All queries scoped by book_guid from session; switching books via BookSwitcher naturally changes the scope |

---

## Commit Strategy

| Commit | Tasks | Message |
|--------|-------|---------|
| 1 | T1, T2 | `feat: add gnucash_web_tool_config table with book_guid scoping` |
| 2 | T3, T4 | `feat: add tool config service and API routes (class-based, book-scoped)` |
| 3 | T5 | `feat: add account balance aggregate API endpoint` |
| 4 | T6, T7 | `feat: add Tools section to sidebar with hub page` |
| 5 | T8a | `feat: add accountTypes filter prop to AccountSelector` |
| 6 | T8 | `feat: add FIRE calculator tool with exact FI formula` |
| 7 | T9, T10 | `feat: add mortgage calculator with payoff estimator` |

---

## Success Criteria

1. **Sidebar**: "Tools" item visible and functional in desktop + mobile
2. **Navigation**: Hub page -> each tool page works correctly
3. **FIRE Calculator**: Correctly computes FI number and years to FI for known test inputs:
   - $50k expenses at 4% SWR = $1.25M FI number
   - $100k savings, $30k annual savings, 7% return, $1.25M target = ~14.2 years
4. **Mortgage Calculator**: Can save a mortgage config, reload page, and load it back; configs are book-scoped
5. **Mortgage Payoff Mode 1**: For a $300k loan at 6.5% over 30 years, $500/month extra correctly shows ~14 years saved
6. **Mortgage Payoff Mode 2**: For a $300k loan at 6.5%, target payoff in 15 years: PMT = 300000 * 0.005417 / (1 - 1.005417^-180) = ~$2,613/month
7. **Account Balance**: `/api/accounts/[guid]/balance` returns correct aggregate for a known account
8. **Book Scoping**: Switching books shows different saved tool configs
9. **Build**: `npm run build` exits 0
10. **Lint**: `npm run lint` exits 0

---

## Appendix A: Critic Feedback Applied (v2)

| Issue | Type | Resolution |
|-------|------|------------|
| C1: T8 references wrong API for balance | Critical | Added new T5: `/api/accounts/[guid]/balance/route.ts` with aggregate query and `isAccountInActiveBook` guard. T9 now references this endpoint. |
| C2: Conflicting service patterns T3 vs T4 | Critical | Standardized on class-based service with static methods + Zod schemas (matching AccountService, BudgetService). T4 imports from service class. |
| C3: Years to FI formula underspecified | Critical | Added exact formula: `n = ln((FI*r + C) / (P*r + C)) / ln(1+r)` with real return rate for inflation toggle. Edge cases specified. |
| C4: T9 Mode 2 reverse calc has no algorithm | Critical | Added exact annuity formula: `PMT = PV * r / (1 - (1+r)^(-n))` with edge cases for n<=0, negative extra, zero rate. |
| M1: AccountSelector has no filter prop | Minor | Added T8a task to add `accountTypes?: string[]` optional prop. T9 passes `accountTypes={['LIABILITY']}`. |
| M2: Book scoping unaddressed | Minor | Added `book_guid VARCHAR(32) NOT NULL` column (no FK). Composite index. All CRUD scoped by book_guid from `getActiveBookGuid()`. |
| M3: FIRE config JSONB naming inconsistency | Minor | Added explicit note: component state fields MUST match JSONB keys exactly. Listed all field names. |
| M4: T6 #payoff link depends on T10 | Minor | Added note in T7 that `#payoff` anchor only resolves after T10 is complete. |

# Report Configuration System - Implementation Plan

## Context

### Original Request
Build a general-purpose report configuration system for GnuCash Web that allows users to save, star, and manage custom report configurations. The immediate driver is making the Treasurer Report's account selection configurable (currently hardcoded to `ASSET`, `BANK`, `CASH`), but the system should be extensible to all 6 report types.

### Interview Summary
- **Scope**: Full CRUD for saved report configurations, starring system, and Treasurer Report account picker
- **Database Pattern**: Raw SQL migrations via `src/lib/db-init.ts` (cannot use `prisma db push` due to GnuCash FK constraints)
- **Auth Pattern**: Uses `getCurrentUser()` from `src/lib/auth.ts` with iron-session cookies
- **API Pattern**: Next.js App Router route handlers returning `NextResponse.json()`
- **UI Pattern**: Tailwind CSS with the project's dark-theme design system (`bg-surface/30`, `border-border`, `text-cyan-400` accents)
- **Component Pattern**: Reuses `Modal` from `src/components/ui/Modal.tsx`, existing `AccountPickerModal` in `src/components/budget/AccountPickerModal.tsx` provides the tree-with-search pattern

### Research Findings
- **Existing DB tables**: `gnucash_web_users` (with `id`, `username`, `password_hash`, `balance_reversal`) and `gnucash_web_audit`
- **Existing migration pattern**: `CREATE TABLE IF NOT EXISTS` + `DO $$ BEGIN ... END $$` blocks for column additions, all in `createExtensionTables()` function in `src/lib/db-init.ts`
- **Prisma schema**: Extension tables are modeled in `prisma/schema.prisma` for type safety even though migrations are manual
- **Treasurer Report API** (`src/app/api/reports/treasurer/route.ts`): `computeBalances()` hardcodes `account_type: { in: ['ASSET', 'BANK', 'CASH'] }` at line 54
- **Treasurer Report page** (`src/app/(main)/reports/treasurer/page.tsx`): Uses localStorage for header config (org, role, person name) at lines 24-37
- **Reports index** (`src/app/(main)/reports/page.tsx`): Static cards from `REPORTS` array, grouped by category
- **ReportViewer** (`src/components/reports/ReportViewer.tsx`): Shared wrapper with print/CSV, accepts `children` for custom content
- **AccountPickerModal** (`src/components/budget/AccountPickerModal.tsx`): Full tree with expand/collapse, search, depth-based indentation - this is the pattern to adapt for multi-select

---

## Work Objectives

### Core Objective
Implement a database-backed report configuration system with CRUD API, starring, and a configurable Treasurer Report with user-selectable accounts.

### Deliverables
1. New `gnucash_web_saved_reports` database table with JSONB config storage
2. Full CRUD + star toggle REST API for saved reports
3. Service layer for saved report operations
4. Reports index page redesign with starred, saved, and base report sections
5. Save/load report dialog components
6. Multi-select account picker component (adapted from budget AccountPickerModal)
7. Treasurer Report integration: configurable accounts, migrate from localStorage to DB
8. TypeScript interfaces and Prisma schema updates

### Definition of Done
- [ ] `gnucash_web_saved_reports` table auto-created on app startup
- [ ] All 6 API endpoints return correct responses with proper auth checks
- [ ] Reports index page shows starred reports at top, saved reports in middle, base reports at bottom
- [ ] Users can save any report configuration with name, description, and type-specific config
- [ ] Users can star/unstar saved reports
- [ ] Users can edit and delete saved reports
- [ ] Treasurer Report has an account picker that replaces hardcoded `['ASSET', 'BANK', 'CASH']`
- [ ] Treasurer Report header config (org, role, person) saves to DB instead of localStorage
- [ ] Existing localStorage config is auto-migrated to DB on first load
- [ ] `npm run build` passes with zero TypeScript errors
- [ ] All API endpoints handle unauthenticated requests with 401

---

## Must Have / Must NOT Have

### Must Have
- Raw SQL migration (not prisma db push)
- User-scoped saved reports (user_id FK to gnucash_web_users)
- JSONB config column for report-specific settings
- Star/favorite toggle
- Treasurer Report account picker with multi-select tree
- Auth checks on all API endpoints

### Must NOT Have
- Configuration UI for report types other than Treasurer (Phase 4 / future work)
- Drag-and-drop report ordering
- Report sharing between users
- Report export/import
- Report scheduling or auto-generation

---

## Task Flow and Dependencies

```
Phase 1: Database & Types (no dependencies)
  Task 1.1: DB migration
  Task 1.2: Prisma schema
  Task 1.3: TypeScript interfaces
  Task 1.4: Service layer

Phase 2: API Layer (depends on Phase 1)
  Task 2.1: CRUD API routes
  Task 2.2: Star toggle API route

Phase 3: UI Components (depends on Phase 1 types)
  Task 3.1: SavedReportCard component
  Task 3.2: SaveReportDialog component
  Task 3.3: AccountPicker multi-select component

Phase 4: Page Integration (depends on Phases 2 + 3)
  Task 4.1: Reports index page redesign
  Task 4.2: Treasurer Report config integration
  Task 4.3: Treasurer API - accept account GUIDs
```

---

## Detailed TODOs

### Task 1.1: Database Migration

**File to modify**: `C:\Users\biker\projects\gnucash-web\src\lib\db-init.ts`

**What to do**: Add a new `CREATE TABLE IF NOT EXISTS` statement and an `updated_at` trigger inside the `createExtensionTables()` function (after the `addBooksColumnsDDL` execution, before the success log).

**SQL to add**:
```sql
CREATE TABLE IF NOT EXISTS gnucash_web_saved_reports (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES gnucash_web_users(id) ON DELETE CASCADE,
    base_report_type VARCHAR(50) NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    config JSONB NOT NULL DEFAULT '{}',
    filters JSONB,
    is_starred BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

Also add an index for fast user lookups:
```sql
CREATE INDEX IF NOT EXISTS idx_saved_reports_user_id ON gnucash_web_saved_reports(user_id);
```

And an auto-update trigger for `updated_at`:
```sql
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'update_saved_reports_updated_at'
    ) THEN
        CREATE OR REPLACE FUNCTION update_updated_at_column()
        RETURNS TRIGGER AS $func$
        BEGIN
            NEW.updated_at = CURRENT_TIMESTAMP;
            RETURN NEW;
        END;
        $func$ LANGUAGE plpgsql;

        CREATE TRIGGER update_saved_reports_updated_at
        BEFORE UPDATE ON gnucash_web_saved_reports
        FOR EACH ROW
        EXECUTE FUNCTION update_updated_at_column();
    END IF;
END $$;
```

**Implementation detail**: Follow the existing pattern - declare the DDL as a const string, then `await query(ddl)` after the books columns migration. Keep the `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` patterns so the migration is idempotent.

**Acceptance criteria**:
- [ ] Table is created on app startup (check server logs for success message)
- [ ] Running `initializeDatabase()` multiple times is safe (idempotent)
- [ ] FK constraint to `gnucash_web_users(id)` with `ON DELETE CASCADE`
- [ ] `config` column defaults to empty JSON object `{}`
- [ ] `updated_at` auto-updates on row modification

---

### Task 1.2: Prisma Schema Update

**File to modify**: `C:\Users\biker\projects\gnucash-web\prisma\schema.prisma`

**What to do**: Add the `gnucash_web_saved_reports` model in the "Extension Tables" section (after `gnucash_web_audit`), and add a relation from `gnucash_web_users`.

**Model to add**:
```prisma
model gnucash_web_saved_reports {
  id               Int       @id @default(autoincrement())
  user_id          Int?
  base_report_type String    @db.VarChar(50)
  name             String    @db.VarChar(255)
  description      String?   @db.Text
  config           Json      @default("{}")
  filters          Json?
  is_starred       Boolean   @default(false)
  created_at       DateTime  @default(now())
  updated_at       DateTime  @updatedAt

  // Relations
  user             gnucash_web_users? @relation(fields: [user_id], references: [id], onDelete: Cascade)
}
```

**Also modify** the `gnucash_web_users` model to add the reverse relation:
```prisma
// Add this line to the gnucash_web_users model:
saved_reports    gnucash_web_saved_reports[]
```

After editing, run `npx prisma generate` to regenerate the client types.

**Acceptance criteria**:
- [ ] `npx prisma generate` completes without errors
- [ ] `prisma.gnucash_web_saved_reports` is available with full type safety
- [ ] Relation from users to saved_reports works for includes/joins

---

### Task 1.3: TypeScript Interfaces

**File to modify**: `C:\Users\biker\projects\gnucash-web\src\lib\reports\types.ts`

**What to add** (after the existing `TreasurerReportData` interface, before `getReportsByCategory`):

```typescript
/** Saved report configuration stored in the database */
export interface SavedReport {
  id: number;
  userId: number;
  baseReportType: ReportType;
  name: string;
  description: string | null;
  config: Record<string, unknown>;
  filters: ReportFilters | null;
  isStarred: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Treasurer-specific config stored in SavedReport.config */
export interface TreasurerReportConfig {
  accountGuids?: string[];
  accountTypes?: string[];
  organization?: string;
  roleName?: string;
  personName?: string;
}

/** Input for creating/updating a saved report */
export interface SavedReportInput {
  baseReportType: ReportType;
  name: string;
  description?: string;
  config: Record<string, unknown>;
  filters?: ReportFilters;
  isStarred?: boolean;
}
```

**Acceptance criteria**:
- [ ] All interfaces export correctly
- [ ] `SavedReport` maps cleanly to the DB schema (camelCase)
- [ ] `TreasurerReportConfig` covers all current localStorage fields plus new `accountGuids`/`accountTypes`
- [ ] `SavedReportInput` is the input type for create/update (no `id`, `userId`, timestamps)

---

### Task 1.4: Service Layer

**New file**: `C:\Users\biker\projects\gnucash-web\src\lib\reports\saved-reports.ts`

**What to do**: Create a service module that wraps Prisma calls for saved report CRUD. All functions take `userId` as a parameter (the API layer handles auth).

**Functions to implement**:

```typescript
import prisma from '@/lib/prisma';
import { SavedReport, SavedReportInput, ReportType } from './types';

// Helper to convert DB row to SavedReport interface
function toSavedReport(row: any): SavedReport { ... }

// List all saved reports for a user, starred first, then by updated_at desc
export async function listSavedReports(userId: number): Promise<SavedReport[]> { ... }

// Get a single saved report by ID (validates ownership)
export async function getSavedReport(id: number, userId: number): Promise<SavedReport | null> { ... }

// Create a new saved report
export async function createSavedReport(userId: number, input: SavedReportInput): Promise<SavedReport> { ... }

// Update an existing saved report (validates ownership)
export async function updateSavedReport(id: number, userId: number, input: Partial<SavedReportInput>): Promise<SavedReport | null> { ... }

// Delete a saved report (validates ownership)
export async function deleteSavedReport(id: number, userId: number): Promise<boolean> { ... }

// Toggle star status
export async function toggleStar(id: number, userId: number): Promise<{ isStarred: boolean } | null> { ... }

// Get starred reports for a user (for the reports index page)
export async function getStarredReports(userId: number): Promise<SavedReport[]> { ... }
```

**Implementation details**:
- Use `prisma.gnucash_web_saved_reports.findMany/findUnique/create/update/delete`
- Every mutation validates `user_id` matches the authenticated user (ownership check)
- `listSavedReports` orders by `is_starred DESC, updated_at DESC`
- `toSavedReport` converts snake_case DB fields to camelCase interface
- Validate `base_report_type` against `ReportType` enum values
- **JSONB validation**: In `createSavedReport` and `updateSavedReport`, validate that `config` is a non-null plain object (not a string, array, or primitive). Reject with an error if invalid.
- **updated_at**: Explicitly set `updated_at: new Date()` in every `update()` call (belt-and-suspenders with the DB trigger)

**Acceptance criteria**:
- [ ] All 7 functions implemented with proper Prisma calls
- [ ] Ownership validation on get/update/delete (return null if user_id mismatch)
- [ ] `listSavedReports` returns starred reports first
- [ ] `createSavedReport` validates that `baseReportType` is a valid `ReportType`
- [ ] `createSavedReport` rejects non-object `config` values (string, array, null)
- [ ] `toggleStar` flips the boolean and returns the new state

---

### Task 2.1: CRUD API Routes

**New file**: `C:\Users\biker\projects\gnucash-web\src\app\api\reports\saved\route.ts`

**Endpoints**: `GET /api/reports/saved` and `POST /api/reports/saved`

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { listSavedReports, createSavedReport } from '@/lib/reports/saved-reports';

export async function GET() {
    // 1. Auth check via getCurrentUser()
    // 2. Call listSavedReports(user.id)
    // 3. Return JSON array
}

export async function POST(request: NextRequest) {
    // 1. Auth check
    // 2. Parse body: { baseReportType, name, description?, config, filters?, isStarred? }
    // 3. Validate required fields (name, baseReportType)
    // 4. Call createSavedReport(user.id, input)
    // 5. Return 201 with created report
}
```

**New file**: `C:\Users\biker\projects\gnucash-web\src\app\api\reports\saved\[id]\route.ts`

**Endpoints**: `GET /api/reports/saved/:id`, `PUT /api/reports/saved/:id`, `DELETE /api/reports/saved/:id`

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { getSavedReport, updateSavedReport, deleteSavedReport } from '@/lib/reports/saved-reports';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    // 1. Auth check
    // 2. Parse id from params (await params, parseInt)
    // 3. Call getSavedReport(id, user.id)
    // 4. Return 404 if not found/not owned
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    // 1. Auth check
    // 2. Parse id and body
    // 3. Call updateSavedReport(id, user.id, input)
    // 4. Return 404 if not found/not owned
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    // 1. Auth check
    // 2. Parse id
    // 3. Call deleteSavedReport(id, user.id)
    // 4. Return 204 on success, 404 if not found
}
```

**IMPORTANT**: In Next.js 16, route handler params are accessed via `const { id } = await params;` (params is a Promise). Follow this pattern from the existing codebase.

**Acceptance criteria**:
- [ ] All endpoints return 401 for unauthenticated requests
- [ ] GET `/api/reports/saved` returns array of saved reports for current user
- [ ] POST returns 201 with the created report, 400 if name or baseReportType missing
- [ ] GET by ID returns 404 if report doesn't exist or belongs to another user
- [ ] PUT updates and returns the updated report
- [ ] DELETE returns 204 (no body) on success
- [ ] All error responses use `{ error: string }` format

---

### Task 2.2: Star Toggle API Route

**New file**: `C:\Users\biker\projects\gnucash-web\src\app\api\reports\saved\[id]\star\route.ts`

**Endpoint**: `PATCH /api/reports/saved/:id/star`

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { toggleStar } from '@/lib/reports/saved-reports';

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    // 1. Auth check
    // 2. Parse id
    // 3. Call toggleStar(id, user.id)
    // 4. Return { isStarred: boolean }
    // 5. 404 if not found/not owned
}
```

**Acceptance criteria**:
- [ ] PATCH toggles `is_starred` boolean (true -> false, false -> true)
- [ ] Returns `{ isStarred: boolean }` with the new value
- [ ] Returns 401 if not authenticated, 404 if not found/not owned

---

### Task 3.1: SavedReportCard Component

**New file**: `C:\Users\biker\projects\gnucash-web\src\components\reports\SavedReportCard.tsx`

**What to do**: Create a card component for saved reports that shows on the reports index page. Similar styling to the existing `ReportCard` in `src/app/(main)/reports/page.tsx` but with additional actions.

**Props**:
```typescript
interface SavedReportCardProps {
    report: SavedReport;
    onToggleStar: (id: number) => void;
    onEdit: (report: SavedReport) => void;
    onDelete: (id: number) => void;
}
```

**UI elements**:
- Star button (filled/outlined star icon, top-right)
- Report name (clickable, links to `/reports/{baseReportType}?savedId={id}`)
  - **NOTE**: Only Treasurer type currently supports `?savedId` loading. For other report types, the card should link to the base report page without `savedId` and show a subtle "(config saved for future use)" label. This avoids broken UX where clicking a saved Balance Sheet ignores the config.
- Description text (truncated to 2 lines)
- Base report type badge (small pill, e.g., "Treasurer", "Balance Sheet")
- Edit button (pencil icon)
- Delete button (trash icon, with confirmation)
- "Last updated" timestamp in relative time

**Styling**: Match the existing card style - `bg-surface/30 backdrop-blur-xl border border-border rounded-xl p-6 hover:border-cyan-500/50`

**Acceptance criteria**:
- [ ] Card renders with all required elements
- [ ] Star button visually toggles between filled and outlined
- [ ] Click on Treasurer card name navigates with `?savedId={id}` query param
- [ ] Click on non-Treasurer card name navigates to base report (no savedId) with subtle indicator
- [ ] Edit and delete buttons call their respective callbacks
- [ ] Delete button shows an inline "Are you sure?" confirmation before calling onDelete
- [ ] Base report type is displayed as a colored badge

---

### Task 3.2: SaveReportDialog Component

**New file**: `C:\Users\biker\projects\gnucash-web\src\components\reports\SaveReportDialog.tsx`

**What to do**: Modal dialog for saving/editing a report configuration. Uses the existing `Modal` from `src/components/ui/Modal.tsx`.

**Props**:
```typescript
interface SaveReportDialogProps {
    isOpen: boolean;
    onClose: () => void;
    onSave: (input: SavedReportInput) => Promise<void>;
    baseReportType: ReportType;
    existingReport?: SavedReport | null;  // null = create, populated = edit
    currentConfig: Record<string, unknown>;  // the current report configuration state
    currentFilters?: ReportFilters;
}
```

**UI elements**:
- Name input (required, max 255 chars)
- Description textarea (optional)
- "Star this report" checkbox
- Preview of what config will be saved (read-only JSON summary, collapsible)
- Save / Cancel buttons

**Behavior**:
- When `existingReport` is provided, pre-fill name/description and show "Update" instead of "Save"
- Validates name is not empty before allowing save
- Calls `onSave` with the assembled `SavedReportInput`
- Shows loading state on the save button during API call
- Closes on successful save

**Acceptance criteria**:
- [ ] Modal opens/closes properly
- [ ] Name field is required, shows validation error if empty
- [ ] In edit mode, fields are pre-populated
- [ ] Save button shows spinner during save
- [ ] After successful save, modal closes and parent is notified
- [ ] Config and filters from current report state are included in the saved data

---

### Task 3.3: AccountPicker Multi-Select Component

**New file**: `C:\Users\biker\projects\gnucash-web\src\components\reports\AccountPicker.tsx`

**What to do**: A multi-select account tree component adapted from `src/components/budget/AccountPickerModal.tsx`. This is NOT a modal - it's an inline component that renders within the Treasurer Report config section.

**Props**:
```typescript
interface AccountPickerProps {
    selectedGuids: string[];
    onChange: (guids: string[]) => void;
    allowedAccountTypes?: string[];  // filter which types show, e.g., ['ASSET', 'BANK', 'CASH']
    placeholder?: string;
}
```

**UI elements**:
- Compact summary showing count of selected accounts (e.g., "3 accounts selected") with expand/collapse
- When expanded:
  - Search input at top
  - "Select All / Deselect All" buttons
  - Quick-select buttons by account type (e.g., "All ASSET", "All BANK", "All CASH")
  - Tree view with checkboxes (adapted from AccountPickerModal's tree logic)
  - Each row: checkbox + indent + account name + account type badge
  - Expand/collapse for parent accounts
- Selected accounts are shown as removable chips/tags below the tree when collapsed

**Implementation approach**:
1. Fetch accounts from `/api/accounts?flat=true` (same as AccountPickerModal)
2. Build tree structure using the same parent_guid logic from AccountPickerModal
3. Add checkbox state management: `selectedGuids` is the source of truth
4. Checking a parent should NOT auto-check children (user picks individual accounts)
5. Filter by `allowedAccountTypes` if provided (show only matching account types in the tree)

**Styling**: Consistent with `AccountPickerModal` tree indentation and expand/collapse, but with checkboxes instead of "add" buttons. Max height of tree: `max-h-64 overflow-y-auto`.

**Acceptance criteria**:
- [ ] Renders as an inline component (not a modal)
- [ ] Shows expandable tree with checkboxes for each account
- [ ] Search filters the tree to matching accounts
- [ ] "Select All" and "Deselect All" work correctly
- [ ] Quick-select by account type toggles all accounts of that type
- [ ] `onChange` fires with updated GUID array whenever selection changes
- [ ] When collapsed, shows summary count and removable chips for selected accounts
- [ ] Works with `allowedAccountTypes` filter to restrict visible accounts
- [ ] Handles empty state gracefully (no accounts found)

---

### Task 4.1: Reports Index Page Redesign

**File to modify**: `C:\Users\biker\projects\gnucash-web\src\app\(main)\reports\page.tsx`

**What to do**: Restructure the page into three sections:
1. **Starred Reports** (top) - Only shown if user has starred reports
2. **Saved Reports** (middle) - Only shown if user has saved reports, with search
3. **All Reports** (bottom) - The existing category-grouped base reports

**Implementation details**:
- Fetch saved reports on mount via `GET /api/reports/saved`
- Separate starred from non-starred reports for display
- Add a search input above saved reports section to filter by name
- Import and use `SavedReportCard` for saved reports
- Handle star toggle by calling `PATCH /api/reports/saved/:id/star` and updating local state
- Handle delete by calling `DELETE /api/reports/saved/:id` and removing from local state
- Handle edit by opening `SaveReportDialog` with the selected report

**Page layout**:
```
[header: "Reports" + description]

--- Starred Reports (if any) ---
[grid of SavedReportCards for starred reports]

--- Your Saved Reports (if any) ---
[search input]
[grid of SavedReportCards for non-starred reports]

--- Financial Statements ---
[existing ReportCard grid]

--- Account Reports ---
[existing ReportCard grid]

--- Transaction Reports ---
[existing ReportCard grid]
```

**Handle unauthenticated state**: If `GET /api/reports/saved` returns 401, don't show saved/starred sections at all (just show base reports as before).

**Acceptance criteria**:
- [ ] Starred reports section appears at top when user has starred reports
- [ ] Starred section hidden when no starred reports exist
- [ ] Saved reports section shows non-starred saved reports with search
- [ ] Saved section hidden when no saved reports exist
- [ ] Search filters saved reports by name (client-side)
- [ ] Star toggle updates UI immediately (optimistic update)
- [ ] Delete removes card from UI with confirmation
- [ ] Edit opens SaveReportDialog
- [ ] Base reports section unchanged from current behavior
- [ ] Page works for unauthenticated users (just shows base reports)

---

### Task 4.2: Treasurer Report Config Integration

**File to modify**: `C:\Users\biker\projects\gnucash-web\src\app\(main)\reports\treasurer\page.tsx`

**What to do**:
1. Add the AccountPicker component for selecting which accounts appear in opening/closing balance
2. Add a "Save Report" button that opens SaveReportDialog
3. Load saved config from DB when `?savedId=N` query param is present
4. Migrate existing localStorage config to the new system
5. Pass selected account GUIDs to the API

**Changes in detail**:

**A. URL param reading (IMPORTANT: Next.js 16 pattern):**
- Import `useSearchParams` from `'next/navigation'` and `Suspense` from `'react'`
- Create an inner component `TreasurerReportContent` that uses `useSearchParams()`
- Wrap with `<Suspense>` in the default export (required by Next.js 16 for `useSearchParams`)
```typescript
import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';

function TreasurerReportContent() {
    const searchParams = useSearchParams();
    const savedIdParam = searchParams.get('savedId');
    // ... all existing component logic moves here
}

export default function TreasurerReportPage() {
    return (
        <Suspense fallback={<div>Loading...</div>}>
            <TreasurerReportContent />
        </Suspense>
    );
}
```

**B. State management updates:**
- Add `selectedAccountGuids: string[]` state (default: empty = use all ASSET/BANK/CASH)
- Add `savedReportId: number | null` state (populated from `savedIdParam`)
- Add `isSaveDialogOpen: boolean` state

**C. Config section expansion:**
- Below the existing header config (organization, role, person name), add the AccountPicker
- Default caption: "Account Selection - By default, all Asset, Bank, and Cash accounts are included"
- When accounts are explicitly selected, pass them as `accountGuids` query param to API

**D. Save/Load logic:**
- On mount, check `savedIdParam` from `useSearchParams()`
- If present, fetch `GET /api/reports/saved/${savedIdParam}` and populate:
  - `config.organization` -> organization field
  - `config.roleName` -> role field
  - `config.personName` -> person name field
  - `config.accountGuids` -> selectedAccountGuids
  - `config.accountTypes` -> (optional future use)
  - `filters` -> date range
- Add "Save Configuration" button in the config section header
- On save, collect current config + filters into SavedReportInput

**Concrete JSX for SaveReportDialog wiring:**
```tsx
<SaveReportDialog
    isOpen={isSaveDialogOpen}
    onClose={() => setIsSaveDialogOpen(false)}
    onSave={handleSaveReport}
    baseReportType={ReportType.TREASURER}
    existingReport={savedReportId ? currentSavedReport : null}
    currentConfig={{
        organization: config.organization,
        roleName: config.roleName,
        personName: config.personName,
        accountGuids: selectedAccountGuids,
    }}
    currentFilters={filters}
/>
```

**E. localStorage migration:**
- On first load, if localStorage has `treasurer-report-config` AND no `savedId` param:
  - Read the localStorage value
  - Apply it to the form fields
  - Show a dismissible banner (inline div with close button, not a toast system):
    ```tsx
    {migrationBanner && (
        <div className="flex items-center justify-between px-4 py-3 bg-cyan-500/10 border border-cyan-500/30 rounded-lg text-sm text-cyan-400">
            <span>Previous configuration loaded. Click &quot;Save Configuration&quot; to keep it permanently.</span>
            <button onClick={() => setMigrationBanner(false)} className="ml-2 text-cyan-400/60 hover:text-cyan-400">&times;</button>
        </div>
    )}
    ```
  - Clear the localStorage key after applying values

**F. API call update:**
- When fetching the report, include selected account GUIDs:
  ```typescript
  if (selectedAccountGuids.length > 0) {
      params.set('accountGuids', selectedAccountGuids.join(','));
  }
  ```

**Acceptance criteria**:
- [ ] AccountPicker renders in the config section below header fields
- [ ] Default behavior (no accounts selected) matches current behavior (all ASSET/BANK/CASH)
- [ ] Selecting specific accounts passes them to the API and only those accounts appear in report
- [ ] "Save Configuration" button opens SaveReportDialog
- [ ] Loading page with `?savedId=N` populates all fields from DB
- [ ] localStorage config is auto-migrated on first load
- [ ] Config section is collapsible (matching existing pattern)

---

### Task 4.3: Treasurer API - Accept Account GUIDs

**File to modify**: `C:\Users\biker\projects\gnucash-web\src\app\api\reports\treasurer\route.ts`

**What to do**: Modify the `GET` handler and `computeBalances` function to accept optional account GUIDs from query params.

**Changes**:

**A. Parse new query param in GET handler** (around line 234):
```typescript
const accountGuidsParam = searchParams.get('accountGuids');
const customAccountGuids = accountGuidsParam
    ? accountGuidsParam.split(',').filter(g => g.trim())
    : null;
```

**B. Modify `computeBalances` function** to accept optional custom account filter:

Change signature from:
```typescript
async function computeBalances(
    bookAccountGuids: string[],
    asOfDate: Date,
    baseCurrencyGuid: string
)
```
To:
```typescript
async function computeBalances(
    bookAccountGuids: string[],
    asOfDate: Date,
    baseCurrencyGuid: string,
    customAccountGuids?: string[] | null
)
```

**C. Update the Prisma query** in `computeBalances` (line 51-57):

When `customAccountGuids` is provided and non-empty, filter by explicit GUIDs **intersected with book scope** to prevent cross-book data leakage:
```typescript
// CRITICAL: Always intersect custom GUIDs with bookAccountGuids for data isolation
const validGuids = customAccountGuids && customAccountGuids.length > 0
    ? customAccountGuids.filter(g => bookAccountGuids.includes(g))
    : null;

const whereClause = validGuids && validGuids.length > 0
    ? {
        guid: { in: validGuids },
        hidden: 0,
        placeholder: 0,
      }
    : {
        guid: { in: bookAccountGuids },
        account_type: { in: ['ASSET', 'BANK', 'CASH'] },
        hidden: 0,
        placeholder: 0,
      };

const assetAccounts = await prisma.accounts.findMany({
    where: whereClause,
    select: { guid: true, name: true, commodity_guid: true },
});
```

**D. Pass the custom GUIDs** in the GET handler calls to `computeBalances`:
```typescript
const openingBalance = await computeBalances(bookAccountGuids, openingCutoff, baseCurrencyGuid, customAccountGuids);
const closingBalance = await computeBalances(bookAccountGuids, endDate, baseCurrencyGuid, customAccountGuids);
```

**Acceptance criteria**:
- [ ] Without `accountGuids` param, behavior is identical to current (ASSET/BANK/CASH)
- [ ] With `accountGuids=guid1,guid2,guid3`, only those specific accounts are used for balances
- [ ] Custom GUIDs still respect book scoping (only if they're in `bookAccountGuids`)
- [ ] Empty `accountGuids` param is treated as "use defaults"
- [ ] API response format is unchanged

---

## Commit Strategy

### Commit 1: Database & Types (Tasks 1.1, 1.2, 1.3)
Files: `src/lib/db-init.ts`, `prisma/schema.prisma`, `src/lib/reports/types.ts`
Message: `feat(reports): add saved reports database table and TypeScript types`

### Commit 2: Service Layer (Task 1.4)
Files: `src/lib/reports/saved-reports.ts`
Message: `feat(reports): add saved reports service layer with CRUD operations`

### Commit 3: API Routes (Tasks 2.1, 2.2)
Files: `src/app/api/reports/saved/route.ts`, `src/app/api/reports/saved/[id]/route.ts`, `src/app/api/reports/saved/[id]/star/route.ts`
Message: `feat(reports): add REST API for saved report CRUD and starring`

### Commit 4: UI Components (Tasks 3.1, 3.2, 3.3)
Files: `src/components/reports/SavedReportCard.tsx`, `src/components/reports/SaveReportDialog.tsx`, `src/components/reports/AccountPicker.tsx`
Message: `feat(reports): add SavedReportCard, SaveReportDialog, and AccountPicker components`

### Commit 5: Reports Page Redesign (Task 4.1)
Files: `src/app/(main)/reports/page.tsx`
Message: `feat(reports): redesign reports page with starred and saved report sections`

### Commit 6: Treasurer Report Integration (Tasks 4.2, 4.3)
Files: `src/app/(main)/reports/treasurer/page.tsx`, `src/app/api/reports/treasurer/route.ts`
Message: `feat(treasurer): add configurable account selection and save-to-DB support`

---

## Success Criteria

1. **Database**: `gnucash_web_saved_reports` table is created on app startup, idempotently
2. **API**: All 6 endpoints work with correct auth, validation, and ownership checks
3. **Reports Page**: Shows starred -> saved -> base reports in correct order
4. **Starring**: Users can star/unstar reports; starred reports appear at top
5. **Save/Load**: Users can save report configurations and load them back
6. **Treasurer Accounts**: Users can select specific accounts for the Treasurer Report balance sections
7. **Migration**: Existing localStorage Treasurer config is seamlessly migrated to DB
8. **Build**: `npm run build` passes with zero errors
9. **Backward Compatibility**: Default Treasurer Report behavior (ASSET/BANK/CASH) is preserved when no custom accounts selected

---

## File Reference Summary

### Files to Modify
| File | Task | Changes |
|------|------|---------|
| `src/lib/db-init.ts` | 1.1 | Add CREATE TABLE + index + trigger for saved_reports |
| `prisma/schema.prisma` | 1.2 | Add gnucash_web_saved_reports model + relation |
| `src/lib/reports/types.ts` | 1.3 | Add SavedReport, TreasurerReportConfig, SavedReportInput interfaces |
| `src/app/(main)/reports/page.tsx` | 4.1 | Redesign with starred/saved/base sections |
| `src/app/(main)/reports/treasurer/page.tsx` | 4.2 | Add AccountPicker, save/load, migrate localStorage |
| `src/app/api/reports/treasurer/route.ts` | 4.3 | Accept accountGuids param in computeBalances |

### Files to Create
| File | Task | Purpose |
|------|------|---------|
| `src/lib/reports/saved-reports.ts` | 1.4 | Service layer for saved report CRUD |
| `src/app/api/reports/saved/route.ts` | 2.1 | GET list + POST create |
| `src/app/api/reports/saved/[id]/route.ts` | 2.1 | GET + PUT + DELETE by ID |
| `src/app/api/reports/saved/[id]/star/route.ts` | 2.2 | PATCH star toggle |
| `src/components/reports/SavedReportCard.tsx` | 3.1 | Card UI for saved reports |
| `src/components/reports/SaveReportDialog.tsx` | 3.2 | Save/edit dialog modal |
| `src/components/reports/AccountPicker.tsx` | 3.3 | Multi-select account tree |

### Reference Files (read-only, for pattern reference)
| File | Used For |
|------|----------|
| `src/lib/auth.ts` | `getCurrentUser()` pattern for auth checks |
| `src/lib/prisma.ts` | Extended Prisma client singleton |
| `src/components/ui/Modal.tsx` | Modal component for SaveReportDialog |
| `src/components/budget/AccountPickerModal.tsx` | Tree building + expand/collapse pattern for AccountPicker |
| `src/components/ui/AccountSelector.tsx` | Dropdown + search pattern reference |
| `src/app/api/user/preferences/route.ts` | Auth check + PATCH pattern reference |
| `src/app/api/books/route.ts` | GET list + POST create pattern reference |

---

## Design Decisions (from Architect/Critic Review)

### `config` vs `filters` Column Distinction
- **`config`**: Report-type-specific settings that define WHAT the report shows. For Treasurer: `{ accountGuids, accountTypes, organization, roleName, personName }`. For future Balance Sheet: `{ showSubAccounts, depth }`.
- **`filters`**: Date range and display toggles from `ReportFilters`: `{ startDate, endDate, compareToPrevious }`. These are the temporal/display params that the `ReportFilters` component controls.
- **Rule**: `bookAccountGuids` should NOT be saved in filters (it's session-derived from active book, not user preference).

### Saved Report Type Scope
- The DB schema and API support saving configs for ANY report type.
- Only the **Treasurer Report** has UI integration for loading saved configs via `?savedId=N` in this phase.
- SavedReportCard shows all saved reports but only links with `?savedId` for treasurer type. Other types show "config saved for future use" indicator.

### Book Scoping Security
- Custom `accountGuids` passed to the Treasurer API MUST be intersected with `bookAccountGuids` to prevent cross-book data leakage.
- The service layer does not enforce book scoping (it stores whatever GUIDs the user selected). The API layer enforces it at query time.

### Prisma @updatedAt vs DB Trigger
- Both are used (belt-and-suspenders): Prisma's `@updatedAt` handles ORM operations, DB trigger handles raw SQL.
- The trigger function `update_updated_at_column()` is intentionally generic for reuse by future extension tables.

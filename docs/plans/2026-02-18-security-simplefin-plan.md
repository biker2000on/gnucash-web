# Security, SimpleFin, Onboarding & Ledger — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Lock down all routes behind auth, add full RBAC, build a feature landing page, create an onboarding wizard for new users, integrate SimpleFin for bank transaction import, add inline editable rows to account ledgers, and fix the tax rate input bug.

**Architecture:** Next.js middleware for authentication, handler-level RBAC with a permission service, SimpleFin Bridge REST API polling with encrypted credential storage, and keyboard-navigable inline editing in account ledger table rows.

**Tech Stack:** Next.js 16, React 19, TypeScript, Prisma 7 (raw SQL for schema), iron-session, SimpleFin Bridge REST API, existing dark-themed UI components.

**Design doc:** `docs/plans/2026-02-18-security-simplefin-design.md`

---

## Phase 1: Tax Rate Bug Fix

Quick standalone fix — no dependencies.

### Task 1.1: Fix tax rate input cursor jump

**Files:**
- Modify: `src/app/(main)/settings/page.tsx:299-343`

**Problem:** The `value` prop recalculates `(defaultTaxRate * 100).toFixed(2)` on every render, moving cursor to end after each keystroke.

**Step 1: Add local state for tax rate input**

At the top of the component (after line 33), add:
```typescript
const [taxRateInput, setTaxRateInput] = useState('');
```

Add a useEffect to sync from context (after the index coverage useEffect):
```typescript
// Sync tax rate input from context
useEffect(() => {
  if (defaultTaxRate > 0) {
    setTaxRateInput((defaultTaxRate * 100).toString());
  } else {
    setTaxRateInput('');
  }
}, []); // Only on mount — don't re-sync on every context change
```

**Step 2: Replace the input element**

Replace the `<input type="number" ... />` block (lines 311-327) with:
```tsx
<input
  type="number"
  step="0.01"
  min="0"
  max="100"
  value={taxRateInput}
  onChange={(e) => setTaxRateInput(e.target.value)}
  onBlur={() => {
    const pct = parseFloat(taxRateInput);
    if (!isNaN(pct) && pct >= 0 && pct <= 100) {
      setDefaultTaxRate(pct / 100);
    } else if (taxRateInput === '') {
      setDefaultTaxRate(0);
    }
  }}
  placeholder="0.00"
  className="w-32 bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-cyan-500/50"
/>
```

**Step 3: Fix the help text**

The help text (lines 330-340) says "Ctrl+T" but the actual shortcut is just `t` (changed in commit `d86c9f7`). Update the keyboard hint to match:
```tsx
<p className="text-xs text-foreground-muted">
  Press{' '}
  <kbd className="px-1.5 py-0.5 bg-background-tertiary rounded border border-border-hover text-xs">
    T
  </kbd>{' '}
  in amount fields to apply this tax rate to the current value.
</p>
```

**Step 4: Verify**

Run: `npm run build`
Expected: Clean build, no TypeScript errors.

**Step 5: Manual test**

Open Settings page → Tax Rate field. Type "6.75" — cursor should NOT jump. Tab away → value persists.

**Step 6: Commit**

```bash
git add src/app/\(main\)/settings/page.tsx
git commit -m "fix: tax rate input cursor jump on keystroke"
```

---

## Phase 2: Authentication Middleware

Foundation for all security features.

### Task 2.1: Create Next.js middleware for route protection

**Files:**
- Create: `src/middleware.ts`
- Reference: `src/lib/auth.ts` (session config)

**Step 1: Create the middleware**

```typescript
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getIronSession } from 'iron-session';
import { cookies } from 'next/headers';

export const runtime = 'nodejs'; // Required for iron-session compatibility

interface SessionData {
  userId?: number;
  username?: string;
  isLoggedIn: boolean;
  activeBookGuid?: string;
}

const sessionOptions = {
  password: process.env.SESSION_SECRET || 'complex_password_at_least_32_characters_long_12345',
  cookieName: 'gnucash_web_session',
  cookieOptions: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax' as const,
    maxAge: 60 * 60 * 24,
  },
};

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Public API routes — no auth required
  if (pathname.startsWith('/api/auth/')) {
    return NextResponse.next();
  }

  // Protected API routes — return 401 if not authenticated
  if (pathname.startsWith('/api/')) {
    const cookieStore = await cookies();
    const session = await getIronSession<SessionData>(cookieStore, sessionOptions);

    if (!session.isLoggedIn || !session.userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    return NextResponse.next();
  }

  // Protected page routes — redirect to login
  const cookieStore = await cookies();
  const session = await getIronSession<SessionData>(cookieStore, sessionOptions);

  if (!session.isLoggedIn || !session.userId) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('redirect', pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Match all paths except:
     * - / (landing page, public)
     * - /login (auth page)
     * - /_next (Next.js internals)
     * - /icon.svg (favicon)
     * - Static files (.ico, .png, .jpg, .svg, etc.)
     */
    '/((?!_next|login|icon\\.svg|favicon\\.ico|.*\\.(?:png|jpg|jpeg|gif|svg|webp|woff2?|ttf|css|js)$)(?!$).*)',
  ],
};
```

**Note on matcher:** The regex `(?!$)` ensures the root path `/` (empty string after stripping the leading `/`) is excluded, keeping the landing page public.

**Step 2: Test middleware locally**

1. Start dev server: `npm run dev`
2. Open incognito browser → navigate to `http://localhost:3000/accounts` → should redirect to `/login`
3. Call `curl http://localhost:3000/api/accounts` → should return `{"error":"Unauthorized"}` with 401
4. Call `curl http://localhost:3000/api/auth/login` → should NOT be blocked (public)
5. Navigate to `http://localhost:3000/` → should show current page (landing page, public)

**Step 3: Verify build**

Run: `npm run build`
Expected: Clean build.

**Step 4: Commit**

```bash
git add src/middleware.ts
git commit -m "feat: add auth middleware to protect all routes"
```

### Task 2.2: Support redirect back after login

**Files:**
- Modify: `src/app/login/page.tsx`
- Modify: `src/components/LoginForm.tsx`

**Step 1: Read the redirect param and pass it through**

In `login/page.tsx`, read the `redirect` search param and pass it to LoginForm. After successful auth check (line 18), redirect to the `redirect` param instead of hardcoded `/accounts`:

```typescript
const searchParams = useSearchParams();
const redirectTo = searchParams.get('redirect') || '/accounts';

// In the useEffect:
router.push(redirectTo);
```

In `LoginForm.tsx`, after successful login, redirect to the same param.

**Step 2: Commit**

```bash
git add src/app/login/page.tsx src/components/LoginForm.tsx
git commit -m "feat: redirect to original page after login"
```

---

## Phase 3: RBAC Database Schema & Permission Service

### Task 3.1: Add RBAC tables to db-init.ts

**Files:**
- Modify: `src/lib/db-init.ts` (follow existing `createExtensionTables()` pattern)

**Step 1: Add DDL constants**

Add after the existing table DDLs (around line 270):

```typescript
const ROLES_TABLE = `
CREATE TABLE IF NOT EXISTS gnucash_web_roles (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) UNIQUE NOT NULL,
    description TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Seed default roles
INSERT INTO gnucash_web_roles (name, description)
VALUES
    ('readonly', 'View-only access to book data and reports'),
    ('edit', 'Can create, edit, and delete transactions, budgets, and accounts'),
    ('admin', 'Full access including user management and book administration')
ON CONFLICT (name) DO NOTHING;
`;

const BOOK_PERMISSIONS_TABLE = `
CREATE TABLE IF NOT EXISTS gnucash_web_book_permissions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES gnucash_web_users(id) ON DELETE CASCADE,
    book_guid VARCHAR(32) NOT NULL,
    role_id INTEGER NOT NULL REFERENCES gnucash_web_roles(id),
    granted_by INTEGER REFERENCES gnucash_web_users(id) ON DELETE SET NULL,
    granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, book_guid)
);
CREATE INDEX IF NOT EXISTS idx_bp_user_book ON gnucash_web_book_permissions(user_id, book_guid);
CREATE INDEX IF NOT EXISTS idx_bp_book_role ON gnucash_web_book_permissions(book_guid, role_id);
`;

const INVITATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS gnucash_web_invitations (
    id SERIAL PRIMARY KEY,
    code VARCHAR(64) UNIQUE NOT NULL,
    book_guid VARCHAR(32) NOT NULL,
    role_id INTEGER NOT NULL REFERENCES gnucash_web_roles(id),
    created_by INTEGER NOT NULL REFERENCES gnucash_web_users(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NOT NULL,
    used_by INTEGER REFERENCES gnucash_web_users(id) ON DELETE SET NULL,
    used_at TIMESTAMP,
    max_uses INTEGER DEFAULT 1,
    use_count INTEGER DEFAULT 0,
    is_revoked BOOLEAN DEFAULT FALSE,
    revoked_by INTEGER REFERENCES gnucash_web_users(id) ON DELETE SET NULL,
    revoked_at TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_inv_code ON gnucash_web_invitations(code);
CREATE INDEX IF NOT EXISTS idx_inv_book ON gnucash_web_invitations(book_guid, is_revoked);
`;
```

**Step 2: Execute the DDLs in `createExtensionTables()`**

Add to the sequential execution block (around line 285):
```typescript
await query(ROLES_TABLE);
await query(BOOK_PERMISSIONS_TABLE);
await query(INVITATIONS_TABLE);
```

**Step 3: Add auto-migration for existing users**

After the table creation, add a backfill that grants `admin` on all books to all users who have no permissions yet:

```typescript
// Backfill: grant admin on all books to existing users with no permissions
await query(`
  INSERT INTO gnucash_web_book_permissions (user_id, book_guid, role_id, granted_by, granted_at)
  SELECT u.id, b.guid,
    (SELECT id FROM gnucash_web_roles WHERE name = 'admin'),
    u.id, NOW()
  FROM gnucash_web_users u
  CROSS JOIN books b
  WHERE NOT EXISTS (
    SELECT 1 FROM gnucash_web_book_permissions bp
    WHERE bp.user_id = u.id AND bp.book_guid = b.guid
  )
  ON CONFLICT (user_id, book_guid) DO NOTHING;
`);
```

**Step 4: Verify**

Run: `npm run build` — should pass.
Start dev server → check logs for "Extension tables created/verified successfully".

**Step 5: Commit**

```bash
git add src/lib/db-init.ts
git commit -m "feat: add RBAC tables (roles, book_permissions, invitations)"
```

### Task 3.2: Create permission service

**Files:**
- Create: `src/lib/services/permission.service.ts`

**Step 1: Implement the permission service**

```typescript
import prisma from '@/lib/prisma';

export type Role = 'readonly' | 'edit' | 'admin';

const ROLE_HIERARCHY: Record<Role, number> = {
  readonly: 0,
  edit: 1,
  admin: 2,
};

/**
 * Get a user's role for a specific book.
 */
export async function getUserRoleForBook(
  userId: number,
  bookGuid: string
): Promise<Role | null> {
  const permission = await prisma.$queryRaw<{ name: string }[]>`
    SELECT r.name
    FROM gnucash_web_book_permissions bp
    JOIN gnucash_web_roles r ON r.id = bp.role_id
    WHERE bp.user_id = ${userId} AND bp.book_guid = ${bookGuid}
    LIMIT 1
  `;
  return (permission[0]?.name as Role) ?? null;
}

/**
 * Check if a user has at least the minimum required role for a book.
 */
export async function hasMinimumRole(
  userId: number,
  bookGuid: string,
  minimumRole: Role
): Promise<boolean> {
  const userRole = await getUserRoleForBook(userId, bookGuid);
  if (!userRole) return false;
  return ROLE_HIERARCHY[userRole] >= ROLE_HIERARCHY[minimumRole];
}

/**
 * Get all books a user has access to, with their role.
 */
export async function getUserBooks(
  userId: number
): Promise<{ guid: string; name: string; role: Role }[]> {
  const rows = await prisma.$queryRaw<{ guid: string; name: string; role: string }[]>`
    SELECT b.guid, COALESCE(b.name, 'Unnamed Book') as name, r.name as role
    FROM gnucash_web_book_permissions bp
    JOIN books b ON b.guid = bp.book_guid
    JOIN gnucash_web_roles r ON r.id = bp.role_id
    WHERE bp.user_id = ${userId}
    ORDER BY b.name
  `;
  return rows.map(r => ({ ...r, role: r.role as Role }));
}

/**
 * Grant a role to a user for a book.
 */
export async function grantRole(
  userId: number,
  bookGuid: string,
  role: Role,
  grantedBy: number
): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO gnucash_web_book_permissions (user_id, book_guid, role_id, granted_by, granted_at)
    VALUES (
      ${userId}, ${bookGuid},
      (SELECT id FROM gnucash_web_roles WHERE name = ${role}),
      ${grantedBy}, NOW()
    )
    ON CONFLICT (user_id, book_guid)
    DO UPDATE SET role_id = (SELECT id FROM gnucash_web_roles WHERE name = ${role}),
                  granted_by = ${grantedBy},
                  granted_at = NOW()
  `;
}

/**
 * Revoke a user's access to a book.
 */
export async function revokeAccess(
  userId: number,
  bookGuid: string
): Promise<void> {
  await prisma.$executeRaw`
    DELETE FROM gnucash_web_book_permissions
    WHERE user_id = ${userId} AND book_guid = ${bookGuid}
  `;
}
```

**Step 2: Commit**

```bash
git add src/lib/services/permission.service.ts
git commit -m "feat: add permission service for RBAC checks"
```

### Task 3.3: Create requireAuth and requireRole helpers

**Files:**
- Modify: `src/lib/auth.ts`

**Step 1: Add helper functions**

Add at the end of `auth.ts`:

```typescript
import { NextResponse } from 'next/server';
import { getUserRoleForBook, hasMinimumRole, type Role } from './services/permission.service';

/**
 * Require authentication. Returns user or 401 response.
 */
export async function requireAuth(): Promise<
  { user: { id: number; username: string }; session: IronSession<SessionData> } |
  NextResponse
> {
  const session = await getSession();
  if (!session.isLoggedIn || !session.userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const user = await prisma.gnucash_web_users.findUnique({
    where: { id: session.userId },
    select: { id: true, username: true },
  });
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return { user, session };
}

/**
 * Require a minimum role for the active book. Returns user + role or error response.
 */
export async function requireRole(minimumRole: Role): Promise<
  { user: { id: number; username: string }; role: Role; bookGuid: string } |
  NextResponse
> {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;

  const { user, session } = authResult;
  const bookGuid = session.activeBookGuid;

  if (!bookGuid) {
    return NextResponse.json({ error: 'No active book selected' }, { status: 400 });
  }

  const userRole = await getUserRoleForBook(user.id, bookGuid);
  if (!userRole) {
    return NextResponse.json({ error: 'No access to this book' }, { status: 403 });
  }

  const ROLE_HIERARCHY: Record<string, number> = { readonly: 0, edit: 1, admin: 2 };
  if (ROLE_HIERARCHY[userRole] < ROLE_HIERARCHY[minimumRole]) {
    return NextResponse.json(
      { error: `Requires ${minimumRole} role, you have ${userRole}` },
      { status: 403 }
    );
  }

  return { user, role: userRole, bookGuid };
}
```

**Step 2: Update existing route handlers**

For each of the 11 routes that currently call `getCurrentUser()`, replace with `requireAuth()` or `requireRole()`. For example, in `src/app/api/settings/schedules/route.ts`:

```typescript
// Before:
const user = await getCurrentUser();
if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

// After:
const authResult = await requireAuth();
if (authResult instanceof NextResponse) return authResult;
const { user } = authResult;
```

**Step 3: Add role checks to write endpoints**

For mutation endpoints (POST/PUT/DELETE on transactions, accounts, budgets, etc.), add:
```typescript
const roleResult = await requireRole('edit');
if (roleResult instanceof NextResponse) return roleResult;
```

For admin-only endpoints (book management, user management):
```typescript
const roleResult = await requireRole('admin');
if (roleResult instanceof NextResponse) return roleResult;
```

**Note:** The middleware already blocks unauthenticated requests, so `requireRole()` in handlers is specifically for authorization (role checking), not authentication.

**Step 4: Commit**

```bash
git add src/lib/auth.ts
git commit -m "feat: add requireAuth and requireRole helpers"
```

### Task 3.4: Add role checks to all unprotected API routes

**Files:**
- Modify: All ~54 unprotected API route files (listed in the design doc)

**Approach:** Add `requireRole('readonly')` to all GET handlers, `requireRole('edit')` to POST/PUT/DELETE data handlers, `requireRole('admin')` to book/user management handlers.

This is a bulk task — each file gets the same pattern:
```typescript
import { requireRole } from '@/lib/auth';
import { NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  const roleResult = await requireRole('readonly');
  if (roleResult instanceof NextResponse) return roleResult;
  // ... existing handler code
}
```

**Group the routes by required role:**

| Role | Routes |
|------|--------|
| `readonly` | All GET-only routes (dashboard, reports, accounts list, transactions list, etc.) |
| `edit` | POST/PUT/DELETE on transactions, accounts, budgets, splits, prices |
| `admin` | POST/PUT/DELETE on books, import, export, settings |

**Step 1: Commit**

```bash
git add src/app/api/
git commit -m "feat: add RBAC role checks to all API routes"
```

---

## Phase 4: Landing Page

### Task 4.1: Create public landing page

**Files:**
- Modify: `src/app/page.tsx` (if it exists) or create new
- Reference: existing dark theme colors from Tailwind config

**Step 1: Check current root page**

The root `/` currently may be in `src/app/(main)/` route group. We need it outside `(main)` so it's not wrapped in the auth layout.

Create `src/app/(public)/page.tsx` for the landing page with its own minimal layout, or modify the existing root `src/app/page.tsx`.

**Step 2: Build the landing page**

Feature showcase with:
- Header: "GnuCash Web" + tagline
- 4 feature cards with icons:
  - Dashboard & Analytics
  - Transaction Management
  - Financial Reports
  - Investment Tracking
- Login / Register CTA buttons linking to `/login`
- Consistent with existing dark theme

**Step 3: Ensure middleware excludes it**

The middleware matcher already excludes `/` (the root path). Verify the landing page is accessible without auth.

**Step 4: Commit**

```bash
git add src/app/
git commit -m "feat: add public landing page with feature showcase"
```

---

## Phase 5: New User Onboarding & Book Creation

### Task 5.1: Add business and non-profit account templates

**Files:**
- Create: `src/data/account-templates/en_US_business.json`
- Create: `src/data/account-templates/en_US_nonprofit.json`
- Modify: `src/lib/account-templates.ts` (register new templates)

**Step 1: Create template JSON files**

Follow the exact structure of `src/data/account-templates/en_US.json`. Each template has a locale, templateId, name, and nested accounts array with `{ name, type, placeholder?, children? }`.

**Step 2: Register in account-templates.ts**

Update `getAvailableTemplates()` and template loading to include the new files.

**Step 3: Commit**

```bash
git add src/data/account-templates/ src/lib/account-templates.ts
git commit -m "feat: add small business and non-profit account templates"
```

### Task 5.2: Create template listing API

**Files:**
- Create: `src/app/api/books/templates/route.ts`

**Step 1: Implement GET handler**

```typescript
import { NextResponse } from 'next/server';
import { getAvailableTemplates } from '@/lib/account-templates';

export async function GET() {
  const templates = getAvailableTemplates();
  return NextResponse.json(templates);
}
```

**Step 2: Commit**

```bash
git add src/app/api/books/templates/route.ts
git commit -m "feat: add API endpoint to list available book templates"
```

### Task 5.3: Create onboarding page

**Files:**
- Create: `src/app/(main)/onboarding/page.tsx`

**Step 1: Build the onboarding page**

A client component with:
- Welcome message
- Two cards: "Start from Template" and "Import from GnuCash"
- Template card: fetches `/api/books/templates`, shows template picker (Personal, Business, Non-Profit), book name input, currency selector
- Import card: file upload dropzone for .gnucash files
- On submit: calls `POST /api/books/from-template` or `POST /api/import`, then `refreshBooks()` + `switchBook(newGuid)` + redirect to `/accounts`

**Step 2: This is the SAME component used for "New Book" from the book management area**

Extract the creation form into a reusable `CreateBookWizard` component that can be used both on the `/onboarding` page and in a modal from the book selector.

**Step 3: Add first-run detection**

In the `(main)/layout.tsx` or `BookProvider`, after loading books: if the user has zero books (or zero book permissions), redirect to `/onboarding`.

**Step 4: Grant admin role on book creation**

Modify `POST /api/books/from-template` and `POST /api/books` to automatically call `grantRole(userId, newBookGuid, 'admin', userId)` after book creation.

**Step 5: Commit**

```bash
git add src/app/\(main\)/onboarding/ src/components/CreateBookWizard.tsx
git commit -m "feat: add onboarding page and reusable book creation wizard"
```

---

## Phase 6: Inline Editable Ledger

### Task 6.1: Add keyboard navigation to AccountLedger

**Files:**
- Modify: `src/components/AccountLedger.tsx`

**Step 1: Add focus tracking state**

```typescript
const [focusedRowIndex, setFocusedRowIndex] = useState<number>(-1);
const [editingGuid, setEditingGuid] = useState<string | null>(null);
const tableRef = useRef<HTMLTableElement>(null);
```

**Step 2: Add keyboard event handler**

```typescript
const handleTableKeyDown = useCallback((e: KeyboardEvent) => {
  if (editingGuid) return; // Let InlineEditRow handle keys during edit

  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault();
      setFocusedRowIndex(i => Math.min(i + 1, transactions.length - 1));
      break;
    case 'ArrowUp':
      e.preventDefault();
      setFocusedRowIndex(i => Math.max(i - 1, 0));
      break;
    case 'Enter':
      if (focusedRowIndex >= 0) {
        e.preventDefault();
        setEditingGuid(transactions[focusedRowIndex].guid);
      }
      break;
    case 'r':
      if (focusedRowIndex >= 0) {
        e.preventDefault();
        toggleReviewed(transactions[focusedRowIndex].guid);
      }
      break;
    case 'Escape':
      setFocusedRowIndex(-1);
      break;
  }
}, [editingGuid, focusedRowIndex, transactions]);
```

**Step 3: Apply focus styling to rows**

Add conditional class to `<tr>`:
```tsx
className={`... ${index === focusedRowIndex ? 'ring-2 ring-cyan-500/50 ring-inset' : ''}`}
```

**Step 4: Commit**

```bash
git add src/components/AccountLedger.tsx
git commit -m "feat: add keyboard navigation (up/down/enter) to account ledger"
```

### Task 6.2: Create InlineEditRow component

**Files:**
- Create: `src/components/InlineEditRow.tsx`

**Step 1: Build the inline edit row**

A `<tr>` that renders editable cells:
- Date input (with +/-/t shortcuts from TransactionForm's `handleDateKeyDown`)
- Description input (with autocomplete from `DescriptionAutocomplete`)
- Account selector (from `AccountSelector`)
- Amount input (with tax shortcut support)

Props:
```typescript
interface InlineEditRowProps {
  transaction: AccountTransaction;
  accountGuid: string;
  onSave: (guid: string, data: CreateTransactionRequest) => Promise<void>;
  onCancel: () => void;
}
```

Keyboard behavior:
- Tab/Shift+Tab: move between fields
- Enter: save
- Escape: cancel

**Step 2: Share form logic with TransactionForm**

Extract date shortcut handler, tax shortcut handler, and validation into shared hooks:
- `useDateShortcuts(dateRef)` — handles +/-/t
- `useTaxShortcut(amountRef, taxRate)` — handles t in amount field

**Step 3: Integrate into AccountLedger**

When `editingGuid === tx.guid`, render `<InlineEditRow>` instead of the display `<tr>`.

**Step 4: Commit**

```bash
git add src/components/InlineEditRow.tsx src/components/AccountLedger.tsx src/lib/hooks/
git commit -m "feat: add inline editable rows to account ledger"
```

### Task 6.3: Add "reviewed" toggle for SimpleFin imports

**Files:**
- Modify: `src/components/AccountLedger.tsx`
- Create: `src/app/api/transactions/[guid]/review/route.ts`

**Step 1: Add review API**

```typescript
// PATCH /api/transactions/{guid}/review
// Toggles the reviewed flag in gnucash_web_transaction_meta
```

**Step 2: Visual indicators**

Unreviewed rows get:
- Amber left border: `border-l-4 border-amber-500`
- Small "Imported" badge next to description
- `r` key toggles reviewed status

**Step 3: Filter toggle**

Add "Show unreviewed only" toggle button to the toolbar above the ledger.

**Step 4: Commit**

```bash
git add src/components/AccountLedger.tsx src/app/api/transactions/
git commit -m "feat: add reviewed status indicators and toggle for imported transactions"
```

---

## Phase 7: SimpleFin Integration

### Task 7.1: Add SimpleFin database tables

**Files:**
- Modify: `src/lib/db-init.ts`

**Step 1: Add DDLs for SimpleFin tables**

```typescript
const SIMPLEFIN_CONNECTIONS_TABLE = `
CREATE TABLE IF NOT EXISTS gnucash_web_simplefin_connections (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES gnucash_web_users(id) ON DELETE CASCADE,
    access_url_encrypted TEXT NOT NULL,
    last_sync_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
`;

const SIMPLEFIN_ACCOUNT_MAP_TABLE = `
CREATE TABLE IF NOT EXISTS gnucash_web_simplefin_account_map (
    id SERIAL PRIMARY KEY,
    connection_id INTEGER NOT NULL REFERENCES gnucash_web_simplefin_connections(id) ON DELETE CASCADE,
    simplefin_account_id VARCHAR(255) NOT NULL,
    simplefin_account_name VARCHAR(255),
    gnucash_account_guid VARCHAR(32) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(connection_id, simplefin_account_id)
);
`;

const TRANSACTION_META_TABLE = `
CREATE TABLE IF NOT EXISTS gnucash_web_transaction_meta (
    id SERIAL PRIMARY KEY,
    transaction_guid VARCHAR(32) NOT NULL UNIQUE,
    source VARCHAR(50) NOT NULL DEFAULT 'manual',
    reviewed BOOLEAN NOT NULL DEFAULT TRUE,
    imported_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    simplefin_transaction_id VARCHAR(255),
    confidence VARCHAR(20)
);
`;
```

**Step 2: Execute in createExtensionTables()**

**Step 3: Commit**

```bash
git add src/lib/db-init.ts
git commit -m "feat: add SimpleFin and transaction metadata tables"
```

### Task 7.2: Create SimpleFin service

**Files:**
- Create: `src/lib/services/simplefin.service.ts`

**Step 1: Implement the SimpleFin API client**

Key functions:
- `claimSetupToken(token: string)`: Decode base64 token → POST to claim URL → return access URL
- `fetchAccounts(accessUrl: string, startDate?: number, endDate?: number)`: GET /accounts with Basic Auth
- `encryptAccessUrl(url: string)`: Encrypt using SESSION_SECRET or a dedicated key
- `decryptAccessUrl(encrypted: string)`: Decrypt

SimpleFin API details (from protocol spec):
- Setup token is Base64-encoded claim URL
- POST to claim URL returns the access URL (with embedded Basic Auth)
- GET `{accessUrl}/accounts?start-date={unix}&end-date={unix}` returns account set JSON
- Transaction object: `{ id, posted, amount, description, pending? }`
- Date range limited to 60 days per request

**Step 2: Commit**

```bash
git add src/lib/services/simplefin.service.ts
git commit -m "feat: add SimpleFin Bridge API client service"
```

### Task 7.3: Create SimpleFin API routes

**Files:**
- Create: `src/app/api/simplefin/connect/route.ts` — POST: claim token, store connection
- Create: `src/app/api/simplefin/accounts/route.ts` — GET: list SimpleFin accounts with mapping status
- Create: `src/app/api/simplefin/accounts/map/route.ts` — PUT: update account mapping
- Create: `src/app/api/simplefin/sync/route.ts` — POST: trigger manual sync
- Create: `src/app/api/simplefin/disconnect/route.ts` — DELETE: remove connection
- Create: `src/app/api/simplefin/status/route.ts` — GET: connection status + last sync

**Step 1: Implement each route following existing patterns**

All routes use `requireRole('admin')` except status (readonly).

**Step 2: Commit**

```bash
git add src/app/api/simplefin/
git commit -m "feat: add SimpleFin API routes (connect, sync, map, disconnect)"
```

### Task 7.4: Create transaction sync engine

**Files:**
- Create: `src/lib/services/simplefin-sync.service.ts`

**Step 1: Implement sync logic**

Key function: `syncSimpleFin(connectionId: number)`

For each mapped account:
1. Fetch transactions from SimpleFin since `last_sync_at` (in 60-day chunks if needed)
2. Dedup: query existing transactions by date + amount + description on the mapped account
3. For new transactions:
   - Guess destination account: query historical transactions with similar description on this account, pick most frequent counterpart account
   - Create GnuCash transaction + 2 splits
   - Insert `gnucash_web_transaction_meta` with `source='simplefin'`, `reviewed=false`
4. Update `last_sync_at`

**Step 2: Commit**

```bash
git add src/lib/services/simplefin-sync.service.ts
git commit -m "feat: add SimpleFin transaction sync engine with category guessing"
```

### Task 7.5: Create Connections settings page

**Files:**
- Create: `src/app/(main)/settings/connections/page.tsx`
- Modify: `src/components/Layout.tsx` (add nav link if needed)

**Step 1: Build the connections UI**

Before connection:
- Explanation of SimpleFin Bridge, link to simplefin.org/bridge
- Setup steps
- Token input + "Connect" button

After connection:
- Status card: Connected, last sync time
- "Manage bank connections on SimpleFin" link (external, new tab)
- Account mapping table: SimpleFin account → GnuCash account dropdown
- "Sync Now" button
- "Disconnect" button

**Step 2: Commit**

```bash
git add src/app/\(main\)/settings/connections/
git commit -m "feat: add SimpleFin connections settings page with account mapping"
```

### Task 7.6: Integrate SimpleFin sync into nightly schedule

**Files:**
- Modify: `src/app/(main)/settings/page.tsx` (add checkbox)
- Modify: `src/app/api/settings/schedules/run-now/route.ts` (trigger sync after prices)
- Modify: `worker.ts` (if worker-based scheduling exists)

**Step 1: Add SimpleFin sync toggle to schedule settings**

**Step 2: After price refresh, run SimpleFin sync if enabled**

**Step 3: Commit**

```bash
git add src/app/ worker.ts
git commit -m "feat: integrate SimpleFin sync into nightly price refresh schedule"
```

---

## Phase 8: Invitation System

### Task 8.1: Create invitation API routes

**Files:**
- Create: `src/app/api/books/[guid]/invitations/route.ts` — GET (list), POST (create)
- Create: `src/app/api/invitations/[code]/route.ts` — PUT (accept), DELETE (revoke)

**Step 1: Implement following the patterns from the security research doc Section 5**

**Step 2: Commit**

```bash
git add src/app/api/books/ src/app/api/invitations/
git commit -m "feat: add invitation system API (create, list, accept, revoke)"
```

### Task 8.2: Create invitation management UI

**Files:**
- Create: `src/app/(main)/settings/users/page.tsx` (or integrate into existing settings)
- Create: `src/components/InvitationManager.tsx`

**Step 1: Admin-only page showing**
- Current users with roles for the active book
- Create invitation form (role picker, expiry, max uses)
- Active invitations list with copy link / revoke buttons

**Step 2: Commit**

```bash
git add src/app/ src/components/
git commit -m "feat: add invitation management UI for book admins"
```

---

## Verification Checklist

After all phases:

- [ ] Unauthenticated requests to `/api/accounts` return 401
- [ ] Unauthenticated visits to `/accounts` redirect to `/login`
- [ ] `/` (landing page) is accessible without auth
- [ ] `/login` is accessible without auth
- [ ] Tax rate input allows typing "6.75" without cursor jumping
- [ ] New user with no books sees onboarding page
- [ ] Book creation from template works (personal, business, non-profit)
- [ ] SimpleFin setup token can be claimed and stored
- [ ] SimpleFin account mapping works
- [ ] Manual sync imports transactions with review flags
- [ ] Account ledger supports Up/Down/Enter/Escape keyboard navigation
- [ ] Enter on a row opens inline edit
- [ ] `r` key toggles reviewed status
- [ ] Invitation links can be created and accepted
- [ ] `npm run build` passes with zero errors

# Security Research: Role-Based Access Control (RBAC) for GnuCash Web

## 1. Executive Summary

This document presents a comprehensive research proposal for implementing Role-Based Access Control (RBAC) in GnuCash Web, enabling granular permission management across multiple books and users. Currently, GnuCash Web provides basic authentication via `iron-session` and `bcrypt`, but lacks role-based authorization. This research outlines a three-tier role system (readonly, edit, admin) with per-book permissions, database schema design, implementation strategies, and security considerations.

**Key Objectives:**
- Enable users to have different permission levels for different books
- Support team collaboration with role-based access control
- Maintain backward compatibility with existing single-user deployments
- Provide an invitation system for secure user onboarding
- Implement comprehensive audit logging for permission changes

This is a **research and planning document only**. No implementation code is included.

---

## 2. Role Definitions

### 2.1 Read-Only Role

**Purpose:** View-only access for stakeholders who need visibility into financial data without modification rights.

**Permissions:**
- View account hierarchy and account details
- View transactions and transaction history
- View transaction reports (balance sheet, income statement, cash flow, etc.)
- View account valuations and investments
- View budgets and budget comparisons
- View dashboards (net worth, KPIs, income/expense)
- Export data (download .gnucash files, generate reports)
- View audit logs (their own actions and those affecting shared books)

**Restrictions:**
- Cannot create, edit, or delete transactions
- Cannot create, edit, or delete accounts
- Cannot manage budgets (amounts, periods)
- Cannot reconcile accounts
- Cannot import data
- Cannot modify user permissions
- Cannot manage books (create, rename, delete)
- Cannot change system settings

**Use Cases:**
- Accountant reviewing client financials (read-only review)
- Family member with view-only access to shared financial data
- External auditor with temporary read-only access
- Stakeholder monitoring business performance metrics

### 2.2 Edit Role

**Purpose:** Standard user role for day-to-day financial operations and data entry.

**Permissions:**
- All read-only permissions
- Create transactions
- Edit transactions (own and others')
- Delete transactions
- Create and edit accounts
- Delete accounts (if no associated splits)
- Reconcile accounts and individual splits
- Create budgets
- Edit budget amounts and periods
- Delete budgets
- Create and manage price data
- Manage splits (reconcile, reconcile multiple)
- View audit logs for all actions within the book

**Restrictions:**
- Cannot manage users (invite, change roles, remove)
- Cannot manage books (create, rename, delete, switch ownership)
- Cannot import data from external sources
- Cannot change book-level settings
- Cannot modify other users' roles
- Cannot view system-wide audit logs (only book-specific)

**Use Cases:**
- Primary data entry person entering transactions daily
- Team member managing specific accounts
- Bookkeeper reconciling monthly statements
- Financial officer entering journal entries

### 2.3 Admin Role

**Purpose:** Full administrative access for system-wide management and governance.

**Permissions:**
- All edit role permissions
- Manage users (invite, revoke access, change roles within the book)
- Manage books (create new books, rename, delete)
- Bulk import data (from other systems, .gnucash files)
- Bulk export data
- Configure book-level settings and preferences
- View and manage audit logs (all users, all actions)
- Create and manage invitations
- View system-wide analytics and usage statistics
- Modify role permissions (for future extensibility)

**Restrictions:**
- Cannot access books they're not explicitly granted access to
- Cannot unilaterally delete a book without confirmation
- Cannot remove their own admin role from a book (requires another admin)
- Cannot change the password of another user (users manage their own passwords)

**Use Cases:**
- Book owner/manager with full control
- Organization administrator managing team access
- Senior accountant overseeing entire operation
- CPA firm partner managing client access

---

## 3. Database Schema Proposal

### 3.1 Role Reference Table

```sql
-- Reference table for available roles
-- Stores the list of role types that can be assigned to users
CREATE TABLE IF NOT EXISTS gnucash_web_roles (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) UNIQUE NOT NULL,
    description TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT role_names CHECK (name IN ('readonly', 'edit', 'admin'))
);

-- Seed the roles table with default roles
INSERT INTO gnucash_web_roles (name, description) VALUES
    ('readonly', 'View-only access to book data and reports'),
    ('edit', 'Can create, edit, and delete transactions; manage budgets and accounts'),
    ('admin', 'Full access including user management, book management, and system settings')
ON CONFLICT DO NOTHING;
```

**Purpose:** Maintains a normalized list of available roles. Enables future extensibility (custom roles, role descriptions, role features table).

**Key Design Decisions:**
- Immutable role names via CHECK constraint ensures consistency
- `description` field helps with UI display and documentation
- Uses serial ID for foreign key references (more efficient than string keys)

### 3.2 Per-Book Permissions Table

```sql
-- Maps users to roles within specific books
-- Enables different users to have different roles for different books
CREATE TABLE IF NOT EXISTS gnucash_web_book_permissions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES gnucash_web_users(id) ON DELETE CASCADE,
    book_guid VARCHAR(32) NOT NULL REFERENCES books(guid) ON DELETE CASCADE,
    role_id INTEGER NOT NULL REFERENCES gnucash_web_roles(id),
    granted_by INTEGER REFERENCES gnucash_web_users(id) ON DELETE SET NULL,
    granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    -- Ensure each user has only one role per book
    UNIQUE(user_id, book_guid),

    -- Index for efficient permission lookups
    INDEX idx_user_book (user_id, book_guid),
    INDEX idx_book_role (book_guid, role_id),
    INDEX idx_user_role (user_id, role_id)
);
```

**Purpose:** Core permissions table storing which users have which roles for which books.

**Key Design Decisions:**
- `UNIQUE(user_id, book_guid)` ensures one role per user per book (no role conflicts)
- `granted_by` tracks which admin granted the permission (helps with audit trails)
- `granted_at` timestamps when access was granted (useful for reports and audits)
- Foreign key on `granted_by` with `ON DELETE SET NULL` allows admin deletion without cascading permission deletions
- Indexes on common query patterns (user+book lookups, book+role lookups)

**Migration Considerations:**
- When first deployed, all existing users should be assigned admin role for all existing books
- This maintains backward compatibility with single-user setups
- Allows gradual migration of permission models

### 3.3 Invitation System Table

```sql
-- Secure invitation links for onboarding new users to books
-- Supports single-use and multi-use invitations with expiry
CREATE TABLE IF NOT EXISTS gnucash_web_invitations (
    id SERIAL PRIMARY KEY,
    code VARCHAR(64) UNIQUE NOT NULL,  -- Cryptographically random, 64 chars
    book_guid VARCHAR(32) NOT NULL REFERENCES books(guid) ON DELETE CASCADE,
    role_id INTEGER NOT NULL REFERENCES gnucash_web_roles(id),

    -- Creator and usage tracking
    created_by INTEGER NOT NULL REFERENCES gnucash_web_users(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NOT NULL,  -- Must be set by creator

    -- Usage tracking
    used_by INTEGER REFERENCES gnucash_web_users(id) ON DELETE SET NULL,
    used_at TIMESTAMP,

    -- Usage limit tracking
    max_uses INTEGER DEFAULT 1,  -- NULL = unlimited uses
    use_count INTEGER DEFAULT 0,

    -- Status flags
    is_revoked BOOLEAN DEFAULT FALSE,
    revoked_by INTEGER REFERENCES gnucash_web_users(id) ON DELETE SET NULL,
    revoked_at TIMESTAMP,

    -- Indexes for efficient lookups
    INDEX idx_code (code),
    INDEX idx_book_active (book_guid, is_revoked, expires_at),
    INDEX idx_creator (created_by)
);
```

**Purpose:** Enables secure, flexible user onboarding without requiring admin to manually grant permissions in real-time.

**Key Design Decisions:**
- `code` is cryptographically random (not sequential or predictable)
  - Recommend: `crypto.getRandomValues()` for 64-character hex string (256 bits entropy)
  - Much shorter than a UUID but still cryptographically secure given the database limit
- `max_uses` defaults to 1 (single-use invitations are most common)
  - When `NULL`, means unlimited uses (useful for persistent team invitation links)
- `use_count` tracks how many times a link has been used (for analytics and limits)
- Separate `is_revoked` flag instead of soft-deleting allows preserving invitation history
- Expiry validation happens in application code (not a database constraint)

**Security Implications:**
- Invitations bypass normal user creation flow for specific books
- Only active, non-expired, non-revoked, non-maxed-out invitations are valid
- Creating an invitation requires admin role in the target book
- No email validation required (can be used by any user or new registrant)

### 3.4 Extended Audit Logging

The existing `gnucash_web_audit` table should be extended to track permission-related events:

```sql
-- Extended audit table (proposed additions to existing table)
ALTER TABLE gnucash_web_audit
ADD COLUMN IF NOT EXISTS book_guid VARCHAR(32) REFERENCES books(guid),
ADD COLUMN IF NOT EXISTS permission_action VARCHAR(50),  -- GRANT, REVOKE, CHANGE_ROLE
ADD COLUMN IF NOT EXISTS ip_address VARCHAR(45),  -- Support IPv6
ADD COLUMN IF NOT EXISTS session_id VARCHAR(128),
ADD COLUMN IF NOT EXISTS request_id VARCHAR(36);

-- Create audit index for book-specific queries
CREATE INDEX IF NOT EXISTS idx_audit_book_date ON gnucash_web_audit(book_guid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_user_date ON gnucash_web_audit(user_id, created_at DESC);

-- Sample permission-related audit logs
-- These would be generated by the application, not SQL triggers
```

**Extended Audit Coverage:**
- `GRANT` event: When a user is granted access to a book with a role
- `REVOKE` event: When a user's access to a book is removed
- `CHANGE_ROLE` event: When a user's role is changed for a book
- `INVITE_CREATE` event: When an admin creates an invitation link
- `INVITE_REVOKE` event: When an invitation is revoked before expiry
- `LOGIN` event: Track login attempts (successful and failed)
- `EXPORT` event: Track data export requests for compliance
- `IMPORT` event: Track data import operations

---

## 4. Implementation Approach

### 4.1 Current Authentication Context

GnuCash Web uses `iron-session` for session management with the following structure:

**Current SessionData Interface:**
```typescript
export interface SessionData {
    userId?: number;
    username?: string;
    isLoggedIn: boolean;
}
```

**Session Configuration:**
- Password: Environment variable `SESSION_SECRET` (32+ characters)
- Cookie name: `gnucash_web_session`
- Cookie options: secure (production only), httpOnly, sameSite: 'lax'
- Duration: 24 hours

**Related files:**
- `src/lib/auth.ts` - Session management, password hashing (bcrypt)
- `src/app/api/auth/login/route.ts` - Login endpoint
- `src/app/api/auth/register/route.ts` - Registration endpoint
- `prisma/schema.prisma` - User and audit schemas

### 4.2 Extended Session Architecture

Extend `SessionData` to include role information:

```typescript
// Proposed extension to SessionData interface
export interface SessionData {
    // Existing fields
    userId?: number;
    username?: string;
    isLoggedIn: boolean;

    // New RBAC fields
    activeBookGuid?: string;           // Currently selected/active book
    activeBookRole?: string;           // Role in the active book ('readonly'|'edit'|'admin')
    bookRoles?: Record<string, string>; // Mapping of bookGuid -> role for quick lookup

    // Optimization fields
    rolesCachedAt?: number;            // Timestamp of last role refresh
    bookPermissions?: {
        [bookGuid: string]: {
            role: string;
            grantedAt: string;
        }
    };
}
```

**Design Rationale:**
- `activeBookGuid` simplifies context switching between books
- `activeBookRole` avoids DB lookup on every request for current book
- `bookRoles` provides fast role resolution for permission checks
- `rolesCachedAt` enforces cache expiration (e.g., 5-minute refresh)
- Roles are cached in-session to minimize database queries

**Cache Invalidation Strategy:**
1. On login: Load all user roles for all books they have access to
2. Every 5 minutes OR on explicit book switch: Refresh from database
3. On permission change: Force immediate refresh via session update
4. On logout: Clear all cached role data

### 4.3 Permission Checking Utility Functions

A permission checking service would be created at `src/lib/services/permission.service.ts`:

```typescript
// Proposed permission checking utilities (pseudocode)

interface PermissionCheckResult {
    allowed: boolean;
    reason?: string;  // For audit/logging
}

// Get user's role for a specific book
async function getUserRoleForBook(
    userId: number,
    bookGuid: string
): Promise<string | null>

// Check if user has minimum role for a book
async function hasMinimumRole(
    userId: number,
    bookGuid: string,
    minimumRole: 'readonly' | 'edit' | 'admin'
): Promise<boolean>

// Check specific permission
async function checkPermission(
    userId: number,
    bookGuid: string,
    action: PermissionAction
): Promise<PermissionCheckResult>

// Get all books user has access to
async function getUserBooks(
    userId: number
): Promise<Array<{guid: string; name: string; role: string}>>

// Role hierarchy for permission checking
const ROLE_HIERARCHY = {
    'readonly': 0,
    'edit': 1,
    'admin': 2,
};

function roleExceedsOrEqual(userRole: string, requiredRole: string): boolean {
    return ROLE_HIERARCHY[userRole] >= ROLE_HIERARCHY[requiredRole];
}
```

**Permission Actions:**
```typescript
type PermissionAction =
    // Read operations
    | 'VIEW_ACCOUNTS'
    | 'VIEW_TRANSACTIONS'
    | 'VIEW_REPORTS'
    | 'VIEW_BUDGETS'
    | 'VIEW_DASHBOARD'
    | 'EXPORT_DATA'
    | 'VIEW_AUDIT_LOGS'

    // Edit operations
    | 'CREATE_TRANSACTION'
    | 'EDIT_TRANSACTION'
    | 'DELETE_TRANSACTION'
    | 'CREATE_ACCOUNT'
    | 'EDIT_ACCOUNT'
    | 'DELETE_ACCOUNT'
    | 'RECONCILE_ACCOUNT'
    | 'CREATE_BUDGET'
    | 'EDIT_BUDGET'
    | 'DELETE_BUDGET'
    | 'CREATE_PRICE'
    | 'EDIT_PRICE'
    | 'DELETE_PRICE'

    // Admin operations
    | 'MANAGE_USERS'
    | 'INVITE_USERS'
    | 'REVOKE_ACCESS'
    | 'CHANGE_ROLE'
    | 'CREATE_BOOK'
    | 'RENAME_BOOK'
    | 'DELETE_BOOK'
    | 'IMPORT_DATA'
    | 'MANAGE_SETTINGS';
```

### 4.4 Middleware-Based Route Protection

Next.js middleware would enforce permission checks at the route level:

```typescript
// Proposed: src/middleware.ts
// Pattern for protecting API routes and pages

// API routes protected at route handler level
export async function GET(request: NextRequest) {
    const session = await getSession();

    if (!session.isLoggedIn) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const bookGuid = request.nextUrl.searchParams.get('bookGuid');
    const hasAccess = await checkPermission(
        session.userId!,
        bookGuid!,
        'VIEW_TRANSACTIONS'
    );

    if (!hasAccess.allowed) {
        return NextResponse.json(
            { error: 'Forbidden: ' + hasAccess.reason },
            { status: 403 }
        );
    }

    // Continue with request...
}
```

**Key Principles:**
- Check authentication first (401 Unauthorized)
- Check authorization second (403 Forbidden)
- Log denied access attempts for security monitoring
- Cache permission results with short TTL (5 minutes)
- Return meaningful error messages for debugging

### 4.5 API-Level Permission Matrix

Complete endpoint matrix with required roles:

| Endpoint | Method | Resource | Min Role | Notes |
|----------|--------|----------|----------|-------|
| `/api/accounts` | GET | Book accounts | readonly | View account tree |
| `/api/accounts` | POST | New account | edit | Create account |
| `/api/accounts/[guid]` | GET | Account details | readonly | View account info |
| `/api/accounts/[guid]` | PUT | Account edit | edit | Edit account properties |
| `/api/accounts/[guid]` | DELETE | Account delete | edit | Delete account (no splits) |
| `/api/accounts/[guid]/transactions` | GET | Account ledger | readonly | View account transactions |
| `/api/accounts/[guid]/move` | POST | Account move | edit | Move account in tree |
| `/api/accounts/[guid]/info` | GET | Account metadata | readonly | Account summary info |
| `/api/accounts/[guid]/valuation` | GET | Account valuation | readonly | Current market value |
| `/api/accounts/balances` | GET | All balances | readonly | Cached balance query |
| `/api/transactions` | GET | Transaction list | readonly | Paginated transaction view |
| `/api/transactions` | POST | New transaction | edit | Create transaction |
| `/api/transactions/[guid]` | GET | Transaction detail | readonly | View single transaction |
| `/api/transactions/[guid]` | PUT | Transaction update | edit | Edit transaction |
| `/api/transactions/[guid]` | DELETE | Transaction delete | edit | Delete transaction |
| `/api/transactions/descriptions` | GET | Descriptions | readonly | Auto-complete descriptions |
| `/api/splits/[guid]/reconcile` | POST | Reconcile split | edit | Mark split as reconciled |
| `/api/splits/bulk/reconcile` | POST | Bulk reconcile | edit | Reconcile multiple splits |
| `/api/budgets` | GET | Budget list | readonly | View budgets |
| `/api/budgets` | POST | New budget | edit | Create budget |
| `/api/budgets/[guid]` | GET | Budget detail | readonly | View budget |
| `/api/budgets/[guid]` | PUT | Budget update | edit | Edit budget |
| `/api/budgets/[guid]` | DELETE | Budget delete | edit | Delete budget |
| `/api/budgets/[guid]/amounts` | GET | Budget amounts | readonly | View period amounts |
| `/api/budgets/[guid]/amounts` | POST | Budget amount | edit | Create budget amount |
| `/api/budgets/[guid]/amounts/[id]` | PUT | Budget amount update | edit | Edit amount |
| `/api/budgets/[guid]/amounts/all-periods` | GET | All amounts | readonly | Bulk fetch amounts |
| `/api/budgets/[guid]/accounts` | GET | Budget accounts | readonly | Accounts in budget |
| `/api/budgets/[guid]/estimate` | GET | Budget estimate | readonly | AI-generated estimates |
| `/api/reports/balance-sheet` | GET | Balance sheet | readonly | Financial report |
| `/api/reports/income-statement` | GET | Income statement | readonly | P&L report |
| `/api/reports/account-summary` | GET | Account summary | readonly | Summary by type |
| `/api/reports/transaction-report` | GET | Transaction report | readonly | Custom transaction report |
| `/api/reports/cash-flow` | GET | Cash flow | readonly | Cash flow analysis |
| `/api/dashboard/net-worth` | GET | Net worth chart | readonly | Net worth over time |
| `/api/dashboard/income-expense` | GET | Income/expense | readonly | Income vs expense chart |
| `/api/dashboard/sankey` | GET | Sankey diagram | readonly | Money flow visualization |
| `/api/dashboard/kpis` | GET | KPI metrics | readonly | Key performance indicators |
| `/api/prices` | GET | Price list | readonly | View all prices |
| `/api/prices` | POST | New price | edit | Create price entry |
| `/api/prices/[guid]` | GET | Price detail | readonly | View price |
| `/api/prices/[guid]` | PUT | Price update | edit | Edit price |
| `/api/prices/[guid]` | DELETE | Price delete | edit | Delete price |
| `/api/prices/fetch` | POST | Fetch prices | edit | Auto-update prices |
| `/api/investments/portfolio` | GET | Portfolio | readonly | Investment portfolio |
| `/api/investments/history` | GET | History | readonly | Investment history |
| `/api/investments/status` | GET | Status | readonly | Investment status |
| `/api/commodities` | GET | Commodities | readonly | List commodities |
| `/api/exchange-rates` | GET | Exchange rates | readonly | Current rates |
| `/api/exchange-rates/pair` | GET | Pair rate | readonly | Specific rate |
| `/api/user/preferences` | GET | Preferences | readonly | User settings |
| `/api/user/preferences` | PUT | Update preferences | readonly | Update own settings |
| `/api/books` | GET | Books list | readonly | List accessible books |
| `/api/books` | POST | Create book | admin | Create new book |
| `/api/books/[guid]` | GET | Book info | readonly | Book details |
| `/api/books/[guid]` | PUT | Update book | admin | Rename/edit book |
| `/api/books/[guid]` | DELETE | Delete book | admin | Delete book |
| `/api/books/[guid]/export` | GET | Export book | readonly | Download .gnucash |
| `/api/books/[guid]/import` | POST | Import data | admin | Import from file |
| `/api/books/[guid]/users` | GET | Users in book | admin | List book users |
| `/api/books/[guid]/users` | POST | Add user | admin | Grant access |
| `/api/books/[guid]/users/[userId]` | PUT | Change role | admin | Modify user role |
| `/api/books/[guid]/users/[userId]` | DELETE | Remove user | admin | Revoke access |
| `/api/books/[guid]/invitations` | GET | Invitations | admin | List invitations |
| `/api/books/[guid]/invitations` | POST | Create invitation | admin | Create invite link |
| `/api/books/[guid]/invitations/[code]` | PUT | Use invitation | readonly | Accept invitation |
| `/api/books/[guid]/invitations/[code]` | DELETE | Revoke invitation | admin | Revoke invite link |
| `/api/auth/login` | POST | Login | public | Authenticate user |
| `/api/auth/register` | POST | Register | public | Create new user |
| `/api/auth/logout` | POST | Logout | readonly | Destroy session |
| `/api/auth/me` | GET | Current user | readonly | Get session info |

**Key Observations:**
- `readonly` is minimum for most data retrieval
- `edit` is required for data modification
- `admin` is required for user and book management
- All endpoints require authentication (isLoggedIn)
- Book context is essential for authorization checks

### 4.6 UI-Level Enforcement

Frontend components would conditionally render based on role:

```typescript
// Proposed pattern for UI components

interface RoleAwareComponentProps {
    requiredRole?: 'readonly' | 'edit' | 'admin';
    fallback?: React.ReactNode;
}

// Example: Edit button visible only for edit+ role
export function TransactionEditButton({ txGuid }: { txGuid: string }) {
    const { activeBookRole } = useSession();

    if (activeBookRole !== 'edit' && activeBookRole !== 'admin') {
        return null;  // Hidden for readonly users
    }

    return (
        <button onClick={() => openEditModal(txGuid)}>
            Edit Transaction
        </button>
    );
}

// Example: Form rendered differently based on role
export function AccountForm({ account }: { account: Account }) {
    const { activeBookRole } = useSession();
    const isReadOnly = activeBookRole === 'readonly';

    return (
        <form>
            <input
                value={account.name}
                disabled={isReadOnly}
            />
            <input
                value={account.description}
                disabled={isReadOnly}
            />
            {/* Submit button hidden for readonly */}
            {!isReadOnly && <button type="submit">Save</button>}
        </form>
    );
}

// Example: Role badge in user menu
export function UserMenu() {
    const { username, activeBookRole } = useSession();

    return (
        <div>
            <span>{username}</span>
            <span className={`role-badge role-${activeBookRole}`}>
                {activeBookRole}
            </span>
        </div>
    );
}

// Example: Conditional section visibility
export function AdminSection() {
    const { activeBookRole } = useSession();

    if (activeBookRole !== 'admin') {
        return <p>You don't have permission to access this section.</p>;
    }

    return (
        <div>
            <UserManagement />
            <BookSettings />
        </div>
    );
}
```

**Key Principles:**
- Never rely on UI hiding for security (server-side checks are mandatory)
- UI hiding improves UX by not showing unavailable actions
- Always validate permissions on the server before performing actions
- Graceful degradation: show disabled states or helpful messages

---

## 5. Invitation System Design

### 5.1 Invitation Flow Diagram

```
Admin Creates Invitation
    ↓
Generate random code + set expiry
    ↓
Return invitation URL (e.g., /invite/abc123def456...)
    ↓
Admin shares link via email/message
    ↓
New User Clicks Link
    ↓
Is user logged in?
    ├─ NO → Redirect to login/register, return to invite after auth
    └─ YES → Proceed to acceptance
    ↓
Validate invitation (not expired, not revoked, uses available)
    ↓
Accept invitation
    ↓
Grant permission: add row to gnucash_web_book_permissions
    ↓
Update invitation: increment use_count, set used_by/used_at
    ↓
Log audit event: INVITE_USED
    ↓
Redirect to book view
```

### 5.2 Invitation Security Considerations

**Code Generation:**
```typescript
// Generate cryptographically random invitation code
function generateInvitationCode(): string {
    const randomBytes = crypto.getRandomValues(new Uint8Array(48));
    return Array.from(randomBytes)
        .map(b => b.toString(16).padStart(2, '0'))
        .join('')
        .substring(0, 64);
}
```

**Validation Logic (Pseudocode):**
```typescript
async function validateInvitation(
    code: string,
    userId: number
): Promise<{valid: boolean; reason?: string}> {
    const invitation = await db.invitations.findUnique({ where: { code } });

    if (!invitation) {
        return { valid: false, reason: 'Invitation not found' };
    }

    if (invitation.is_revoked) {
        return { valid: false, reason: 'Invitation has been revoked' };
    }

    if (invitation.expires_at < new Date()) {
        return { valid: false, reason: 'Invitation has expired' };
    }

    if (invitation.max_uses && invitation.use_count >= invitation.max_uses) {
        return { valid: false, reason: 'Invitation has reached maximum uses' };
    }

    // Check if user already has access to this book
    const existing = await db.bookPermissions.findUnique({
        where: {
            user_id_book_guid: { user_id: userId, book_guid: invitation.book_guid }
        }
    });

    if (existing) {
        return { valid: false, reason: 'You already have access to this book' };
    }

    return { valid: true };
}
```

**Acceptance Logic (Pseudocode):**
```typescript
async function acceptInvitation(
    code: string,
    userId: number
): Promise<{success: boolean; bookGuid: string}> {
    const validation = await validateInvitation(code, userId);

    if (!validation.valid) {
        throw new Error(validation.reason);
    }

    const invitation = await db.invitations.findUnique({ where: { code } });

    // Grant permission in transaction
    await db.$transaction(async (tx) => {
        // Add permission
        await tx.bookPermissions.create({
            data: {
                user_id: userId,
                book_guid: invitation.book_guid,
                role_id: invitation.role_id,
                granted_by: invitation.created_by,
                granted_at: new Date(),
            }
        });

        // Update invitation
        await tx.invitations.update({
            where: { id: invitation.id },
            data: {
                use_count: invitation.use_count + 1,
                used_by: userId,
                used_at: new Date(),
            }
        });

        // Log audit event
        await logAudit('INVITE_USED', 'INVITATION', code, null, {
            user_id: userId,
            book_guid: invitation.book_guid,
            role_assigned: invitation.role_name,
        });
    });

    return { success: true, bookGuid: invitation.book_guid };
}
```

### 5.3 Invitation Endpoints

**Create Invitation (Admin Only):**
```
POST /api/books/[guid]/invitations
Content-Type: application/json

{
    "role": "edit",
    "expiresIn": 604800,  // seconds (7 days)
    "maxUses": 1,         // optional, null = unlimited
    "notes": "For team member onboarding"
}

Response (201):
{
    "id": 42,
    "code": "abc123def456...",
    "url": "https://gnucash-web.app/invite/abc123def456",
    "bookGuid": "xyz789",
    "role": "edit",
    "expiresAt": "2025-02-15T12:00:00Z",
    "maxUses": 1,
    "createdBy": 1,
    "createdAt": "2025-02-08T12:00:00Z"
}
```

**List Active Invitations (Admin Only):**
```
GET /api/books/[guid]/invitations

Response (200):
{
    "invitations": [
        {
            "id": 42,
            "code": "abc123...",
            "role": "edit",
            "expiresAt": "2025-02-15T12:00:00Z",
            "maxUses": 1,
            "useCount": 0,
            "isRevoked": false,
            "createdAt": "2025-02-08T12:00:00Z",
            "createdBy": {"id": 1, "username": "admin"}
        }
    ]
}
```

**Accept Invitation (Any User):**
```
PUT /api/invitations/[code]
Content-Type: application/json

{}

Response (200):
{
    "success": true,
    "message": "Welcome! You now have edit access to 'Personal Finances'",
    "bookGuid": "xyz789",
    "bookName": "Personal Finances",
    "role": "edit"
}

Error (400):
{
    "error": "Invitation has expired",
    "code": "INVITATION_EXPIRED"
}
```

**Revoke Invitation (Admin Only):**
```
DELETE /api/books/[guid]/invitations/[code]

Response (204 No Content)

Response (404):
{
    "error": "Invitation not found"
}
```

---

## 6. Migration Path

### 6.1 Database Migration Steps

**Phase 1: Create Tables (Non-Breaking)**

All new tables are additive and don't affect existing functionality.

```sql
-- Migration file: /migrations/002_add_rbac_tables.sql

BEGIN;

-- 1. Create roles reference table
CREATE TABLE gnucash_web_roles (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) UNIQUE NOT NULL,
    description TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT role_names CHECK (name IN ('readonly', 'edit', 'admin'))
);

-- 2. Create book permissions table
CREATE TABLE gnucash_web_book_permissions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES gnucash_web_users(id) ON DELETE CASCADE,
    book_guid VARCHAR(32) NOT NULL REFERENCES books(guid) ON DELETE CASCADE,
    role_id INTEGER NOT NULL REFERENCES gnucash_web_roles(id),
    granted_by INTEGER REFERENCES gnucash_web_users(id) ON DELETE SET NULL,
    granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, book_guid),
    INDEX idx_user_book (user_id, book_guid),
    INDEX idx_book_role (book_guid, role_id),
    INDEX idx_user_role (user_id, role_id)
);

-- 3. Create invitations table
CREATE TABLE gnucash_web_invitations (
    id SERIAL PRIMARY KEY,
    code VARCHAR(64) UNIQUE NOT NULL,
    book_guid VARCHAR(32) NOT NULL REFERENCES books(guid) ON DELETE CASCADE,
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
    revoked_at TIMESTAMP,
    INDEX idx_code (code),
    INDEX idx_book_active (book_guid, is_revoked, expires_at),
    INDEX idx_creator (created_by)
);

-- 4. Seed default roles
INSERT INTO gnucash_web_roles (name, description) VALUES
    ('readonly', 'View-only access to book data and reports'),
    ('edit', 'Can create, edit, and delete transactions; manage budgets and accounts'),
    ('admin', 'Full access including user management and book administration');

COMMIT;
```

**Phase 2: Auto-Assign Admin Roles**

For backward compatibility, assign all existing users admin role for all existing books:

```sql
-- Migration file: /migrations/003_backfill_admin_roles.sql

BEGIN;

-- Get all users and books, create admin permissions
INSERT INTO gnucash_web_book_permissions (user_id, book_guid, role_id, granted_by, granted_at)
SELECT
    u.id,
    b.guid,
    (SELECT id FROM gnucash_web_roles WHERE name = 'admin'),
    u.id,  -- users grant permission to themselves in migration
    NOW()
FROM gnucash_web_users u
CROSS JOIN books b
ON CONFLICT (user_id, book_guid) DO NOTHING;

COMMIT;
```

### 6.2 Gradual Enforcement Rollout

**Phase A: Data Collection (Week 1-2)**
- Deploy new tables but do NOT enforce permissions
- All permission checks return "allowed"
- All existing functionality works unchanged
- Purpose: Validate schema and populate data
- Rollback point: Simply don't run enforcement code

**Phase B: Warning Mode (Week 2-3)**
- Enable permission checking but don't block requests
- Log permission denials to application logs
- Show warning messages to users "This action will require [role]"
- Monitor logs for unexpected denials
- Purpose: Identify and fix issues before enforcement

**Phase C: Soft Enforcement (Week 3-4)**
- Enable permission checks on write endpoints only
- Block writes for insufficient permissions
- Reads still allowed regardless of role
- Purpose: Catch data modification issues early

**Phase D: Full Enforcement (Week 4+)**
- Enable permission checks on all endpoints
- Block both reads and writes for insufficient permissions
- Full RBAC system active

### 6.3 Rollback Strategy

If issues arise during deployment:

**Phase A/B Rollback:** Simply disable enforcement code, no database rollback needed
**Phase C Rollback:** Disable write-side checks, allow all reads, revert to Phase B
**Phase D Rollback:** Disable all checks, allow all operations, revert to Phase C

No data is deleted during deployment, so full rollback is always possible.

---

## 7. Security Considerations

### 7.1 CSRF Protection

**Current State:**
- `iron-session` provides automatic CSRF protection via `sameSite: 'lax'`
- Cookies are httpOnly and secure (production)

**RBAC Additions:**
- Permission changes (grant, revoke, invite) should use CSRF tokens
- Recommended: Add state-changing requests require explicit CSRF token
- Pattern:
  ```javascript
  // Client
  const csrfToken = document.querySelector('meta[name="csrf-token"]').content;

  // Request
  fetch('/api/books/xyz/users', {
      method: 'POST',
      headers: {
          'X-CSRF-Token': csrfToken,
          'Content-Type': 'application/json'
      },
      body: JSON.stringify({role_id: 2})
  });

  // Server
  app.post('/api/books/:guid/users', (req, res) => {
      const csrfToken = req.get('X-CSRF-Token');
      if (!verifyCsrfToken(csrfToken)) {
          return res.status(403).json({error: 'CSRF token invalid'});
      }
      // Grant permission...
  });
  ```

### 7.2 Rate Limiting

**Login Endpoints:**
```
POST /api/auth/login       - 5 attempts per minute per IP
POST /api/auth/register    - 5 registrations per hour per IP
```

**Invitation Endpoints:**
```
POST /api/books/:guid/invitations     - 20 per hour per user per book
PUT  /api/invitations/:code           - 3 attempts per minute per IP
DELETE /api/books/:guid/invitations/* - 20 per hour per user per book
```

**User Management:**
```
POST /api/books/:guid/users           - 10 per hour per admin
PUT /api/books/:guid/users/:userId    - 10 per hour per admin
DELETE /api/books/:guid/users/:userId - 10 per hour per admin
```

**Implementation Recommendation:**
- Use Redis-backed rate limiting service
- Track by IP + User ID + Endpoint
- Return 429 Too Many Requests with Retry-After header

### 7.3 Session Expiration & Refresh Token Pattern

**Current Implementation:**
- 24-hour session timeout
- No refresh tokens

**Recommended Enhancement:**
```typescript
interface SessionData {
    userId?: number;
    username?: string;
    isLoggedIn: boolean;

    // Refresh token fields
    issuedAt?: number;        // Unix timestamp
    expiresAt?: number;       // Unix timestamp
    refreshToken?: string;    // Rotate on each refresh
}

// Implement token refresh before expiry
const REFRESH_THRESHOLD = 1 * 60 * 60 * 1000;  // 1 hour before expiry

function shouldRefreshSession(session: SessionData): boolean {
    if (!session.expiresAt) return false;
    const timeUntilExpiry = session.expiresAt - Date.now();
    return timeUntilExpiry < REFRESH_THRESHOLD;
}

// On every request
if (shouldRefreshSession(session)) {
    session.issuedAt = Date.now();
    session.expiresAt = Date.now() + 24 * 60 * 60 * 1000;
    await session.save();
}
```

**Force Logout on Permission Change:**
```typescript
// When user's role is changed or access revoked
async function invalidateUserSessions(userId: number) {
    // Mark user's sessions as invalidated in a session blacklist table
    // On next request, check blacklist and force re-login if found
    await db.sessionBlacklist.create({
        data: {
            user_id: userId,
            created_at: new Date(),
        }
    });
}
```

### 7.4 Audit Logging

**Events to Log:**
```typescript
// Authentication events
'LOGIN_SUCCESS' - user logs in successfully
'LOGIN_FAILURE' - failed login attempt (incorrect password)
'LOGOUT' - user logs out
'REGISTER' - new user registration
'PASSWORD_CHANGE' - user changes password

// Permission events
'PERMISSION_GRANT' - user granted access to book
'PERMISSION_REVOKE' - user's access revoked
'PERMISSION_CHANGE' - user's role changed
'INVITE_CREATE' - invitation link created
'INVITE_ACCEPT' - user accepts invitation
'INVITE_REVOKE' - invitation link revoked

// Data events (already logged)
'TRANSACTION_CREATE' - new transaction
'TRANSACTION_UPDATE' - transaction modified
'TRANSACTION_DELETE' - transaction deleted
'ACCOUNT_CREATE' - new account
'ACCOUNT_UPDATE' - account modified
'ACCOUNT_DELETE' - account deleted

// System events
'EXPORT_DATA' - user exports data
'IMPORT_DATA' - user imports data
'BOOK_CREATE' - new book created
'BOOK_DELETE' - book deleted
'SETTINGS_CHANGE' - settings modified
```

**Audit Log Fields:**
```typescript
interface AuditLogEntry {
    id: number;
    user_id?: number;          // Which user performed action
    action: string;            // What action (LOGIN_SUCCESS, etc.)
    resource_type: string;     // What was acted upon (TRANSACTION, PERMISSION, etc.)
    resource_id?: string;      // GUID or ID of resource
    book_guid?: string;        // Which book context (if applicable)
    old_values?: object;       // Before values for UPDATE
    new_values?: object;       // After values for UPDATE
    ip_address: string;        // Request IP (for geo-blocking, etc.)
    user_agent?: string;       // Browser/client info
    session_id?: string;       // Session identifier
    request_id?: string;       // Request tracing ID
    status: string;            // 'success' or 'failure'
    error_message?: string;    // If failed, why
    created_at: timestamp;     // When it happened
}
```

### 7.5 Additional Security Measures

**Principle of Least Privilege:**
- Default users to `readonly` role
- Require explicit admin action to upgrade to `edit` or `admin`
- New books start with no users (creator becomes admin)

**Book Deletion Requires Confirmation:**
```typescript
// Implement two-step deletion
// Step 1: Request deletion, returns confirmation code
POST /api/books/[guid]/delete-request
Response: {token: "abc123...", expiresAt: "..."}

// Step 2: Confirm deletion with token
POST /api/books/[guid]/delete-confirm
Body: {token: "abc123..."}
```

**Admin Role Cannot Be Self-Assigned:**
```typescript
// When changing another user's role
if (newRole === 'admin' && adminGranting.id === targetUser.id) {
    throw new Error('Cannot assign admin role to yourself');
}
```

**Last Admin Cannot Remove Own Admin Role:**
```typescript
const adminCount = await db.bookPermissions.count({
    where: {
        book_guid: bookGuid,
        role_id: (SELECT id FROM roles WHERE name='admin')
    }
});

if (adminCount === 1 && currentRole === 'admin' && newRole !== 'admin') {
    throw new Error('Cannot remove the last admin from a book');
}
```

**Password Management:**
- Users can only change their own password
- Admins cannot reset other users' passwords
- Recommend: Add password reset via email token

**Session Binding:**
```typescript
// Bind session to IP address for added security
if (session.boundIp && session.boundIp !== request.ip) {
    throw new Error('Session IP mismatch - please login again');
}
```

---

## 8. Open Questions and Recommendations

### 8.1 Role Hierarchy Questions

**Q: Should there be a "super admin" role that spans all books?**
- Current proposal: No global admin
- Alternative: Add `role = 'super_admin'` that can manage all books regardless of explicit permissions
- Recommendation: Avoid super admin role initially; use explicit permissions per book (more auditable)
- Future: If needed, implement via flag in `gnucash_web_users.is_system_admin`

**Q: Can users be granted a role in a book they don't own?**
- Current proposal: Yes, any admin of a book can grant access to other users
- Implication: Book ownership is shared among all admins
- Recommendation: Track explicit "owner" field if single-owner model is needed later

**Q: What happens when the last admin tries to leave a book?**
- Current proposal: Prevent it (see section 7.5)
- Alternative: Allow it, book becomes owner-less (orphaned)
- Recommendation: Prevent removal of last admin; require ownership transfer first

### 8.2 Data Visibility Questions

**Q: Should readonly users see all accounts or only specific ones?**
- Current proposal: All accounts (simple to implement)
- Alternative: Account-level permissions (complex, future enhancement)
- Recommendation: Start with all accounts for readonly, add granular permissions in Phase 2

**Q: Should readonly users see transaction amounts?**
- Current proposal: Yes, full visibility
- Alternative: Redact amounts for certain account types
- Recommendation: Full visibility; implement data masking in Phase 2 if needed

**Q: Can users see other users' audit log entries?**
- Current proposal: Admins can see all audit logs for the book; readonly users see none
- Recommendation: Audit logs are admin-only; implement user-visible activity log separately if needed

### 8.3 Invitation System Questions

**Q: Should invitations include email notifications?**
- Current proposal: No (manual distribution)
- Alternative: Send email with invitation link
- Recommendation: Implement email notifications in Phase 2 with:
  - Email template system
  - Optional email/SMS providers (SendGrid, Twilio)
  - Invitation email tracking

**Q: Can invitations specify a user (one-time use by specific person)?**
- Current proposal: No, invitation codes are anonymous
- Alternative: Include `invited_email` field, validate acceptance user's email
- Recommendation: Future enhancement; start with anonymous invitations

**Q: What happens if an invitation expires while being accepted?**
- Current proposal: Validate expiry before granting access
- Recommendation: Good; prevents race conditions with clean error message

### 8.4 Integration Questions

**Q: How should RBAC integrate with API tokens/service accounts?**
- Current proposal: Not covered in this phase
- Recommendation: Phase 2 feature - add API token system with role scoping

**Q: Should RBAC apply to exports?**
- Current proposal: Readonly users can export, but only see their permitted data
- Recommendation: Start with simple "can export or cannot export" based on role

**Q: How to handle multi-currency books with role restrictions?**
- Current proposal: All users see all currencies regardless of role
- Recommendation: Proceed; implement currency-level permissions in Phase 2 if needed

---

## 9. Implementation Timeline Estimate

**Research & Design:** 1 week (current document)
**Database Migration:** 2-3 days (including testing)
**Permission Service:** 3-4 days (utility functions, caching)
**API Middleware:** 3-4 days (per-endpoint checks)
**Invitation System:** 4-5 days (endpoints, validation)
**UI Updates:** 5-7 days (buttons, forms, role indicators)
**Testing:** 5-7 days (unit, integration, end-to-end)
**Documentation:** 2-3 days (API docs, admin guide, user guide)
**QA & Staging:** 3-5 days (full cycle testing)

**Total:** 4-5 weeks for full implementation and QA

**Phased Rollout:** Additional 1-2 weeks for gradual Phase A→B→C→D deployment

---

## 10. Related References and Next Steps

**Related Files in Codebase:**
- `src/lib/auth.ts` - Current authentication system using iron-session
- `src/lib/services/audit.service.ts` - Existing audit logging (to extend)
- `prisma/schema.prisma` - Data models (to extend)
- `src/app/api/auth/` - Authentication endpoints
- `src/app/api/books/` - Book management endpoints (to create)
- `src/app/api/user/` - User management endpoints (to create)

**Research Topics for Phase 2:**
1. **Field-Level Permissions** - Hide sensitive fields based on role
2. **API Token System** - Service account authentication with role-scoped tokens
3. **Data Masking** - Redact sensitive data (amounts, payees) for certain roles
4. **Audit Report Generation** - Export audit logs as compliance reports
5. **Webhook Notifications** - Alert on permission changes, suspicious activity
6. **Single Sign-On (SSO)** - LDAP, OAuth2, SAML integration
7. **Two-Factor Authentication (2FA)** - TOTP, SMS, hardware keys
8. **Session Management UI** - User can view/revoke active sessions

**Decision Points Before Implementation:**
1. Confirm role hierarchy (3 roles vs. custom roles)
2. Choose audit logging storage strategy (PostgreSQL vs. separate audit DB)
3. Decide on email notification requirements
4. Plan for organization/team structure (if multi-tenant)
5. Define data retention policies for audit logs

---

## Appendix A: Schema Diagram

```
gnucash_web_users
├── id (PK)
├── username
├── password_hash
└── ... other fields

    ↓ (one-to-many)

gnucash_web_book_permissions
├── id (PK)
├── user_id (FK → gnucash_web_users.id)
├── book_guid (FK → books.guid)
├── role_id (FK → gnucash_web_roles.id)
├── granted_by (FK → gnucash_web_users.id)
└── granted_at

gnucash_web_roles
├── id (PK)
├── name (UNIQUE) [readonly|edit|admin]
└── description

gnucash_web_invitations
├── id (PK)
├── code (UNIQUE, 64-char random)
├── book_guid (FK → books.guid)
├── role_id (FK → gnucash_web_roles.id)
├── created_by (FK → gnucash_web_users.id)
├── expires_at
├── used_by (FK → gnucash_web_users.id, nullable)
├── used_at
├── max_uses
├── use_count
├── is_revoked
└── revoked_by (FK → gnucash_web_users.id, nullable)

books
├── guid (PK)
├── root_account_guid
└── ... other fields

gnucash_web_audit (extended)
├── id (PK)
├── user_id (FK → gnucash_web_users.id)
├── action
├── entity_type
├── entity_guid
├── book_guid (NEW)
├── permission_action (NEW)
├── ip_address (NEW)
├── session_id (NEW)
└── created_at
```

---

## Appendix B: Glossary

| Term | Definition |
|------|-----------|
| RBAC | Role-Based Access Control - authorization system based on user roles |
| Role | A set of permissions assigned to users (readonly, edit, admin) |
| Permission | A specific action a user is allowed to perform |
| Book | A GnuCash file/database containing financial data |
| Audit Log | Record of who did what, when, and where |
| Session | Active user login state stored in secure cookie |
| CSRF | Cross-Site Request Forgery - attack requiring token protection |
| Invitation | Shareable link granting temporary access to a book |
| Grant | Process of giving a user permission to access a book |
| Revoke | Process of removing a user's permission to access a book |
| Cascade | Database operation that propagates to related records |
| Epoch | Unix timestamp (seconds since Jan 1, 1970) |
| TTL | Time-To-Live - how long cached data remains valid |

---

## Appendix C: SQL Creation Scripts

Complete, production-ready SQL for RBAC tables:

```sql
-- ============================================
-- GnuCash Web RBAC Tables
-- Production-ready creation script
-- ============================================

-- 1. Role reference table
CREATE TABLE IF NOT EXISTS gnucash_web_roles (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) UNIQUE NOT NULL,
    description TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT role_names CHECK (name IN ('readonly', 'edit', 'admin')),
    INDEX idx_name (name)
);

-- 2. Book permissions table
CREATE TABLE IF NOT EXISTS gnucash_web_book_permissions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    book_guid VARCHAR(32) NOT NULL,
    role_id INTEGER NOT NULL,
    granted_by INTEGER,
    granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_user FOREIGN KEY (user_id)
        REFERENCES gnucash_web_users(id) ON DELETE CASCADE,
    CONSTRAINT fk_book FOREIGN KEY (book_guid)
        REFERENCES books(guid) ON DELETE CASCADE,
    CONSTRAINT fk_role FOREIGN KEY (role_id)
        REFERENCES gnucash_web_roles(id),
    CONSTRAINT fk_granted_by FOREIGN KEY (granted_by)
        REFERENCES gnucash_web_users(id) ON DELETE SET NULL,

    UNIQUE KEY unique_user_book (user_id, book_guid),

    INDEX idx_user_book (user_id, book_guid),
    INDEX idx_book_role (book_guid, role_id),
    INDEX idx_user_role (user_id, role_id),
    INDEX idx_granted_by (granted_by)
);

-- 3. Invitations table
CREATE TABLE IF NOT EXISTS gnucash_web_invitations (
    id SERIAL PRIMARY KEY,
    code VARCHAR(64) UNIQUE NOT NULL,
    book_guid VARCHAR(32) NOT NULL,
    role_id INTEGER NOT NULL,
    created_by INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NOT NULL,
    used_by INTEGER,
    used_at TIMESTAMP,
    max_uses INTEGER DEFAULT 1,
    use_count INTEGER DEFAULT 0,
    is_revoked BOOLEAN DEFAULT FALSE,
    revoked_by INTEGER,
    revoked_at TIMESTAMP,

    CONSTRAINT fk_book FOREIGN KEY (book_guid)
        REFERENCES books(guid) ON DELETE CASCADE,
    CONSTRAINT fk_role FOREIGN KEY (role_id)
        REFERENCES gnucash_web_roles(id),
    CONSTRAINT fk_created_by FOREIGN KEY (created_by)
        REFERENCES gnucash_web_users(id) ON DELETE CASCADE,
    CONSTRAINT fk_used_by FOREIGN KEY (used_by)
        REFERENCES gnucash_web_users(id) ON DELETE SET NULL,
    CONSTRAINT fk_revoked_by FOREIGN KEY (revoked_by)
        REFERENCES gnucash_web_users(id) ON DELETE SET NULL,

    INDEX idx_code (code),
    INDEX idx_book_active (book_guid, is_revoked, expires_at),
    INDEX idx_creator (created_by),
    INDEX idx_expires_at (expires_at)
);

-- 4. Seed default roles
INSERT INTO gnucash_web_roles (name, description) VALUES
    ('readonly', 'View-only access to book data and reports'),
    ('edit', 'Can create, edit, and delete transactions; manage budgets and accounts'),
    ('admin', 'Full access including user management and book administration')
ON CONFLICT (name) DO NOTHING;

-- 5. Extend audit table (optional, if not already present)
ALTER TABLE gnucash_web_audit
ADD COLUMN IF NOT EXISTS book_guid VARCHAR(32),
ADD COLUMN IF NOT EXISTS permission_action VARCHAR(50),
ADD COLUMN IF NOT EXISTS ip_address VARCHAR(45),
ADD COLUMN IF NOT EXISTS session_id VARCHAR(128),
ADD COLUMN IF NOT EXISTS request_id VARCHAR(36);

-- Create audit indexes for book-specific queries
CREATE INDEX IF NOT EXISTS idx_audit_book_date
    ON gnucash_web_audit(book_guid, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_user_date
    ON gnucash_web_audit(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_permission
    ON gnucash_web_audit(permission_action, created_at DESC);
```

---

**Document Version:** 1.0
**Created:** February 8, 2025
**Status:** Research & Planning (Pre-Implementation)
**Author:** Claude Code Assistant

**Note:** This document is RESEARCH ONLY and represents a proposed architecture. No implementation code is included. All SQL and pseudocode are for reference and planning purposes only.

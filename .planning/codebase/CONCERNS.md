# Codebase Concerns

**Analysis Date:** 2026-01-14

## Tech Debt

**No Testing Framework:**
- Issue: No tests exist for any code
- Files: Entire codebase
- Why: Rapid initial development
- Impact: Cannot verify behavior, risky refactoring, no regression protection
- Fix approach: Add Vitest + React Testing Library, prioritize testing validation logic in `src/lib/validation.ts`

**Console Logging for Errors:**
- Issue: Using console.error instead of structured logging
- Files: `src/lib/db-init.ts`, `src/components/AccountLedger.tsx`, `src/components/TransactionJournal.tsx`, `src/app/api/**/*.ts` (all API routes)
- Why: Quick development
- Impact: Hard to aggregate logs, no context/correlation, poor debugging in production
- Fix approach: Add pino or winston logging with structured output

## Known Bugs

**None documented**
- No TODO/FIXME/HACK comments found in codebase
- No known issues tracked

## Security Considerations

**No Authentication:**
- Risk: Application is completely open - anyone with network access can view/modify financial data
- Files: All routes in `src/app/api/**/*.ts` and pages in `src/app/(main)/**/*.tsx`
- Current mitigation: None
- Recommendations: Add authentication (NextAuth.js, Supabase Auth, or similar), protect all routes

**Direct SQL Queries with User Input:**
- Risk: Potential SQL injection if input not properly parameterized
- Files: `src/app/api/transactions/route.ts`, `src/app/api/accounts/[guid]/transactions/route.ts`
- Current mitigation: Using parameterized queries (`$1`, `$2` placeholders)
- Recommendations: Review all query builders, consider an ORM for additional safety layer

**No Input Sanitization on Search:**
- Risk: Search terms passed directly to ILIKE patterns
- Files: `src/app/api/transactions/route.ts:103-114`
- Current mitigation: Parameterized query prevents SQL injection
- Recommendations: Consider limiting search input length, sanitizing special characters

## Performance Bottlenecks

**N+1 Query Pattern Avoided:**
- The API correctly fetches transactions then splits in two queries
- Files: `src/app/api/transactions/route.ts:180-202`
- Current approach is efficient

**Large Account Hierarchies:**
- Problem: Recursive CTE for account_hierarchy runs on every page load
- Files: `src/lib/db-init.ts`, `src/app/(main)/layout.tsx`
- Measurement: Not measured, but CTE runs once per layout mount
- Cause: View is CREATE OR REPLACE on every init
- Improvement path: Check if view exists before recreating, or create once and cache

**Client-Side Balance Aggregation:**
- Problem: `getAggregatedBalances` recursively calculates balances in browser
- Files: `src/components/AccountHierarchy.tsx:63-76`
- Measurement: Not measured, depends on account tree size
- Cause: All calculations done client-side on every render
- Improvement path: Calculate aggregated balances server-side or memoize more aggressively

## Fragile Areas

**Database View Initialization:**
- Files: `src/lib/db-init.ts`
- Why fragile: Runs on every main layout mount, silent failure allowed
- Common failures: Permission errors on CREATE OR REPLACE VIEW
- Safe modification: Test view changes in separate environment first
- Test coverage: None

**Reconciliation Bulk Update:**
- Files: `src/app/api/splits/bulk/reconcile/route.ts`, `src/components/ReconciliationPanel.tsx`
- Why fragile: Bulk updates multiple splits in single request, no transaction wrapper
- Common failures: Partial updates if one split fails
- Safe modification: Wrap in database transaction
- Test coverage: None

## Scaling Limits

**PostgreSQL Connection Pool:**
- Current capacity: Default pg pool (10 connections)
- Limit: Connection exhaustion under high concurrent load
- Symptoms at limit: Connection timeout errors
- Scaling path: Configure pool size in `src/lib/db.ts`, add connection pooling proxy (PgBouncer)

**Infinite Scroll Without Virtualization:**
- Current capacity: Hundreds of transactions render fine
- Limit: Thousands of transactions will slow DOM
- Symptoms at limit: Janky scrolling, high memory usage
- Scaling path: Add virtual scrolling (react-window, @tanstack/virtual)

## Dependencies at Risk

**next-pwa:**
- Risk: Last major update was 2023, may have compatibility issues with Next.js 16
- Impact: PWA functionality could break on Next.js upgrades
- Migration plan: Monitor for alternatives like @ducanh2912/next-pwa or Serwist

**swagger-ui-react:**
- Risk: Heavy dependency for documentation feature
- Impact: Bundle size increase
- Migration plan: Consider moving to static OpenAPI spec + external Swagger UI

## Missing Critical Features

**No Authentication/Authorization:**
- Problem: Financial data exposed without access control
- Current workaround: Assume trusted network
- Blocks: Multi-user deployment, public-facing deployment
- Implementation complexity: Medium (NextAuth.js integration)

**No Audit Trail:**
- Problem: No record of who made changes or when (beyond enter_date)
- Current workaround: None
- Blocks: Compliance requirements, debugging data issues
- Implementation complexity: Low (add audit log table)

**No Data Backup/Export:**
- Problem: No way to backup or export data from the web interface
- Current workaround: Direct database backup
- Blocks: Data portability, disaster recovery from UI
- Implementation complexity: Low (export endpoints)

## Test Coverage Gaps

**Entire Codebase:**
- What's not tested: All code (no test framework configured)
- Risk: Any change could break functionality undetected
- Priority: High
- Difficulty to test: Medium (need to add Vitest, mock database)

**Validation Logic:**
- What's not tested: `src/lib/validation.ts` - Transaction validation
- Risk: Invalid transactions could be saved
- Priority: High (data integrity)
- Difficulty to test: Low (pure functions, easy to unit test)

**Numeric Conversion:**
- What's not tested: `src/lib/db.ts` - toDecimal function
- Risk: Incorrect balance calculations
- Priority: High (financial accuracy)
- Difficulty to test: Low (pure function)

---

*Concerns audit: 2026-01-14*
*Update as issues are fixed or new ones discovered*

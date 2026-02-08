# Account Caching Optimization Plan

**Created:** 2026-02-04
**Status:** Ready for Review
**Complexity:** Medium
**Estimated Tasks:** 8

---

## 1. Problem Statement

Currently, when users change the date range filter on the Accounts page, the entire `/api/accounts` endpoint is called, fetching ALL account data including:
- Static hierarchy (names, types, parent relationships, codes, descriptions)
- Dynamic balances (total_balance, period_balance, USD conversions)

This is wasteful because:
1. **Account hierarchy NEVER changes based on dates** - it's static metadata
2. **Only balance values need updating** when dates change
3. **The current query fetches ALL splits** for EVERY account on EVERY request
4. **Payload size is unnecessarily large** (~100KB+ when ~5KB would suffice for balance updates)

### Current Flow (Inefficient)
```
Date Change -> Full API call -> Fetch all accounts + ALL splits -> Calculate balances -> Return ~100KB
```

### Proposed Flow (Optimized)
```
Initial Load -> Hierarchy API (cached indefinitely) -> Return ~50KB static data
Date Change -> Balances API (date-filtered) -> Return ~5KB balance data
Client -> Merge hierarchy + balances in useMemo
```

---

## 2. Requirements Summary

### Functional Requirements
1. **FR-1:** Create a new `/api/accounts/balances` endpoint that returns only balance data
2. **FR-2:** Add a `noBalances` query parameter to existing `/api/accounts` endpoint
3. **FR-3:** Split `useAccounts` hook into two queries: hierarchy (static) and balances (dynamic)
4. **FR-4:** Client-side merging of hierarchy and balance data via `useMemo`
5. **FR-5:** Maintain full backward compatibility with existing API consumers

### Non-Functional Requirements
1. **NFR-1:** Hierarchy query should use `staleTime: Infinity` (never refetch)
2. **NFR-2:** Balance query should use `staleTime: 5 * 60 * 1000` (5 minutes)
3. **NFR-3:** Balance API response should be <10KB for typical account set
4. **NFR-4:** Date range change should NOT trigger hierarchy refetch
5. **NFR-5:** Initial page load should not be slower than current implementation

---

## 3. Acceptance Criteria

### AC-1: Balance-Only Endpoint Works
- [ ] `GET /api/accounts/balances` returns array of `AccountBalance` objects
- [ ] Response includes: `guid`, `total_balance`, `period_balance`, `total_balance_usd`, `period_balance_usd`
- [ ] Accepts `startDate` and `endDate` query parameters
- [ ] Uses SQL aggregation for performance (no client-side iteration over splits)

### AC-2: Hierarchy Endpoint Works
- [ ] `GET /api/accounts?flat=false&noBalances=true` returns hierarchy without balance data
- [ ] Balance fields are null/undefined when `noBalances=true`
- [ ] Response is significantly smaller than full response

### AC-3: Hook Separation Works
- [ ] `useAccounts` internally manages two separate React Query calls
- [ ] Changing date range does NOT invalidate hierarchy cache
- [ ] Hierarchy data persists across date changes
- [ ] Combined data shape matches original `AccountWithChildren[]` interface

### AC-4: UI Behavior Unchanged
- [ ] AccountHierarchy component renders identically to before
- [ ] Date range picker updates balances without visual flicker
- [ ] Loading states are appropriate (only balance loading on date change)
- [ ] Error handling works for both queries independently

### AC-5: Performance Improvement Verified
- [ ] Balance-only requests complete faster than full requests
- [ ] Network payload for balance updates is <10KB
- [ ] React Query devtools shows separate cache entries for hierarchy/balances

### AC-6: Investment Account USD Conversion Correct
- [ ] Investment accounts (STOCK/MUTUAL) have `total_balance_usd` and `period_balance_usd` populated
- [ ] Non-investment accounts do NOT have `_usd` fields (or they are undefined)
- [ ] USD values match the current full API response

---

## 4. Technical Design

### 4.1 New Type: AccountBalance

**File:** `src/lib/types.ts`

```typescript
export interface AccountBalance {
    guid: string;
    total_balance: string;
    period_balance: string;
    total_balance_usd?: string;
    period_balance_usd?: string;
}
```

### 4.2 New API Endpoint: /api/accounts/balances

**File:** `src/app/api/accounts/balances/route.ts`

Purpose: Return only balance data for all accounts, using optimized SQL aggregation.

Key implementation details:
1. Use a single SQL query with `GROUP BY account_guid` instead of fetching all splits
2. Apply date filtering in SQL WHERE clause, not in JavaScript
3. Handle investment accounts (STOCK/MUTUAL) with price lookups
4. Return minimal payload: `{ guid, total_balance, period_balance, total_balance_usd?, period_balance_usd? }[]`

SQL approach (includes account metadata for investment detection):
```sql
SELECT
    s.account_guid,
    a.account_type,
    a.commodity_guid,
    c.namespace as commodity_namespace,
    SUM(s.quantity_num::decimal / s.quantity_denom) as total_balance,
    SUM(
        CASE
            WHEN t.post_date >= $1 AND t.post_date <= $2
            THEN s.quantity_num::decimal / s.quantity_denom
            ELSE 0
        END
    ) as period_balance
FROM splits s
JOIN transactions t ON s.tx_guid = t.guid
JOIN accounts a ON s.account_guid = a.guid
LEFT JOIN commodities c ON a.commodity_guid = c.guid
GROUP BY s.account_guid, a.account_type, a.commodity_guid, c.namespace
```

**Investment Account Handling (Architect Guidance):**
After the SQL query, the API must:
1. Identify investment accounts: `account_type IN ('STOCK', 'MUTUAL') AND commodity_namespace != 'CURRENCY'`
2. Batch-fetch prices for unique `commodity_guid` values using `getLatestPrice()` from `src/lib/commodities.ts:38-71`
3. Calculate USD values: `total_balance_usd = total_balance * price`
4. Return: Investment accounts get `_usd` fields; regular accounts omit them

**Client-Side Aggregation Note:**
The balance API returns **flat, non-aggregated balances** (one row per account). The client-side `getAggregatedBalances()` function in `AccountHierarchy.tsx:77-108` continues to handle hierarchical aggregation because it depends on UI state (showHidden, balanceReversal preferences) that the server cannot know.

### 4.3 Modify Existing API: noBalances Parameter

**File:** `src/app/api/accounts/route.ts`

Add `noBalances` query parameter that:
1. Skips fetching splits from database
2. Skips balance calculation loop
3. Sets balance fields to undefined
4. Returns hierarchy structure without balance data

### 4.4 Refactor Hook: useAccounts

**File:** `src/lib/hooks/useAccounts.ts`

Split into two internal queries:

```typescript
// Query 1: Static hierarchy (cached indefinitely)
const hierarchyQuery = useQuery({
    queryKey: ['accounts', 'hierarchy', { flat }],
    queryFn: () => fetchAccountHierarchy(flat),
    staleTime: Infinity,
    gcTime: 1000 * 60 * 60 * 24, // 24 hours
});

// Query 2: Dynamic balances (refetch on date change)
const balancesQuery = useQuery({
    queryKey: ['accounts', 'balances', { startDate, endDate }],
    queryFn: () => fetchAccountBalances(startDate, endDate),
    staleTime: 1000 * 60 * 5, // 5 minutes
    enabled: !flat, // Only fetch balances when not in flat mode
});
```

Merge logic in `useMemo`:
```typescript
const mergedAccounts = useMemo(() => {
    if (!hierarchyQuery.data || !balancesQuery.data) return undefined;
    return mergeAccountsWithBalances(hierarchyQuery.data, balancesQuery.data);
}, [hierarchyQuery.data, balancesQuery.data]);
```

---

## 5. Implementation Steps

### Task 1: Add AccountBalance Type
**File:** `src/lib/types.ts`
**Lines:** After line 67 (after Account interface)
**Effort:** Small

Add the `AccountBalance` interface to types.ts.

### Task 2: Create Balance-Only API Endpoint
**File:** `src/app/api/accounts/balances/route.ts` (NEW)
**Effort:** Medium

Create new Next.js route handler with:
- SQL aggregation query for balances
- Date parameter handling
- Investment account USD conversion
- Price cache for efficiency

### Task 3: Add noBalances Parameter to Accounts API
**File:** `src/app/api/accounts/route.ts`
**Lines:** 37-177 (GET handler)
**Effort:** Small

Modify to:
- Parse `noBalances` query param (line ~42)
- Skip splits include when noBalances=true (line ~114)
- Skip balance calculation when noBalances=true (lines ~143-157)
- Return hierarchy with undefined balances

### Task 4: Create mergeAccountsWithBalances Utility
**File:** `src/lib/hooks/useAccounts.ts` (or new utility file)
**Effort:** Small

Helper function to recursively merge balances into the nested hierarchy:

```typescript
function mergeAccountsWithBalances(
    hierarchy: AccountWithChildren[],
    balances: AccountBalance[]
): AccountWithChildren[] {
    // Build lookup map for O(1) balance access
    const balanceMap = new Map(balances.map(b => [b.guid, b]));

    // Recursive merge function for nested children
    function mergeNode(node: AccountWithChildren): AccountWithChildren {
        const balance = balanceMap.get(node.guid);
        return {
            ...node,
            total_balance: balance?.total_balance ?? '0',
            period_balance: balance?.period_balance ?? '0',
            total_balance_usd: balance?.total_balance_usd,
            period_balance_usd: balance?.period_balance_usd,
            children: node.children.map(mergeNode), // RECURSIVE traversal
        };
    }

    return hierarchy.map(mergeNode);
}
```

**Key Points:**
- Uses Map for O(1) balance lookups (vs O(n) array.find)
- Recursively traverses nested `children` array in `AccountWithChildren`
- Preserves all existing account properties via spread
- Returns new objects (immutable, React-friendly)

### Task 5: Refactor useAccounts Hook
**File:** `src/lib/hooks/useAccounts.ts`
**Lines:** 10-29 (entire useAccounts function)
**Effort:** Medium

Refactor to:
- Use two separate useQuery calls
- Implement conditional balance fetching
- Merge results in useMemo
- Handle loading/error states from both queries
- Maintain backward-compatible return type

### Task 6: Add Loading State Differentiation
**File:** `src/lib/hooks/useAccounts.ts`
**Effort:** Small

Return additional metadata:
- `isHierarchyLoading`
- `isBalancesLoading`
- `isInitialLoad` (both loading)

### Task 7: Update AccountsPage Loading UI (Optional)
**File:** `src/app/(main)/accounts/page.tsx`
**Lines:** 37-50 (loading/error handling)
**Effort:** Small

Optionally show different loading state when only balances are loading (lighter spinner, no full page loader).

### Task 8: Verification and Testing
**Effort:** Medium

Manual verification:
1. Initial load shows full hierarchy with balances
2. Date range change only fetches balances
3. React Query devtools shows separate cache entries
4. Network tab shows smaller payload on date change
5. All existing functionality works correctly

---

## 6. Risk Assessment

### Risk 1: Race Condition on Initial Load
**Likelihood:** Low
**Impact:** Medium
**Mitigation:** Use React Query's built-in request deduplication. Both queries can run in parallel; the merge only happens when both complete.

### Risk 2: Stale Balance Data
**Likelihood:** Low
**Impact:** Low
**Mitigation:** 5-minute staleTime is reasonable for financial data that doesn't change frequently. Users can manually refresh if needed. Consider adding a refresh button.

### Risk 3: Investment Account Price Lookup Performance
**Likelihood:** Medium
**Impact:** Low
**Mitigation:** Reuse existing price cache pattern from accounts route. Pre-fetch all needed prices in a single batch query.

### Risk 4: Breaking Existing Consumers
**Likelihood:** Low
**Impact:** High
**Mitigation:** The `noBalances` parameter is opt-in. Existing calls without this parameter return identical data. The hook maintains the same return type signature.

### Risk 5: Memory Usage with Large Account Sets
**Likelihood:** Low
**Impact:** Low
**Mitigation:** The separate caching actually improves memory efficiency - hierarchy is cached once, only balance data refreshes. No duplicate account metadata in memory.

---

## 7. File Change Summary

| File | Action | Description |
|------|--------|-------------|
| `src/lib/types.ts` | MODIFY | Add `AccountBalance` interface |
| `src/app/api/accounts/balances/route.ts` | CREATE | New balance-only endpoint |
| `src/app/api/accounts/route.ts` | MODIFY | Add `noBalances` parameter support |
| `src/lib/hooks/useAccounts.ts` | MODIFY | Split into hierarchy + balances queries |
| `src/app/(main)/accounts/page.tsx` | MODIFY (Optional) | Enhanced loading state |

---

## 8. Verification Steps

### 8.1 API Verification
```bash
# Test hierarchy-only endpoint
curl "http://localhost:3000/api/accounts?flat=false&noBalances=true"
# Should return hierarchy without total_balance/period_balance fields

# Test balance-only endpoint
curl "http://localhost:3000/api/accounts/balances?startDate=2025-01-01&endDate=2025-12-31"
# Should return array of {guid, total_balance, period_balance, ...}

# Test full endpoint (backward compat)
curl "http://localhost:3000/api/accounts?flat=false&startDate=2025-01-01&endDate=2025-12-31"
# Should return identical data to before
```

### 8.2 UI Verification
1. Open Accounts page with React Query devtools open
2. Verify two cache entries: `['accounts', 'hierarchy', ...]` and `['accounts', 'balances', ...]`
3. Change date range
4. Verify ONLY balances query refetches (hierarchy cache hit)
5. Verify Network tab shows ~5KB balance request, not ~100KB full request
6. Verify balances update correctly in UI

### 8.3 Performance Verification
1. Compare initial load time: should be similar or slightly better
2. Compare date change response time: should be significantly faster
3. Compare network payload sizes: balance-only should be 5-10x smaller

---

## 9. Rollback Plan

If issues are discovered:
1. Revert `useAccounts.ts` to single-query implementation
2. Keep new `/api/accounts/balances` endpoint (no harm)
3. Keep `noBalances` parameter (no harm, opt-in)
4. Existing consumers unaffected

---

## 10. Future Enhancements (Out of Scope)

1. **Real-time balance updates:** WebSocket or Server-Sent Events for live balance updates
2. **Partial hierarchy fetching:** Only fetch visible nodes (virtual scrolling)
3. **Balance caching on server:** Redis cache for computed balances
4. **Background balance refresh:** Service worker to pre-fetch balance updates

---

## Commit Strategy

### Commit 1: Types and Balance API
- Add `AccountBalance` type
- Create `/api/accounts/balances/route.ts`
- Message: "feat(api): add balance-only endpoint for account caching optimization"

### Commit 2: Modify Existing API
- Add `noBalances` parameter to `/api/accounts`
- Message: "feat(api): add noBalances parameter to accounts endpoint"

### Commit 3: Refactor Hook
- Split `useAccounts` into hierarchy + balances queries
- Add merge utility
- Message: "refactor(hooks): split useAccounts into hierarchy and balances queries"

### Commit 4: Optional UI Enhancement
- Update loading states if implementing
- Message: "feat(ui): differentiate loading states for hierarchy vs balances"

# Account Caching Optimization - Learnings

## Completed Refactoring: Split Hierarchy and Balances Queries

### Architecture Changes

Successfully refactored `src/lib/hooks/useAccounts.ts` to use two separate React Query calls:

1. **Hierarchy Query** (`queryKey: ['accounts', 'hierarchy', { flat }]`)
   - Fetches static account structure without balances
   - Uses `noBalances=true` API parameter
   - Cached with `staleTime: Infinity` (never stale)
   - `gcTime: 24 hours`

2. **Balances Query** (`queryKey: ['accounts', 'balances', { startDate, endDate }]`)
   - Fetches dynamic balance data for date ranges
   - Uses separate `/api/accounts/balances` endpoint
   - `staleTime: 5 minutes`
   - Only enabled when `flat: false`

### Key Implementation Details

#### Recursive Merge Function
```typescript
function mergeAccountsWithBalances(
    hierarchy: AccountWithChildren[],
    balances: AccountBalance[]
): AccountWithChildren[]
```
- Uses `Map` for O(1) balance lookups
- Recursively merges balances into hierarchy tree
- Handles missing balances gracefully (defaults to '0')

#### Loading States
Exposed multiple loading states for fine-grained UI control:
- `isLoading` - Overall loading state
- `isHierarchyLoading` - Hierarchy query loading
- `isBalancesLoading` - Balances query loading
- `isInitialLoad` - Both queries loading

#### Backward Compatibility
- Return type remains `Account[] | AccountWithChildren[]`
- Existing components (`AccountHierarchy`, `AccountSelector`, `TransactionForm`) work without changes
- `useInvalidateAccounts()` invalidates both queries with single call

### Performance Benefits

1. **Date Changes**: Only refetch balances, hierarchy stays cached
2. **Initial Load**: Show hierarchy immediately, balances merge when ready
3. **Flat Mode**: Skip balances query entirely (used by selectors)

### API Support

Both required API endpoints already existed:
- `/api/accounts?noBalances=true` - Returns hierarchy without balances
- `/api/accounts/balances?startDate=X&endDate=Y` - Returns balance array

### TypeScript Validation

Ran `npx tsc --noEmit` - No errors. All type safety maintained.

### Pattern for Future Optimizations

This split-query pattern can be applied elsewhere:
- Static structure + dynamic data = separate queries
- Use `useMemo` to merge results efficiently
- Expose granular loading states for better UX

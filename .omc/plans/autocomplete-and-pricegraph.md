# Work Plan: Account-Scoped Autocomplete & Recharts Price Graph

**Created:** 2026-02-04
**Status:** Ready for Implementation

---

## Context

### Original Request
Implement two features:
1. Account-scoped transaction description autocomplete
2. Replace CSS bar chart with recharts LineChart for investment price history

### Research Findings

**Feature 1 - Autocomplete:**
- `DescriptionAutocomplete.tsx` (237 lines) searches ALL transactions globally via `/api/transactions/descriptions?q={query}`
- API route (72 lines) uses Prisma to search `transactions.description` with case-insensitive match
- `TransactionForm.tsx` has account context available at `simpleData.fromAccountGuid` (line 56)
- Component already supports `onSelectSuggestion` callback for auto-filling related fields

**Feature 2 - Price Graph:**
- Current implementation: Simple CSS bar chart at lines 233-261 in `InvestmentAccount.tsx`
- Data structure: `priceHistory` array with `{ guid, date, value, source }` objects
- **recharts is NOT installed** - confirmed in package.json (no recharts dependency)
- App uses cyan accent (#06b6d4) and dark theme (neutral-900 backgrounds)

---

## Work Objectives

### Core Objective
Enhance transaction entry UX with account-relevant suggestions and modernize investment price visualization.

### Deliverables
1. Account-filtered description autocomplete component
2. Updated API endpoint with optional account filtering
3. Professional LineChart for investment price history using recharts

### Definition of Done
- [ ] Autocomplete shows account-specific transactions first (when account selected)
- [ ] Falls back to global search when no account context
- [ ] Price chart renders with proper date formatting and tooltips
- [ ] Both features match existing dark theme styling
- [ ] No TypeScript errors, all existing functionality preserved

---

## Guardrails

### MUST Have
- Backward compatible API (existing calls without account_guid continue working)
- Account filtering uses Prisma joins (not post-fetch filtering)
- recharts installed as production dependency
- Responsive chart that works on mobile

### MUST NOT Have
- Breaking changes to existing autocomplete consumers
- Hard-coded currency assumptions in price chart
- Performance regressions (API should remain fast)

---

## Task Flow

```
[Task 1: Install recharts]
       |
       v
[Task 2: Update API] --> [Task 3: Update Autocomplete Component]
       |                            |
       v                            v
[Task 4: Wire TransactionForm] [Task 5: Implement Price Chart]
       |                            |
       +------------+---------------+
                    |
                    v
            [Task 6: Verification]
```

---

## Detailed TODOs

### Task 1: Install recharts Dependency
**Priority:** P0 (Blocker for Task 5)
**Estimated Time:** 2 minutes

**Steps:**
1. Run `npm install recharts`
2. Verify installation in package.json
3. Ensure no peer dependency conflicts

**Acceptance Criteria:**
- [ ] recharts appears in package.json dependencies
- [ ] `npm run build` passes without errors

---

### Task 2: Update Description Suggestions API
**Priority:** P0
**Estimated Time:** 15 minutes
**File:** `src/app/api/transactions/descriptions/route.ts`

**Current Code (lines 25-44):**
```typescript
const transactions = await prisma.transactions.findMany({
  where: {
    description: {
      contains: query,
      mode: 'insensitive'
    }
  },
  orderBy: {
    post_date: 'desc'
  },
  take: limit * 2,
  distinct: ['description'],
  include: {
    splits: {
      include: {
        account: true
      }
    }
  }
});
```

**Required Changes:**
1. Parse optional `account_guid` query parameter (line 17)
2. Add conditional `where` clause to filter by account when provided
3. Filter via splits join: `splits: { some: { account_guid: accountGuid } }`

**New Code Structure:**
```typescript
const accountGuid = searchParams.get('account_guid');

const whereClause: Prisma.transactionsWhereInput = {
  description: {
    contains: query,
    mode: 'insensitive'
  }
};

// Add account filtering if provided
if (accountGuid) {
  whereClause.splits = {
    some: {
      account_guid: accountGuid
    }
  };
}

const transactions = await prisma.transactions.findMany({
  where: whereClause,
  // ... rest unchanged
});
```

**Acceptance Criteria:**
- [ ] API accepts optional `account_guid` parameter
- [ ] `/api/transactions/descriptions?q=test&account_guid=xyz` filters by account
- [ ] `/api/transactions/descriptions?q=test` (no account) returns global results
- [ ] Type-safe with Prisma types

---

### Task 3: Update DescriptionAutocomplete Component
**Priority:** P1
**Estimated Time:** 10 minutes
**File:** `src/components/ui/DescriptionAutocomplete.tsx`

**Current Interface (lines 7-14):**
```typescript
interface DescriptionAutocompleteProps {
  value: string;
  onChange: (value: string) => void;
  onSelectSuggestion?: (suggestion: TransactionSuggestion) => void;
  placeholder?: string;
  className?: string;
  hasError?: boolean;
}
```

**Required Changes:**
1. Add `accountGuid?: string` prop to interface (line 13)
2. Add `accountGuid` to component destructuring (line 23)
3. Update API call (line 51) to include account_guid when provided

**New API Call (line 51):**
```typescript
const params = new URLSearchParams({
  q: value,
  limit: '10'
});
if (accountGuid) {
  params.append('account_guid', accountGuid);
}
const response = await fetch(`/api/transactions/descriptions?${params.toString()}`);
```

**Acceptance Criteria:**
- [ ] New `accountGuid` prop is optional (backward compatible)
- [ ] API call includes account_guid when prop provided
- [ ] Component works without accountGuid (existing behavior)

---

### Task 4: Wire TransactionForm to Pass Account Context
**Priority:** P1
**Estimated Time:** 5 minutes
**File:** `src/components/TransactionForm.tsx`

**Current Usage (lines 528-534):**
```typescript
<DescriptionAutocomplete
  value={formData.description}
  onChange={(value) => setFormData(f => ({ ...f, description: value }))}
  onSelectSuggestion={handleDescriptionSelect}
  placeholder="Enter description..."
  hasError={!!fieldErrors.description}
/>
```

**Required Changes:**
Add `accountGuid` prop with context from simple mode:
```typescript
<DescriptionAutocomplete
  value={formData.description}
  onChange={(value) => setFormData(f => ({ ...f, description: value }))}
  onSelectSuggestion={handleDescriptionSelect}
  accountGuid={simpleData.fromAccountGuid || undefined}
  placeholder="Enter description..."
  hasError={!!fieldErrors.description}
/>
```

**Acceptance Criteria:**
- [ ] Autocomplete receives fromAccountGuid when in simple mode
- [ ] Passes undefined when no account selected (triggers global search)
- [ ] Works correctly in advanced mode (no account filtering)

---

### Task 5: Implement recharts Price Graph
**Priority:** P1
**Estimated Time:** 25 minutes
**File:** `src/components/InvestmentAccount.tsx`

**Current Implementation (lines 233-261):**
Simple CSS bar chart with divs and inline styles.

**Required Changes:**
1. Add recharts imports at top of file:
   ```typescript
   import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
   ```

2. Replace lines 233-261 with recharts implementation:
   ```typescript
   {/* Price History Chart */}
   {priceHistory && priceHistory.length > 0 && (
     <div className="bg-neutral-900/30 backdrop-blur-xl border border-neutral-800 rounded-2xl p-6">
       <h3 className="text-lg font-semibold text-neutral-100 mb-4">Price History</h3>
       <div className="h-64">
         <ResponsiveContainer width="100%" height="100%">
           <LineChart data={priceHistory.slice(-30)}>
             <XAxis
               dataKey="date"
               tick={{ fill: '#737373', fontSize: 12 }}
               tickFormatter={(date) => new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
               stroke="#404040"
             />
             <YAxis
               tick={{ fill: '#737373', fontSize: 12 }}
               tickFormatter={(value) => `$${value.toFixed(2)}`}
               stroke="#404040"
               domain={['auto', 'auto']}
             />
             <Tooltip
               contentStyle={{
                 backgroundColor: '#171717',
                 border: '1px solid #404040',
                 borderRadius: '8px'
               }}
               labelStyle={{ color: '#a3a3a3' }}
               formatter={(value: number) => [`$${value.toFixed(2)}`, 'Price']}
               labelFormatter={(date) => new Date(date).toLocaleDateString('en-US', {
                 weekday: 'short',
                 month: 'short',
                 day: 'numeric',
                 year: 'numeric'
               })}
             />
             <Line
               type="monotone"
               dataKey="value"
               stroke="#06b6d4"
               strokeWidth={2}
               dot={false}
               activeDot={{ r: 4, fill: '#06b6d4' }}
             />
           </LineChart>
         </ResponsiveContainer>
       </div>
     </div>
   )}
   ```

**Styling Notes:**
- Background: #171717 (neutral-900)
- Border: #404040 (neutral-700)
- Axis text: #737373 (neutral-500)
- Line color: #06b6d4 (cyan-500)
- Grid lines: removed for cleaner look

**Acceptance Criteria:**
- [ ] LineChart renders price history data
- [ ] X-axis shows formatted dates (e.g., "Jan 15")
- [ ] Y-axis shows formatted prices (e.g., "$150.00")
- [ ] Tooltip shows full date and price on hover
- [ ] Chart is responsive (uses ResponsiveContainer)
- [ ] Matches app's dark theme
- [ ] Shows last 30 data points (matching previous behavior)

---

### Task 6: Verification
**Priority:** P0
**Estimated Time:** 10 minutes

**Steps:**
1. Build verification: `npm run build`
2. TypeScript check: `npx tsc --noEmit`
3. Manual testing:
   - Test autocomplete with account selected vs. no account
   - Verify price chart renders on investment account page
   - Test tooltip interactions
   - Verify mobile responsiveness

**Acceptance Criteria:**
- [ ] Build passes without errors
- [ ] No TypeScript errors
- [ ] Autocomplete filters correctly by account
- [ ] Price chart renders correctly with sample data
- [ ] Both features work on mobile viewport

---

## Dependencies

### NPM Packages to Install
| Package | Version | Purpose |
|---------|---------|---------|
| recharts | ^2.x | Charting library for price graph |

### Install Command
```bash
npm install recharts
```

---

## Risk Assessment

### Low Risk
- Adding optional prop to existing component (backward compatible)
- recharts is mature, well-documented library

### Medium Risk
- Prisma query performance with splits join - mitigated by existing `distinct` and `take` limits
- recharts bundle size impact (~200KB) - acceptable for investment features

### Mitigations
- API remains backward compatible (no breaking changes)
- Account filter is optional, defaults to global search
- Chart limited to 30 data points for performance

---

## Commit Strategy

### Suggested Commits
1. `feat(deps): add recharts charting library`
2. `feat(api): add account filtering to transaction descriptions endpoint`
3. `feat(autocomplete): support account-scoped suggestions`
4. `feat(investments): replace CSS chart with recharts LineChart`

---

## Success Criteria

1. **Autocomplete Enhancement**
   - User types in description field with account selected
   - Suggestions prioritize transactions involving that account
   - Without account context, shows global results (existing behavior)

2. **Price Chart Upgrade**
   - Professional LineChart replaces basic CSS bars
   - Interactive tooltips show date and price
   - Responsive design works on all screen sizes
   - Theme-consistent styling (cyan accent, dark background)

---

## File Summary

| File | Action | Lines Changed |
|------|--------|---------------|
| `package.json` | Add dependency | +1 line |
| `src/app/api/transactions/descriptions/route.ts` | Add account filter | ~15 lines |
| `src/components/ui/DescriptionAutocomplete.tsx` | Add accountGuid prop | ~10 lines |
| `src/components/TransactionForm.tsx` | Pass accountGuid | ~2 lines |
| `src/components/InvestmentAccount.tsx` | Replace chart | ~40 lines (replace ~30) |

**Total Estimated Changes:** ~70 lines added/modified

---

## Notes for Executor

- The API change uses Prisma's `some` filter which performs an EXISTS subquery - efficient for this use case
- recharts ResponsiveContainer must have a parent with explicit height
- The current bar chart code (lines 233-261) should be completely replaced, not modified
- Consider adding a "No price data" state if priceHistory is empty (currently handled by conditional render)

# UX Improvements Phase 1 - Implementation Plan

## Context

### Original Request
Implement 5 UX improvements to enhance the GnuCash Web application:
1. Account caching with stale-while-revalidate
2. Transaction description autocomplete with smart fill
3. Dropdown keyboard navigation
4. Ctrl+Enter form submission with validation
5. Multi-currency trading account auto-generation

### Interview Summary
- User prioritizes performance and desktop-class UX
- Features should align with existing React Query infrastructure
- Multi-currency support is critical for investment accounts
- Features should degrade gracefully if APIs are slow

### Research Findings
- React Query already configured with 5min staleTime, 30min gcTime in `src/app/providers.tsx`
- `useAccounts` hook exists but only supports flat mode
- AccountSelector has search but no keyboard navigation
- TransactionForm lacks Ctrl+Enter and autocomplete
- Multi-currency transactions work but don't create Trading splits like desktop GnuCash

---

## Work Objectives

### Core Objective
Improve perceived performance and data entry efficiency by implementing caching, autocomplete, keyboard navigation, shortcut keys, and proper multi-currency accounting support.

### Deliverables
1. **Account Caching**: Accounts page uses React Query with stale-while-revalidate
2. **Description Autocomplete**: Typeahead suggestions from transaction history
3. **Keyboard Navigation**: Arrow keys in AccountSelector dropdown
4. **Ctrl+Enter Submit**: Global shortcut for forms with validation feedback
5. **Trading Accounts**: Auto-generate Trading:CURRENCY splits for multi-currency transactions

### Definition of Done
- [ ] All features pass manual testing
- [ ] No TypeScript errors (`npm run build` succeeds)
- [ ] Existing functionality not regressed
- [ ] Code follows existing patterns in codebase

---

## Implementation Tasks

### Feature 1: Account Caching with Stale-While-Revalidate

**Priority**: HIGH | **Complexity**: LOW | **Files**: 2

#### Requirements
- Accounts page should use React Query instead of raw fetch + useState
- Support date range parameters for period balances
- Cache invalidation after account CRUD operations
- Show stale data immediately while refetching

#### Acceptance Criteria
- [ ] First page load fetches from API
- [ ] Subsequent visits show cached data instantly
- [ ] Date range changes trigger refetch
- [ ] Account create/edit/delete invalidates cache
- [ ] Loading state shown only during initial fetch

#### Implementation Steps

**Task 1.1: Extend useAccounts hook**
- File: `src/lib/hooks/useAccounts.ts`
- Lines: 1-18
- Changes:
  ```typescript
  // Add options for hierarchical mode and date params
  export function useAccounts(options?: {
    flat?: boolean;
    startDate?: string;
    endDate?: string;
  })
  ```
- Include date params in queryKey for proper cache separation
- Return hierarchical data when flat=false

**Task 1.2: Replace accounts page data fetching**
- File: `src/app/(main)/accounts/page.tsx`
- Lines: 12-40
- Changes:
  - Remove: `useState<AccountWithChildren[]>([])`, `loading`, `error` state
  - Remove: `useEffect` with fetch logic (lines 16-40)
  - Add: `const { data: accounts = [], isLoading, error } = useAccounts({ flat: false, startDate, endDate })`
- Simplify component to use hook data directly

**Task 1.3: Add cache invalidation to AccountHierarchy**
- File: `src/components/AccountHierarchy.tsx`
- Lines: 353-406 (CRUD handlers)
- Changes:
  - Import `useInvalidateAccounts` from `@/lib/hooks/useAccounts`
  - After successful create/edit/delete, call invalidate function **in addition to** existing `onRefresh?.()` call
  - Keep `onRefresh` prop for backwards compatibility - it will be called after cache invalidation
  - The cache invalidation ensures React Query cache is updated; `onRefresh` allows parent to respond if needed

#### Dependencies
- None (foundational feature)

#### Risks
- **Risk**: Stale data confuses users after edits
- **Mitigation**: Ensure invalidation is called synchronously after mutations

---

### Feature 2: Transaction Description Autocomplete

**Priority**: MEDIUM | **Complexity**: MEDIUM | **Files**: 3

#### Requirements
- As user types in description field, show matching past descriptions
- Suggestions should be unique and sorted by recency
- Selecting a suggestion fills the description field
- Optional: Smart fill could auto-populate accounts from previous transaction

#### Acceptance Criteria
- [ ] Dropdown appears after typing 2+ characters
- [ ] Shows up to 10 matching descriptions
- [ ] Click or Enter selects suggestion
- [ ] Escape closes dropdown
- [ ] Suggestions sorted by most recent use

#### Implementation Steps

**Task 2.1: Create API endpoint for description suggestions**
- File: `src/app/api/transactions/descriptions/route.ts` (NEW)
- Implementation:
  ```typescript
  // GET /api/transactions/descriptions?q=searchTerm&limit=10
  // Returns: { descriptions: string[], transactions: TransactionSuggestion[] }
  // Query:
  //   SELECT description, MAX(post_date) as last_used
  //   FROM transactions
  //   WHERE description ILIKE '%q%'
  //   GROUP BY description
  //   ORDER BY last_used DESC
  //   LIMIT 10
  ```
- Also return most recent transaction data for smart fill:
  ```typescript
  // For each unique description, also return the most recent transaction's splits
  // This enables smart fill to populate accounts/amounts when a suggestion is selected
  interface TransactionSuggestion {
    description: string;
    lastUsed: string;
    splits: { accountGuid: string; amount: number }[];
  }
  ```

**Task 2.2: Create DescriptionAutocomplete component**
- File: `src/components/ui/DescriptionAutocomplete.tsx` (NEW)
- Props: `{ value, onChange, onSelect?, placeholder? }`
- Features:
  - Debounced API calls (300ms)
  - Portal-rendered dropdown (like AccountSelector)
  - Keyboard navigation (arrow keys, enter, escape)
  - Show loading indicator during fetch

**Task 2.3: Integrate into TransactionForm**
- File: `src/components/TransactionForm.tsx`
- Lines: 387-398 (description input)
- Changes:
  - Replace `<input>` with `<DescriptionAutocomplete>`
  - Handle onSelect to update form state
  - Optional: Implement smart fill to populate accounts

#### Dependencies
- Feature 3 (keyboard navigation) - can share implementation patterns

#### Risks
- **Risk**: Too many API calls causing performance issues
- **Mitigation**: Aggressive debouncing (300ms) and result caching

---

### Feature 3: Dropdown Keyboard Navigation

**Priority**: MEDIUM | **Complexity**: LOW | **Files**: 1

#### Requirements
- Arrow Up/Down moves focus through dropdown options
- Enter selects the focused option
- Tab behaves like Enter (select and move to next field)
- Escape closes dropdown without selection
- Visual indicator for focused item

#### Acceptance Criteria
- [ ] Arrow Down from input opens dropdown and focuses first item
- [ ] Arrow keys cycle through options (wrap at ends)
- [ ] Enter selects focused option
- [ ] Tab selects and moves focus to next input
- [ ] Escape closes without changing value
- [ ] Focused item has distinct visual style

#### Implementation Steps

**Task 3.1: Add keyboard handling to AccountSelector**
- File: `src/components/ui/AccountSelector.tsx`
- Lines: 26-193
- Changes:
  - Add state: `focusedIndex: number | null`
  - Add `onKeyDown` handler to input element:
    ```typescript
    const handleKeyDown = (e: React.KeyboardEvent) => {
      if (!isOpen) {
        if (e.key === 'ArrowDown') {
          setIsOpen(true);
          setFocusedIndex(0);
          e.preventDefault();
        }
        return;
      }

      switch (e.key) {
        case 'ArrowDown':
          setFocusedIndex(prev =>
            prev === null ? 0 : Math.min(prev + 1, flatOptions.length - 1)
          );
          e.preventDefault();
          break;
        case 'ArrowUp':
          setFocusedIndex(prev =>
            prev === null ? flatOptions.length - 1 : Math.max(prev - 1, 0)
          );
          e.preventDefault();
          break;
        case 'Enter':
        case 'Tab':
          if (focusedIndex !== null) {
            handleSelect(flatOptions[focusedIndex]);
            if (e.key === 'Enter') e.preventDefault();
          }
          break;
        case 'Escape':
          setIsOpen(false);
          setFocusedIndex(null);
          e.preventDefault();
          break;
      }
    };
    ```
  - Create flattened options list for index-based navigation:
    ```typescript
    // Flatten grouped accounts into a single array for keyboard navigation
    const flatOptions = useMemo(() => {
      const result: Account[] = [];
      Object.entries(groupedAccounts).forEach(([type, accounts]) => {
        // Only include accounts that match the current search filter
        const filtered = accounts.filter(a =>
          a.name.toLowerCase().includes(search.toLowerCase()) ||
          a.fullname?.toLowerCase().includes(search.toLowerCase())
        );
        result.push(...filtered);
      });
      return result;
    }, [groupedAccounts, search]);
    ```
  - Add visual focus indicator class to focused option:
    ```typescript
    className={`... ${index === focusedIndex ? 'bg-blue-100 dark:bg-blue-900' : ''}`}
    ```
  - Reset focusedIndex when dropdown opens or search changes:
    ```typescript
    useEffect(() => { setFocusedIndex(0); }, [search, isOpen]);
    ```

**Task 3.2: Add scroll-into-view for focused item**
- File: `src/components/ui/AccountSelector.tsx`
- Changes:
  - Add ref to dropdown container
  - useEffect to scroll focused item into view when focusedIndex changes

#### Dependencies
- None

#### Risks
- **Risk**: Index mismatch with grouped accounts
- **Mitigation**: Create flat list of all visible accounts with indices

---

### Feature 4: Ctrl+Enter Form Submission with Validation

**Priority**: HIGH | **Complexity**: MEDIUM | **Files**: 3

#### Requirements
- Ctrl+Enter (Cmd+Enter on Mac) submits the active form
- Show visual validation feedback on invalid fields
- Invalid fields get red border highlight
- Error messages displayed near invalid fields
- Works in both TransactionForm and AccountForm

#### Acceptance Criteria
- [ ] Ctrl+Enter submits form if valid
- [ ] Invalid fields highlighted with red border
- [ ] Error summary shown at top of form
- [ ] Pressing Ctrl+Enter on invalid form shows errors without submitting
- [ ] Focus moves to first invalid field

#### Implementation Steps

**Task 4.1: Create useFormKeyboardShortcuts hook**
- File: `src/lib/hooks/useFormKeyboardShortcuts.ts` (NEW)
- Implementation:
  ```typescript
  export function useFormKeyboardShortcuts(
    formRef: RefObject<HTMLFormElement>,
    onSubmit: () => void,
    validate?: () => boolean
  ) {
    useEffect(() => {
      const handler = (e: KeyboardEvent) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
          e.preventDefault();
          if (!validate || validate()) {
            onSubmit();
          }
        }
      };
      window.addEventListener('keydown', handler);
      return () => window.removeEventListener('keydown', handler);
    }, [onSubmit, validate]);
  }
  ```

**Task 4.2: Add validation visual feedback to TransactionForm**
- File: `src/components/TransactionForm.tsx`
- Lines: 361-575
- Changes:
  - Add `fieldErrors` state to track per-field errors (separate from existing `errors` array):
    ```typescript
    // Existing: const [errors, setErrors] = useState<string[]>([]); // for error summary
    // New: Track which specific fields have errors for red highlighting
    const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
    // fieldErrors = { description: "Required", fromAccount: "Required", ... }
    ```
  - The existing `errors[]` array displays error messages at the top
  - The new `fieldErrors{}` object enables per-field red border highlighting
  - Add validation error styling class:
    ```typescript
    className={`... ${fieldErrors.description ? 'border-rose-500 ring-1 ring-rose-500/30' : ''}`}
    ```
  - Update `validateForm()` to return both array (for summary) and object (for highlighting):
    ```typescript
    function validateForm(): { valid: boolean; errors: string[]; fieldErrors: Record<string, string> }
    ```
  - Update handleSubmit to call validateForm and populate both states
  - Add inline error message display below each field when `fieldErrors[fieldName]` exists
  - Add form ref and useFormKeyboardShortcuts hook
  - Focus first invalid field on validation failure using refs

**Task 4.3: Add keyboard shortcut to AccountForm**
- File: `src/components/AccountForm.tsx`
- Changes:
  - Import and use useFormKeyboardShortcuts
  - Add similar validation error styling
  - Ensure consistent UX with TransactionForm

**Task 4.4: Add visual hint for keyboard shortcut**
- File: `src/components/TransactionForm.tsx`
- Location: Submit button area (lines 560-574)
- Changes:
  - Add small hint text: "Ctrl+Enter to save"
  - Style as subtle neutral text below button

#### Dependencies
- None

#### Risks
- **Risk**: Keyboard shortcut conflicts with browser/OS shortcuts
- **Mitigation**: Use standard Ctrl/Cmd+Enter which has no conflicts

---

### Feature 5: Multi-Currency Trading Account Auto-Generation

**Priority**: HIGH | **Complexity**: HIGH | **Files**: 3-4

#### Requirements
- When a transaction has splits in different currencies, detect currency imbalance
- Auto-generate Trading:CURRENCY:XXX accounts if they don't exist
- Create balancing splits to Trading accounts (like desktop GnuCash)
- Trading splits ensure quantities balance even when values don't match exactly

#### Acceptance Criteria
- [ ] Detects multi-currency transactions (different commodity_guid on splits)
- [ ] Creates Trading:CURRENCY:XXX account hierarchy if missing
- [ ] Adds Trading splits to balance commodity quantities
- [ ] Transaction saves successfully with proper double-entry
- [ ] Works for both simple transfers and complex multi-split transactions

#### Background: GnuCash Trading Account Behavior
In GnuCash, when transferring between accounts with different currencies:
- USD account -> EUR account with exchange
- Creates splits:
  1. USD account: -100.00 USD (value=-100, quantity=-100)
  2. EUR account: +85.00 EUR (value=+100, quantity=+85)
  3. Trading:CURRENCY:USD: +100.00 (value=+100, quantity=+100)
  4. Trading:CURRENCY:EUR: -85.00 (value=-85, quantity=-85)

This ensures both VALUES sum to zero AND QUANTITIES per currency sum to zero.

#### Implementation Steps

**Task 5.1: Create trading account utility functions**
- File: `src/lib/trading-accounts.ts` (NEW)
- Functions:
  ```typescript
  // Check if transaction needs trading accounts
  function needsTradingAccounts(splits: Split[]): boolean

  // Get or create Trading:CURRENCY:XXX account
  async function getOrCreateTradingAccount(
    currencyMnemonic: string,
    currencyGuid: string
  ): Promise<string> // returns account guid

  // Generate trading splits to balance the transaction
  function generateTradingSplits(
    originalSplits: Split[],
    transactionCurrencyGuid: string
  ): Split[]
  ```

**Task 5.2: Create Trading account hierarchy API**
- File: `src/app/api/accounts/trading/route.ts` (NEW)
- POST endpoint to ensure Trading:CURRENCY:XXX account exists
- Creates parent accounts if needed (Trading -> CURRENCY -> specific currency)
- Returns account GUID

**Task 5.3: Integrate trading splits into transaction creation**
- File: `src/app/api/transactions/route.ts`
- Lines: 248-375 (POST handler)
- Changes:
  - Before creating splits, check if trading accounts needed
  - If multi-currency, call trading split generation
  - Merge generated trading splits with user splits
  - Create all accounts if needed before split creation

**Task 5.4: Update TransactionForm to show trading split info**
- File: `src/components/TransactionForm.tsx`
- Changes:
  - When multi-currency detected, show info message
  - "Trading splits will be automatically generated to balance this transaction"
  - Optional: Preview the trading splits that will be created

#### Dependencies
- **Soft dependency on Feature 1**: Cache invalidation is cleaner if Feature 1 is done first
- **Graceful degradation**: Feature 5 will work without Feature 1 using fallback pattern

#### Commodity Data Flow (Architect Guidance)
The accounts API already returns `commodity_guid` and `commodity_mnemonic` in flat mode (`src/app/api/accounts/route.ts:70-73`). To detect multi-currency:
1. When building splits, look up each account's `commodity_guid` from cached `useAccounts({ flat: true })` data
2. If commodities differ between splits, the transaction is multi-currency
3. Create utility: `getAccountCommodity(accounts: Account[], accountGuid: string): { guid: string; mnemonic: string }`

#### Graceful Degradation Pattern (Required)
Trading account creation happens server-side during `POST /api/transactions`. To handle cache staleness:

```typescript
async function getOrFetchAccount(accountGuid: string, cachedAccounts: Account[]): Promise<Account> {
  // 1. Try cache first
  const cached = cachedAccounts.find(a => a.guid === accountGuid);
  if (cached) return cached;

  // 2. Fallback: Direct API fetch
  const res = await fetch(`/api/accounts/${accountGuid}/info`);
  if (res.ok) return res.json();

  // 3. Last resort: Invalidate cache and retry
  await queryClient.invalidateQueries({ queryKey: ['accounts'] });
  const refetched = queryClient.getQueryData<Account[]>(['accounts', { flat: true }]);
  const found = refetched?.find(a => a.guid === accountGuid);
  if (found) return found;

  throw new Error(`Account ${accountGuid} not found`);
}
```

This pattern ensures Feature 5 works regardless of whether Feature 1 is implemented.

#### Handling 3+ Currency Transactions
For transactions involving 3+ currencies (e.g., USD → EUR → GBP):
- Generate trading splits for EACH currency pair that has a quantity imbalance
- Each currency gets its own Trading:CURRENCY:XXX account and balancing split
- The algorithm iterates through all unique commodities and creates trading splits to zero out each

#### Risks
- **Risk**: Creating duplicate Trading accounts
- **Mitigation**: Use database constraint on (name, parent_guid) or check before insert with SELECT first

- **Risk**: Trading split calculation errors
- **Mitigation**: Add validation that total value still sums to zero after trading splits

- **Risk**: Users confused by extra splits
- **Mitigation**: Clear UI explanation and optional collapse of trading splits in display

- **Risk**: Cache staleness after creating Trading accounts
- **Mitigation**: Use graceful degradation pattern above; server-side creation means response includes new account GUIDs

---

## Must Have / Must NOT Have

### Must Have
- Each feature can be implemented and deployed independently (graceful degradation where dependencies exist)
- Feature 5 includes fallback logic if cache is stale (does not strictly require Feature 1)
- Consistent error handling across features
- TypeScript types for all new code
- No regressions to existing functionality

### Must NOT Have
- Server-side state (keep everything in React Query)
- External API calls (all data from local PostgreSQL)
- Authentication changes
- Database schema changes (use existing GnuCash schema)

---

## Task Dependencies & Order

```
Feature 1 (Caching) ----+
                        |
Feature 3 (Keyboard) ---+---> Feature 2 (Autocomplete)
                        |
Feature 4 (Ctrl+Enter) -+
                        |
Feature 5 (Trading) ----+ (after Feature 1 for cache invalidation)
```

**Recommended Order:**
1. Feature 1 - Account Caching (foundational, enables later invalidation)
2. Feature 3 - Keyboard Navigation (standalone, enables autocomplete pattern)
3. Feature 4 - Ctrl+Enter Submit (standalone)
4. Feature 2 - Autocomplete (uses keyboard nav patterns)
5. Feature 5 - Trading Accounts (most complex, uses cache invalidation)

---

## Commit Strategy

| Order | Feature | Commit Message |
|-------|---------|----------------|
| 1 | Caching | `feat: add stale-while-revalidate caching for accounts` |
| 2 | Keyboard Nav | `feat: add keyboard navigation to AccountSelector dropdown` |
| 3 | Ctrl+Enter | `feat: add Ctrl+Enter form submission with validation feedback` |
| 4 | Autocomplete | `feat: add transaction description autocomplete` |
| 5 | Trading | `feat: auto-generate trading account splits for multi-currency transactions` |

---

## Success Criteria

### Performance
- [ ] Accounts page renders cached data in <100ms on repeat visits
- [ ] Autocomplete suggestions appear within 500ms of typing pause

### Usability
- [ ] All keyboard shortcuts work consistently
- [ ] Validation errors are clear and actionable
- [ ] Multi-currency transactions "just work" without manual Trading account setup

### Code Quality
- [ ] `npm run build` succeeds with no errors
- [ ] No `any` types in new code
- [ ] Consistent with existing code style

---

## Verification Steps

### Feature 1 Verification
1. Open /accounts page, observe network request
2. Navigate away and back - no new request
3. Create a new account - verify refetch happens
4. Change date range - verify new request with date params

### Feature 2 Verification
1. Open transaction form, type in description
2. Verify suggestions appear after 2+ chars
3. Use arrow keys to navigate, Enter to select
4. Verify selected description fills input

### Feature 3 Verification
1. Click into AccountSelector
2. Press ArrowDown - dropdown opens, first item focused
3. Navigate with arrows, select with Enter
4. Press Tab - selects and moves to next field
5. Press Escape - closes without selection

### Feature 4 Verification
1. Open transaction form with empty fields
2. Press Ctrl+Enter - validation errors shown
3. Fill required fields
4. Press Ctrl+Enter - form submits
5. Verify Mac users can use Cmd+Enter

### Feature 5 Verification
1. Create transaction between USD and EUR accounts
2. Verify Trading:CURRENCY accounts created if missing
3. Verify transaction has 4+ splits (user + trading)
4. Open transaction for viewing - verify trading splits shown
5. Delete trading account - recreated on next multi-currency transaction

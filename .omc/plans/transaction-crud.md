# Transaction CRUD Implementation Plan

## Context

### Original Request
Implement full CRUD functionality for transactions in GnuCash Web with:
1. Warning when editing reconciled transactions
2. Support for investment accounts (buy/sell/dividend with quantity + value)
3. Multi-currency transactions (with exchange rate handling)
4. Simple 2-split transactions (most common case)
5. Transaction entry from account detail page (AccountLedger.tsx)
6. Transaction entry from general ledger (TransactionJournal.tsx)
7. Cache account hierarchy for navigation performance

### Research Findings

**Existing Infrastructure (LEVERAGE THIS):**
- Full API CRUD exists: POST/GET/PUT/DELETE at `/api/transactions` and `/api/transactions/[guid]`
- `TransactionForm.tsx` exists with debit/credit splits, auto-balance, validation
- `TransactionService.ts` has CRUD operations with reconcile state protection (server-side)
- `TransactionModal.tsx` exists and already has `onEdit` and `onDelete` callback props (unused!)
- `SplitRow.tsx` for split entry with AccountSelector
- `Modal.tsx` for modal dialogs
- Validation utilities in `src/lib/validation.ts` with `toNumDenom()` helper
- Prices API exists at `/api/prices` for stock prices
- Exchange rates API exists at `/api/exchange-rates`
- `InvestmentAccount.tsx` shows investment UI patterns

**Database Schema Understanding:**
- `splits.value_num/value_denom` = transaction currency amount
- `splits.quantity_num/quantity_denom` = account commodity amount (differs for investments/multi-currency)
- `splits.reconcile_state` = 'n' (not), 'c' (cleared), 'y' (reconciled)
- `splits.action` = action string (Buy, Sell, Dividend, etc. for investments)
- Amounts are BigInt fractions

**Key Gap Analysis:**
| Feature | API Status | UI Status |
|---------|-----------|-----------|
| Create transaction | DONE | TransactionForm exists but no entry point |
| Edit transaction | DONE | Modal has prop but not wired |
| Delete transaction | DONE | Modal has prop but not wired |
| Reconcile warning | Server throws error | No UI warning before attempt |
| Investment form | quantity_num/denom supported | No specialized UI |
| Multi-currency | quantity_num/denom supported | No exchange rate input |
| Simple 2-split | Supported | Form defaults to 2 splits but no simplified view |

---

## Work Objectives

### Core Objective
Enable complete transaction lifecycle management through existing UI components with minimal new code, adding specialized support for investment and multi-currency transactions.

### Deliverables
1. Edit/Delete buttons wired in TransactionJournal and AccountLedger
2. "New Transaction" entry point in both ledger views
3. Reconcile warning dialog before editing/deleting reconciled transactions
4. Investment transaction form mode for STOCK/MUTUAL accounts
5. Exchange rate field for multi-currency splits
6. Simplified "quick entry" mode for common 2-split transactions
7. Account hierarchy caching with React Query

### Definition of Done
- Users can create, edit, delete transactions from both ledger views
- Reconciled transaction editing shows warning and requires confirmation
- Investment transactions properly set quantity vs value
- Multi-currency transactions can specify exchange rate
- Account selector uses cached data (not fetching on every mount)
- All existing tests (if any) continue to pass
- No TypeScript errors (`npm run build` passes)

---

## Must Have / Must NOT Have

### Must Have
- All transaction operations work through existing API endpoints
- Reconcile warning appears before API call (client-side check first)
- Investment form calculates total = quantity x price automatically
- Exchange rate visible when transaction currency differs from account commodity
- Form pre-populates with context (current account for AccountLedger)
- Proper error handling with user-friendly messages

### Must NOT Have
- Do NOT modify GnuCash database schema
- Do NOT create new API endpoints (all needed APIs exist)
- Do NOT break existing reconciliation workflow
- Do NOT remove any existing functionality
- Do NOT implement lot tracking (out of scope)
- Do NOT implement scheduled transactions (out of scope)

---

## Task Flow and Dependencies

```
[Phase 1: Wire Existing UI]
    |
    +--> Task 1.1: Add edit/delete handlers to TransactionJournal
    |
    +--> Task 1.2: Add edit/delete handlers to AccountLedger
    |
    +--> Task 1.3: Add "New Transaction" button to both views
    |
    v
[Phase 2: Reconcile Protection]
    |
    +--> Task 2.1: Create ConfirmationDialog component
    |
    +--> Task 2.2: Add reconcile check before edit/delete
    |
    v
[Phase 3: Enhanced Form]
    |
    +--> Task 3.1: Add simple mode toggle to TransactionForm
    |
    +--> Task 3.2: Create InvestmentTransactionForm component
    |
    +--> Task 3.3: Add exchange rate input for multi-currency
    |
    v
[Phase 4: Performance]
    |
    +--> Task 4.1: Add React Query for account hierarchy caching
    |
    +--> Task 4.2: Update AccountSelector to use cached data
```

---

## Detailed Tasks

### Phase 1: Wire Existing UI to API

#### Task 1.1: Wire Edit/Delete in TransactionJournal
**File:** `src/components/TransactionJournal.tsx`

**Changes:**
1. Add state for edit modal: `const [editingTransaction, setEditingTransaction] = useState<Transaction | null>(null);`
2. Add TransactionFormModal import and usage
3. Create handleEdit callback that opens form modal with transaction data
4. Create handleDelete callback that calls DELETE API with confirmation
5. Pass `onEdit` and `onDelete` to existing TransactionModal
6. Add refresh function to reload transactions after mutation

**Acceptance Criteria:**
- Clicking row opens detail modal (existing)
- Edit button in modal opens TransactionForm in edit mode
- Delete button in modal shows confirmation then removes transaction
- Transaction list refreshes after successful mutation

---

#### Task 1.2: Wire Edit/Delete in AccountLedger
**File:** `src/components/AccountLedger.tsx`

**Changes:**
1. Add TransactionModal and TransactionFormModal usage
2. Add state: `selectedTxGuid`, `isViewModalOpen`, `isEditModalOpen`
3. Add row click handler to open TransactionModal
4. Create handleEdit callback that opens TransactionForm
5. Create handleDelete callback with confirmation dialog
6. Pre-populate form with current account when creating new transactions
7. Refresh transactions after mutation

**Acceptance Criteria:**
- Clicking transaction row opens detail modal
- Edit/delete work within modal
- New transactions default to current account as one of the splits

---

#### Task 1.3: Add "New Transaction" Button
**Files:** `TransactionJournal.tsx`, `AccountLedger.tsx`

**Changes:**
1. Add "New Transaction" button next to filters in both components
2. Button opens TransactionFormModal in create mode
3. For AccountLedger: pre-fill first split with current account GUID
4. Create `TransactionFormModal.tsx` wrapper that handles create vs edit mode

**New File:** `src/components/TransactionFormModal.tsx`
```typescript
interface TransactionFormModalProps {
    isOpen: boolean;
    onClose: () => void;
    transaction?: Transaction | null; // null = create mode
    defaultAccountGuid?: string;
    onSuccess: () => void;
}
```

**Acceptance Criteria:**
- "New Transaction" button visible in both views
- Modal opens with empty form (or pre-filled account)
- Successful save closes modal and refreshes list

---

### Phase 2: Reconcile Protection

#### Task 2.1: Create ConfirmationDialog Component
**New File:** `src/components/ui/ConfirmationDialog.tsx`

**Component Interface:**
```typescript
interface ConfirmationDialogProps {
    isOpen: boolean;
    onConfirm: () => void;
    onCancel: () => void;
    title: string;
    message: string;
    confirmLabel?: string;
    confirmVariant?: 'danger' | 'warning' | 'default';
    isLoading?: boolean;
}
```

**Features:**
- Reuses Modal component
- Clear danger/warning styling
- Loading state during async operation
- Keyboard support (Enter to confirm, Escape to cancel)

**Acceptance Criteria:**
- Dialog renders centered with backdrop
- Danger variant has red confirm button
- Warning variant has amber confirm button
- Loading spinner on confirm button when processing

---

#### Task 2.2: Add Reconcile Check Before Edit/Delete
**Files:** `TransactionJournal.tsx`, `AccountLedger.tsx`, `TransactionModal.tsx`

**Logic:**
1. Before opening edit form, check if any split has `reconcile_state === 'y'` or `'c'`
2. If reconciled ('y'): Show warning "This transaction has reconciled splits. Editing may affect account reconciliation."
3. If cleared ('c'): Show milder warning "This transaction has cleared splits."
4. Both require explicit confirmation before proceeding

**Helper Function:**
```typescript
function hasReconciledSplits(tx: Transaction): { reconciled: boolean; cleared: boolean } {
    const splits = tx.splits || [];
    return {
        reconciled: splits.some(s => s.reconcile_state === 'y'),
        cleared: splits.some(s => s.reconcile_state === 'c' && s.reconcile_state !== 'y'),
    };
}
```

**Acceptance Criteria:**
- Reconciled transactions show danger warning before edit/delete
- Cleared transactions show warning before edit/delete
- User must click "Continue Anyway" to proceed
- Un-reconciled transactions open immediately without warning

---

### Phase 3: Enhanced Transaction Forms

#### Task 3.1: Add Simple Mode to TransactionForm
**File:** `src/components/TransactionForm.tsx`

**Changes:**
1. Add prop: `simpleMode?: boolean`
2. In simple mode, show:
   - Date field
   - Description field
   - Amount field (single input, no debit/credit confusion)
   - "From Account" dropdown
   - "To Account" dropdown
3. Auto-calculate splits: From gets credit, To gets debit (or vice versa based on amount sign)
4. Toggle button to switch to "Advanced" (full splits view)

**Simple Mode UI:**
```
[Date] [Description]
Amount: [______]
From: [Account Selector] -> To: [Account Selector]
[Create Transaction]
```

**Acceptance Criteria:**
- Simple mode shows streamlined 2-account interface
- Negative amounts flip from/to interpretation
- "Show Advanced" reveals full splits editor
- Switching modes preserves entered data

---

#### Task 3.2: Create InvestmentTransactionForm Component
**New File:** `src/components/InvestmentTransactionForm.tsx`

**Investment-Specific Fields:**
- Action selector: Buy, Sell, Dividend, Return of Capital, Stock Split
- Shares (quantity) field
- Price per share field
- Commission/fees field (optional)
- Auto-calculated total
- Cash account selector (for source/destination of funds)

**Split Generation Logic:**
| Action | Investment Account Split | Cash Account Split |
|--------|-------------------------|-------------------|
| Buy | +shares, -value (cost) | -cash |
| Sell | -shares, +value (proceeds) | +cash |
| Dividend | (none) | +cash (to income account) |
| Return of Capital | -value (reduce basis) | +cash |

**Props:**
```typescript
interface InvestmentTransactionFormProps {
    accountGuid: string; // The investment account
    accountCommodityGuid: string;
    onSave: (data: CreateTransactionRequest) => Promise<void>;
    onCancel: () => void;
}
```

**Acceptance Criteria:**
- Action dropdown determines form fields
- Buy/Sell show quantity, price, total
- Dividend shows amount and income account selector
- Generated splits follow GnuCash investment conventions
- Total = quantity * price + commission

---

#### Task 3.3: Add Exchange Rate Input for Multi-Currency
**File:** `src/components/SplitRow.tsx`

**Changes:**
1. Pass `transactionCurrencyGuid` prop to SplitRow
2. Fetch account's commodity when account selected
3. If account commodity !== transaction currency, show exchange rate field
4. Calculate quantity from value using exchange rate

**New UI Elements:**
```
[Account] [Debit] [Credit] [Rate: 1.25] [Memo]
```

Rate field only appears when currencies differ.

**Exchange Rate Behavior:**
- Default rate from `/api/exchange-rates` if available
- User can override
- quantity_num/denom = value * exchange_rate

**Type Update in `types.ts`:**
```typescript
interface SplitFormData {
    // ...existing fields
    exchange_rate?: string; // Only for multi-currency
}
```

**Acceptance Criteria:**
- Exchange rate field appears only when needed
- Pre-populates with latest rate from API
- Recalculates quantity when rate changes
- Supports both directions (multiply or divide based on currency pair)

---

### Phase 4: Performance Optimization

#### Task 4.1: Add React Query for Account Caching
**Files:**
- `src/lib/hooks/useAccounts.ts` (new)
- `src/app/providers.tsx` (create or update)

**Setup:**
1. Install react-query if not present: `npm install @tanstack/react-query`
2. Create QueryClientProvider wrapper
3. Create `useAccounts` hook with caching

**Hook Interface:**
```typescript
function useAccounts(options?: { flat?: boolean }) {
    return useQuery({
        queryKey: ['accounts', options],
        queryFn: () => fetch('/api/accounts?flat=' + (options?.flat ?? true)).then(r => r.json()),
        staleTime: 5 * 60 * 1000, // 5 minutes
        cacheTime: 30 * 60 * 1000, // 30 minutes
    });
}
```

**Acceptance Criteria:**
- Accounts only fetched once per 5 minutes
- Cache shared across all AccountSelectors
- Invalidate cache after account creation/update

---

#### Task 4.2: Update AccountSelector to Use Cached Data
**File:** `src/components/ui/AccountSelector.tsx`

**Changes:**
1. Replace direct fetch with `useAccounts` hook
2. Remove internal `accounts` state (use hook data)
3. Add loading/error states from hook

**Acceptance Criteria:**
- Multiple AccountSelectors don't cause multiple fetches
- Selector works immediately if cache is warm
- Graceful degradation if cache miss

---

## Commit Strategy

| Commit | Scope | Message |
|--------|-------|---------|
| 1 | Phase 1.1 | feat: wire edit/delete handlers in TransactionJournal |
| 2 | Phase 1.2 | feat: wire edit/delete handlers in AccountLedger |
| 3 | Phase 1.3 | feat: add new transaction button and TransactionFormModal |
| 4 | Phase 2.1 | feat: add reusable ConfirmationDialog component |
| 5 | Phase 2.2 | feat: add reconcile warning before edit/delete |
| 6 | Phase 3.1 | feat: add simple mode toggle to TransactionForm |
| 7 | Phase 3.2 | feat: create InvestmentTransactionForm for STOCK/MUTUAL |
| 8 | Phase 3.3 | feat: add exchange rate input for multi-currency splits |
| 9 | Phase 4.1-4.2 | perf: cache account hierarchy with React Query |

---

## Success Criteria

### Functional Tests
- [ ] Can create transaction from TransactionJournal
- [ ] Can create transaction from AccountLedger (pre-filled account)
- [ ] Can edit any un-reconciled transaction
- [ ] Reconcile warning appears for cleared/reconciled transactions
- [ ] Can delete transactions with confirmation
- [ ] Investment transactions generate correct splits for Buy/Sell/Dividend
- [ ] Multi-currency transactions calculate quantity correctly
- [ ] Simple mode works for basic 2-account transfers

### Performance Tests
- [ ] Opening AccountSelector doesn't trigger fetch if data cached
- [ ] Multiple TransactionForms share same account cache
- [ ] Page load time not significantly increased

### Build Verification
- [ ] `npm run build` completes without errors
- [ ] No TypeScript errors in changed files
- [ ] No console errors in browser during operations

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Breaking existing reconciliation | Server already validates; UI adds pre-check |
| Investment splits incorrect | Follow GnuCash desktop conventions exactly |
| Exchange rate precision loss | Use same num/denom pattern as existing code |
| React Query version conflicts | Check package.json for existing state management |

---

## Files to Create

1. `src/components/TransactionFormModal.tsx` - Modal wrapper for TransactionForm
2. `src/components/ui/ConfirmationDialog.tsx` - Reusable confirmation component
3. `src/components/InvestmentTransactionForm.tsx` - Investment-specific form
4. `src/lib/hooks/useAccounts.ts` - React Query hook for accounts
5. `src/app/providers.tsx` - Query client provider (if not exists)

## Files to Modify

1. `src/components/TransactionJournal.tsx` - Add CRUD handlers and buttons
2. `src/components/AccountLedger.tsx` - Add CRUD handlers and buttons
3. `src/components/TransactionModal.tsx` - Wire onEdit/onDelete props
4. `src/components/TransactionForm.tsx` - Add simple mode
5. `src/components/SplitRow.tsx` - Add exchange rate field
6. `src/lib/types.ts` - Add exchange_rate to SplitFormData
7. `src/components/ui/AccountSelector.tsx` - Use React Query hook

# Specification: Investment Transaction Modal Improvements

## Requirements

### FR-1: Remove "Root Account:" Prefix
- Account dropdowns in InvestmentTransactionForm should strip "Root Account:" prefix
- Use same `formatAccountPath()` pattern from AccountSelector.tsx

### FR-2: Tri-Field Editable Calculation
- All 3 fields (shares, price per share, total) should be editable inputs
- Track which 2 fields were last edited
- Auto-calculate the third field based on: shares × price = total
- Visual indication of which field is auto-calculated

## Technical Design

### State Management
```tsx
type EditedField = 'shares' | 'price' | 'total';
const [editHistory, setEditHistory] = useState<EditedField[]>([]);
```

### Calculation Logic
| Last Two Edited | Auto-Calculated | Formula |
|-----------------|-----------------|---------|
| shares, price | total | shares × price |
| shares, total | price | total ÷ shares |
| price, total | shares | total ÷ price |

### Edge Cases
- Divide by zero: Return 0, clear field
- Empty fields: Treat as 0, no calc until 2 fields have values
- Precision: Shares 4 decimals, Price/Total 2 decimals

### Visual Indication
- Auto-calculated field: cyan highlight + "(auto)" label
- User-edited fields: neutral styling

## Implementation Tasks

### Task 1: Add formatAccountPath function
- Add helper function before component
- Apply to account dropdown options (line 486)

### Task 2: Add total to FormState
- Add `total: string` to FormState interface
- Add to INITIAL_FORM_STATE

### Task 3: Add edit tracking state and helpers
- Add `editHistory` useState
- Add `recordEdit()` function
- Add `getCalculatedField()` function

### Task 4: Add calculation logic
- Add `calculateDerivedValue` useMemo
- Add useEffect to apply calculated values to form

### Task 5: Update field handlers
- Create `handleNumericFieldChange()` for shares/price/total
- Track edits when values change

### Task 6: Update UI
- Convert Total from div to input
- Add conditional styling to all 3 fields
- Show "(auto)" label on calculated field

### Task 7: Update validation and submission
- Update validateForm() for total
- Update buildSplits() to use form.total

## Files to Modify
- `src/components/InvestmentTransactionForm.tsx` (all changes)

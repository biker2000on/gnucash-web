# Investment Charts: % Change Mode with Red/Green Gradient Fill

## Context

### Original Request
Add a percent-change display mode with red/green gradient fill to investment charts in gnucash-web. This applies to two chart locations:
1. **Portfolio Performance chart** on the investments dashboard (`PerformanceChart.tsx`)
2. **Price History chart** on the individual investment detail page (`InvestmentAccount.tsx`)

### Research Findings

**Current State of PerformanceChart.tsx** (103 lines):
- File: `src/components/investments/PerformanceChart.tsx`
- Uses `LineChart` + `Line` from Recharts v3.7.0
- Has period selector (1M, 3M, 6M, 1Y, 3Y, 5Y, ALL)
- Shows only absolute portfolio value -- no % mode exists
- Static cyan (#06b6d4) stroke, no fill, no gradient
- Data shape: `Array<{date: string, value: number}>`
- Uses `ExpandedContext` for expandable chart support

**Current State of InvestmentAccount.tsx** (679 lines):
- File: `src/components/InvestmentAccount.tsx`
- Uses `LineChart` + `Line` + `ReferenceArea` from Recharts
- Already has `chartMode` state with `'price' | 'percentChange'` toggle (lines 70, 457-477)
- Already computes percent change data in `displayChartData` memo (lines 133-141): `((point.value - firstValue) / firstValue) * 100`
- Y-axis and tooltip already adapt to chart mode (lines 513, 525-530)
- BUT: uses static cyan (#06b6d4) stroke in both modes -- no red/green, no fill
- Has zoom/pan via drag-select (`ReferenceArea`) and mouse wheel -- must be preserved
- Chart container uses `onWheel`, `onMouseDown`, `onMouseMove`, `onMouseUp`, `onMouseLeave` handlers

**Recharts Capabilities (v3.7.0)**:
- `AreaChart` + `Area` component supports `fill="url(#gradientId)"` for SVG gradient fills
- SVG `<defs>` with `<linearGradient>` can be placed inside chart components
- `<ReferenceLine>` available for zero baseline
- Project already uses `<defs>` + `<linearGradient>` in SankeyChart.tsx (precedent)
- No existing `chart-utils.ts` file -- will create one for shared gradient logic

**No existing test framework** -- Playwright tests not set up. Verification will be manual/visual.

---

## Work Objectives

### Core Objective
Enable percent-change visualization with dynamically computed red/green gradient fill on both investment chart locations, where green shading appears above 0% and red shading appears below 0%.

### Deliverables
1. **Shared gradient utility** (`src/lib/chart-utils.ts`) -- reusable gradient offset calculation
2. **PerformanceChart.tsx** -- new `$/%` toggle + gradient AreaChart in % mode
3. **InvestmentAccount.tsx** -- gradient AreaChart applied to existing % mode (visual upgrade only)

### Definition of Done
- Both charts show `$` / `%` toggle buttons
- In % mode, chart uses `AreaChart` with:
  - Green (#10b981 / emerald-500) shaded fill above 0%
  - Red (#f43f5e / rose-500) shaded fill below 0%
  - Stroke color matches fill gradient (green above 0, red below 0)
  - `ReferenceLine` at y=0 as dashed baseline
- In `$`/`price` mode, chart keeps existing cyan line with no fill (unchanged behavior)
- Zoom/pan on InvestmentAccount detail chart still works in both modes
- Tooltip and Y-axis formatting correct in both modes
- No TypeScript errors, builds cleanly

---

## Guardrails

### Must Have
- Green above 0%, red below 0% with smooth gradient transition at the zero crossing
- Fill opacity ~0.3 so the gradient is visible but not overwhelming
- Zero baseline `ReferenceLine` in % mode (dashed, subtle)
- Gradient offset computed dynamically from actual data min/max (not hardcoded)
- Stroke color also follows the gradient (not static cyan in % mode)
- All existing functionality preserved (zoom, pan, period selector, expandable chart)

### Must NOT Have
- No changes to the `$`/price mode appearance -- cyan line stays as-is
- No changes to API routes or data fetching logic
- No new npm dependencies -- Recharts already has everything needed
- No changes to the AllocationChart (pie chart) -- out of scope
- No hardcoded gradient breakpoints -- must be computed from data domain

---

## Task Flow and Dependencies

```
Task 1 (chart-utils.ts) ──> Task 2 (PerformanceChart) ──> Task 4 (verification)
                         ──> Task 3 (InvestmentAccount) ──> Task 4 (verification)
```

Tasks 2 and 3 can run in parallel once Task 1 is complete.

---

## Detailed Tasks

### Task 1: Create shared gradient utility
**File:** `src/lib/chart-utils.ts` (NEW)
**Estimated size:** ~40 lines

**What to implement:**
1. `computeZeroOffset(data: Array<{value: number}>, dataKey?: string): number`
   - Finds min and max values in the dataset
   - Returns the fractional Y position of zero: `max / (max - min)`
   - Edge cases:
     - All positive: return 1 (100% green)
     - All negative: return 0 (100% red)
     - No data or single point: return 0.5 (neutral)
     - min === max: return 0.5

2. Export color constants:
   - `GRADIENT_GREEN = '#10b981'` (emerald-500)
   - `GRADIENT_RED = '#f43f5e'` (rose-500)
   - `GRADIENT_FILL_OPACITY = 0.3`

3. Optional: `PercentGradientDefs` React component that renders the SVG `<defs>` block with both fill and stroke gradients, accepting `zeroOffset` as a prop. This avoids duplicating 20+ lines of SVG gradient markup in both chart files.

**Acceptance criteria:**
- [ ] `computeZeroOffset` returns correct values for mixed positive/negative, all-positive, all-negative, and empty datasets
- [ ] Exported constants match the design spec colors
- [ ] File has no TypeScript errors

---

### Task 2: Add % change mode to PerformanceChart.tsx
**File:** `src/components/investments/PerformanceChart.tsx`
**Estimated size:** ~103 -> ~170 lines

**What to implement:**

1. **Add imports:**
   - `Area, AreaChart, ReferenceLine` from recharts
   - `computeZeroOffset, GRADIENT_GREEN, GRADIENT_RED, GRADIENT_FILL_OPACITY` from `@/lib/chart-utils`
   - If using shared component: `PercentGradientDefs` from `@/lib/chart-utils`

2. **Add state:**
   - `const [chartMode, setChartMode] = useState<'value' | 'percentChange'>('value');`

3. **Add computed data:**
   - `displayData` memo: when `chartMode === 'percentChange'`, transform `filteredData` to percent change from first point: `((value - firstValue) / firstValue) * 100`
   - When `chartMode === 'value'`, pass through `filteredData` unchanged

4. **Add `$/%` toggle buttons** in the header bar (next to period selector, separated by a divider):
   ```
   <div className="flex gap-1 ml-2 border-l border-border pl-2">
     <button onClick={() => setChartMode('value')} ...>$</button>
     <button onClick={() => setChartMode('percentChange')} ...>%</button>
   </div>
   ```
   - Match the styling pattern from InvestmentAccount.tsx (lines 457-477)
   - Active button: `bg-cyan-600 text-white`
   - Inactive button: `bg-background-tertiary text-foreground-secondary hover:bg-surface-hover`

5. **Conditional chart rendering:**
   - When `chartMode === 'value'`: keep existing `<LineChart>` + `<Line>` (cyan, no fill) -- zero changes
   - When `chartMode === 'percentChange'`: render `<AreaChart>` + `<Area>` with:
     - `<defs>` containing two `<linearGradient>` elements (fill + stroke), each using `computeZeroOffset(displayData)` to position the green-to-red transition
     - `<Area type="monotone" dataKey="value" stroke="url(#strokeGradient)" fill="url(#fillGradient)" fillOpacity={1} strokeWidth={2} dot={false} />`
     - The fill gradient: green with GRADIENT_FILL_OPACITY from top to zeroOffset, red with GRADIENT_FILL_OPACITY from zeroOffset to bottom
     - The stroke gradient: solid green from top to zeroOffset, solid red from zeroOffset to bottom
     - `<ReferenceLine y={0} stroke="#525252" strokeDasharray="3 3" />`

6. **Update Y-axis and Tooltip for % mode:**
   - Y-axis tickFormatter: `chartMode === 'percentChange' ? `${value.toFixed(1)}%` : `$${(value / 1000).toFixed(0)}k``
   - Tooltip formatter: show `X.XX%` for percent mode, `formatCurrency(value)` for value mode
   - Tooltip label for percent mode: `'% Change'` instead of `'Portfolio Value'`

**Acceptance criteria:**
- [ ] `$` / `%` toggle buttons render next to period selector
- [ ] Default mode is `$` (value) showing existing cyan line
- [ ] `%` mode shows AreaChart with green fill above 0, red fill below 0
- [ ] Zero baseline ReferenceLine visible in % mode
- [ ] Y-axis shows `%` suffix in percent mode
- [ ] Tooltip shows formatted percentage in percent mode
- [ ] Switching between modes is instant (no re-fetch)
- [ ] ExpandedContext (expandable chart) still works correctly
- [ ] No TypeScript errors

---

### Task 3: Apply gradient fill to InvestmentAccount.tsx price chart
**File:** `src/components/InvestmentAccount.tsx`
**Estimated size:** ~679 -> ~730 lines (modest increase since logic already exists)

**What to implement:**

1. **Add imports:**
   - `Area, AreaChart, ReferenceLine` from recharts (update existing import line 8)
   - `computeZeroOffset, GRADIENT_GREEN, GRADIENT_RED, GRADIENT_FILL_OPACITY` from `@/lib/chart-utils`

2. **Compute gradient offset:**
   - Add a `useMemo` for `zeroOffset`: `computeZeroOffset(displayChartData)` -- recomputes when data or chart mode changes

3. **Conditional chart rendering (lines 498-556):**
   - When `chartMode === 'price'`: keep existing `<LineChart>` + `<Line>` (cyan, no fill) unchanged
   - When `chartMode === 'percentChange'`: replace with `<AreaChart>` + `<Area>`:
     - Must preserve ALL event handlers: `onMouseDown={handleMouseDown}`, `onMouseMove={handleMouseMove}`, `onMouseUp={handleMouseUp}`, `onMouseLeave={handleMouseUp}` -- `AreaChart` supports the same props as `LineChart`
     - Must preserve the drag-selection `<ReferenceArea>` overlay for zoom
     - Add `<defs>` with fill and stroke gradients using `zeroOffset`
     - `<Area>` with `fill="url(#fillGradient)"` and `stroke="url(#strokeGradient)"`
     - `<ReferenceLine y={0} stroke="#525252" strokeDasharray="3 3" />`

   **CRITICAL: Zoom/pan preservation.** The `AreaChart` component in Recharts supports the same mouse event props (`onMouseDown`, `onMouseMove`, `onMouseUp`, `onMouseLeave`) as `LineChart`. The `ReferenceArea` component also works inside `AreaChart`. The drag-select zoom and wheel zoom should work identically.

4. **Unique gradient IDs:** Since both charts could theoretically appear on the same page (they don't currently, but for safety), use unique gradient IDs: `investmentFillGradient` / `investmentStrokeGradient` vs `portfolioFillGradient` / `portfolioStrokeGradient`. Or, if using the shared `PercentGradientDefs` component, pass an `id` prefix prop.

**Acceptance criteria:**
- [ ] Existing `$` / `%` toggle still works
- [ ] `$` mode: unchanged cyan line chart (no visual regression)
- [ ] `%` mode: AreaChart with green above 0 / red below 0 gradient fill
- [ ] Zero baseline ReferenceLine visible in % mode
- [ ] Drag-to-zoom still works in both modes
- [ ] Scroll-wheel zoom still works in both modes
- [ ] Reset zoom button still works
- [ ] Period selector still works and resets zoom
- [ ] Tooltip shows correct values in both modes
- [ ] No TypeScript errors

---

### Task 4: Verification
**Manual verification steps:**

1. **PerformanceChart (Dashboard):**
   - Navigate to `/investments`
   - Confirm `$` mode shows cyan line (no change from current)
   - Click `%` toggle
   - Confirm chart shows green shading above 0% line, red shading below 0% line
   - Confirm `ReferenceLine` at y=0 is visible
   - Confirm Y-axis ticks show percentage values
   - Hover over chart: tooltip shows `X.XX%` and label says `% Change`
   - Switch between period selectors (1M through ALL) -- chart updates correctly
   - Test with expanded chart (if ExpandableChart wrapper exists on page)

2. **InvestmentAccount (Detail Page):**
   - Navigate to any investment account detail page (e.g., `/accounts/{guid}`)
   - Confirm `$` mode shows cyan line (no change from current)
   - Click `%` toggle
   - Confirm green/red gradient fill appears
   - Confirm zero baseline is visible
   - **Zoom test:** Click and drag on chart to select a range -- zoom applies correctly
   - **Scroll zoom test:** Use mouse wheel over chart -- zooms in/out correctly
   - **Reset test:** Click "Reset" button -- zoom resets
   - **Period change test:** Switch periods -- data and gradient update, zoom resets

3. **Build verification:**
   - Run `npm run build` -- no TypeScript or build errors
   - Run `npm run lint` -- no lint errors

---

## Commit Strategy

### Commit 1: Add shared chart gradient utilities
- New file: `src/lib/chart-utils.ts`
- Message: `feat(charts): add shared gradient utility for percent-change chart mode`

### Commit 2: Add % change mode with gradient fill to PerformanceChart
- Modified: `src/components/investments/PerformanceChart.tsx`
- Message: `feat(investments): add percent-change mode with red/green gradient to portfolio performance chart`

### Commit 3: Apply gradient fill to InvestmentAccount price chart
- Modified: `src/components/InvestmentAccount.tsx`
- Message: `feat(investments): add red/green gradient fill to investment detail percent-change chart`

Alternative: combine commits 2 and 3 into a single commit if the changes are small and tightly coupled.

---

## Success Criteria

| Criterion | Measurement |
|-----------|-------------|
| % toggle on PerformanceChart | Toggle buttons visible, switch between modes |
| Green/red gradient fill | Visually confirmed on both charts in % mode |
| Zero baseline | ReferenceLine at y=0 visible in % mode |
| Dynamic gradient | Gradient breakpoint shifts based on data range |
| Zoom preserved | Drag-select and wheel zoom work on InvestmentAccount chart |
| No regression | `$`/price mode looks identical to current |
| Clean build | `npm run build` succeeds with zero errors |
| Tooltip accuracy | Shows correct format (% vs $) per mode |

---

## Technical Notes

### SVG Gradient Structure
Each chart in % mode needs two gradients inside `<defs>`:

```jsx
<defs>
  {/* Fill gradient (with opacity) */}
  <linearGradient id="fillGradient" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stopColor={GRADIENT_GREEN} stopOpacity={GRADIENT_FILL_OPACITY} />
    <stop offset={`${zeroOffset * 100}%`} stopColor={GRADIENT_GREEN} stopOpacity={GRADIENT_FILL_OPACITY} />
    <stop offset={`${zeroOffset * 100}%`} stopColor={GRADIENT_RED} stopOpacity={GRADIENT_FILL_OPACITY} />
    <stop offset="100%" stopColor={GRADIENT_RED} stopOpacity={GRADIENT_FILL_OPACITY} />
  </linearGradient>
  {/* Stroke gradient (solid) */}
  <linearGradient id="strokeGradient" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stopColor={GRADIENT_GREEN} stopOpacity={1} />
    <stop offset={`${zeroOffset * 100}%`} stopColor={GRADIENT_GREEN} stopOpacity={1} />
    <stop offset={`${zeroOffset * 100}%`} stopColor={GRADIENT_RED} stopOpacity={1} />
    <stop offset="100%" stopColor={GRADIENT_RED} stopOpacity={1} />
  </linearGradient>
</defs>
```

The gradient uses `y1="0" y2="1"` (top to bottom) because Recharts' Y-axis goes from max (top) to min (bottom). The `zeroOffset` represents where 0 falls within the data's [min, max] range.

### Edge Case: All Positive or All Negative
- If all values are positive (zeroOffset = 1.0): entire chart is green
- If all values are negative (zeroOffset = 0.0): entire chart is red
- The formula `max / (max - min)` handles this naturally

### AreaChart vs LineChart Compatibility
Recharts `AreaChart` is a drop-in replacement for `LineChart` in terms of props. It accepts the same event handlers, axes, tooltips, and reference components. The `Area` component accepts the same `type`, `dataKey`, `stroke`, `strokeWidth`, `dot`, `animationDuration` props as `Line`, plus `fill` and `fillOpacity`.

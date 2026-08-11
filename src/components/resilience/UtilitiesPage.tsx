'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { PageHeader } from '@/components/ui/PageHeader';
import { FileDropZone, type FileUploadOutcome } from '@/components/ui/FileDropZone';
import { receiptUploadOutcome, uploadReceiptFile } from '@/components/receipts/ReceiptUploadZone';
import {
  RECEIPT_ACCEPT_ATTRIBUTE,
  RECEIPT_MAX_FILE_SIZE,
  RECEIPT_SCREEN_RULES,
  formatSizeLimit,
} from '@/lib/upload-limits';
import { useToast } from '@/contexts/ToastContext';
import { formatCurrency } from '@/lib/format';
import { findDuplicateUtilityBill } from '@/lib/resilience/p3-core';
import type { UtilitiesProfile, UtilityBill } from '@/lib/resilience/types';
import { Empty, Field, FieldGrid, INPUT, Metric, Panel, SaveBar, Tabs, TNUM } from './ui';
import { numberValue, today, uid, useSection } from './P3FeaturePages';

type UtilityResponse = {
  profile: UtilitiesProfile;
  analysis: { trailing12Cost: number; byType: Array<{ type: string; latestRate: number; usageChangePercent: number; rateChangePercent: number; trailing12Cost: number }> };
  solar: { upfrontCost: number; paybackYear: number | null; lifetimeSavings: number; currentElectricRate: number };
  suggestions: UtilityBill[];
};

/** How long to keep polling for OCR results after an upload, and how often. */
const BILL_ANALYSIS_POLL_MS = 5_000;
const BILL_ANALYSIS_TIMEOUT_MS = 120_000;

/**
 * Bill capture pane.
 *
 * Dropped or picked files ride the existing receipt intake pipeline —
 * `POST /api/receipts/upload` → `intakeReceipt()` (storage, thumbnail, DB row)
 * → the `ocr-receipt` job → OCR + AI extraction. `loadUtilityBillSuggestions()`
 * then parses the stored OCR text into a candidate bill, which surfaces in the
 * review queue. Nothing lands in the utility profile without an explicit
 * import, so the capture step stays evidence-only.
 */
function UtilityBillCapture(props: { onUploaded: (succeeded: number) => void }) {
  const toast = useToast();
  const { onUploaded } = props;

  const upload = useCallback(async (file: File): Promise<FileUploadOutcome> => {
    return receiptUploadOutcome(await uploadReceiptFile(file));
  }, []);

  const settled = useCallback(({ succeeded, failed }: { succeeded: number; failed: number }) => {
    if (failed > 0) {
      toast.error(`${failed} file${failed === 1 ? '' : 's'} could not be uploaded`);
    }
    if (succeeded > 0) {
      toast.success(`${succeeded} bill${succeeded === 1 ? '' : 's'} uploaded — reading them now`);
    }
    onUploaded(succeeded);
  }, [onUploaded, toast]);

  return (
    <FileDropZone
      accept={RECEIPT_ACCEPT_ATTRIBUTE}
      rules={RECEIPT_SCREEN_RULES}
      label="Upload utility bills"
      prompt="Drag and drop electric, gas, or water bills here"
      hint={`JPEG, PNG, or PDF up to ${formatSizeLimit(RECEIPT_MAX_FILE_SIZE)}. Drop several at once.`}
      buttonLabel="Choose bills"
      onUploadFile={upload}
      onBatchSettled={settled}
    />
  );
}

/**
 * Where the money went, beyond the headline figure. Fees are the part a
 * household cannot reduce by using less, so they are worth showing next to
 * usage rather than leaving buried on page 3 of the paper bill.
 */
function UtilityChargeBreakdown({ bill }: { bill: UtilityBill }) {
  const charges = bill.charges ?? [];
  if (charges.length === 0) return null;
  const parts = [
    { label: 'Supply', value: bill.supplyCost ?? 0 },
    { label: 'Fees', value: bill.feeCost ?? 0 },
    { label: 'Tax', value: bill.taxCost ?? 0 },
    { label: 'Other', value: bill.otherCost ?? 0 },
  ].filter(part => part.value !== 0);

  return (
    <details className="mt-1">
      <summary className="cursor-pointer text-xs text-foreground-muted">
        {parts.map(part => `${part.label} ${formatCurrency(part.value)}`).join(' · ')}
      </summary>
      <ul className="mt-1 space-y-0.5">
        {charges.map((charge, index) => (
          <li key={`${charge.label}-${index}`} className="flex justify-between gap-4 text-xs text-foreground-muted">
            <span className="truncate">{charge.label}</span>
            <span className={`shrink-0 font-mono ${charge.amount < 0 ? 'text-positive' : ''}`}>
              {formatCurrency(charge.amount)}
            </span>
          </li>
        ))}
      </ul>
      {(bill.otherCost ?? 0) !== 0 && (
        <p className="mt-1 text-xs text-foreground-muted">
          Non-utility items are excluded from the total so they do not distort cost per {bill.unit}.
        </p>
      )}
    </details>
  );
}

/** Evidence link to the source receipt; opens the stored bill image/PDF as uploaded. */
function ReceiptLink({ receiptId, className }: { receiptId: number | null | undefined; className?: string }) {
  if (!receiptId) return null;
  return (
    <a
      href={`/api/receipts/${receiptId}`}
      target="_blank"
      rel="noreferrer"
      className={className ?? 'text-xs text-primary underline-offset-2 hover:underline'}
    >
      View receipt
    </a>
  );
}

/** One suggestion in the review queue, with its duplicate flag when one applies. */
function SuggestionRow(props: {
  bill: UtilityBill;
  duplicate: UtilityBill | null;
  selected: boolean;
  onToggle: () => void;
  onImport: () => void;
}) {
  const { bill, duplicate } = props;
  const summary = `${bill.periodStart ? `${bill.periodStart} → ${bill.periodEnd}` : bill.date} · ${bill.provider || 'Unknown provider'}`;
  return (
    <div className="flex flex-wrap items-start gap-3 border-b border-border py-2.5 text-sm">
      <input
        type="checkbox"
        className="mt-1"
        checked={props.selected}
        onChange={props.onToggle}
        aria-label={`Select ${bill.type} bill ${summary}`}
      />
      <div className="min-w-0 flex-1">
        <span>
          {summary} · {bill.type}
          {' · '}
          <span className="font-mono" style={TNUM}>{bill.usage.toLocaleString()} {bill.unit} / {formatCurrency(bill.totalCost)}</span>
        </span>
        {duplicate && (
          <span className="ml-2 inline-block rounded-sm bg-warning/15 px-1.5 py-0.5 text-[11px] font-semibold text-warning">
            Possible duplicate — matches the {duplicate.date} {duplicate.type} bill
          </span>
        )}
        <UtilityChargeBreakdown bill={bill} />
      </div>
      <div className="flex shrink-0 items-center gap-3 pt-0.5">
        <ReceiptLink receiptId={bill.receiptId} />
        <button type="button" onClick={props.onImport} className="text-sm font-semibold text-primary">
          Import
        </button>
      </div>
    </div>
  );
}

type SortKey = 'date' | 'provider' | 'usage' | 'rate' | 'total';
type TypeFilter = 'all' | UtilityBill['type'];

const CHIP = 'rounded-full border px-2.5 py-1 text-xs transition-colors';
const CHIP_ON = `${CHIP} border-primary/50 bg-primary-light text-primary`;
const CHIP_OFF = `${CHIP} border-border text-foreground-secondary hover:text-foreground`;

function billRate(bill: UtilityBill): number | null {
  return bill.usage > 0 ? bill.totalCost / bill.usage : null;
}

/** Sortable, filterable table of imported bills with per-row expand-to-edit. */
function BillsTable(props: {
  bills: UtilityBill[];
  stagedIds: ReadonlySet<string>;
  expandedId: string | null;
  onExpand: (id: string | null) => void;
  onUpdate: (id: string, patch: Partial<UtilityBill>) => void;
  onRemove: (id: string) => void;
  typeFilter: TypeFilter;
  onTypeFilter: (filter: TypeFilter) => void;
}) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'date', dir: -1 });

  const counts = useMemo(() => {
    const byType = { electric: 0, gas: 0, water: 0 } as Record<UtilityBill['type'], number>;
    for (const bill of props.bills) byType[bill.type] += 1;
    return byType;
  }, [props.bills]);

  const rows = useMemo(() => {
    const filtered = props.typeFilter === 'all'
      ? props.bills
      : props.bills.filter(bill => bill.type === props.typeFilter);
    const value = (bill: UtilityBill): string | number => {
      switch (sort.key) {
        case 'date': return bill.date;
        case 'provider': return bill.provider.toLowerCase();
        case 'usage': return bill.usage;
        case 'rate': return billRate(bill) ?? -1;
        case 'total': return bill.totalCost;
      }
    };
    return filtered.slice().sort((a, b) => {
      const va = value(a);
      const vb = value(b);
      const cmp = typeof va === 'string' ? va.localeCompare(vb as string) : va - (vb as number);
      return cmp * sort.dir;
    });
  }, [props.bills, props.typeFilter, sort]);

  const header = (key: SortKey, label: string, align: 'left' | 'right' = 'left') => (
    <th className={`py-2 pr-3 ${align === 'right' ? 'text-right' : 'text-left'}`}>
      <button
        type="button"
        onClick={() => setSort(current => current.key === key
          ? { key, dir: current.dir === 1 ? -1 : 1 }
          : { key, dir: key === 'provider' ? 1 : -1 })}
        className="font-semibold uppercase tracking-wider transition-colors hover:text-foreground"
      >
        {label}{sort.key === key ? (sort.dir === -1 ? ' ↓' : ' ↑') : ''}
      </button>
    </th>
  );

  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-1.5">
        <button type="button" onClick={() => props.onTypeFilter('all')} className={props.typeFilter === 'all' ? CHIP_ON : CHIP_OFF}>
          All ({props.bills.length})
        </button>
        {(['electric', 'gas', 'water'] as const).map(type => (
          <button key={type} type="button" onClick={() => props.onTypeFilter(type)} className={props.typeFilter === type ? CHIP_ON : CHIP_OFF}>
            {type} ({counts[type]})
          </button>
        ))}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-[10px] text-foreground-muted">
              {header('date', 'Date')}
              <th className="py-2 pr-3 font-semibold uppercase tracking-wider">Type</th>
              {header('provider', 'Provider')}
              {header('usage', 'Usage', 'right')}
              {header('rate', '$ / unit', 'right')}
              {header('total', 'Total', 'right')}
              <th className="py-2 pr-3 font-semibold uppercase tracking-wider">Source</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map(bill => {
              const staged = props.stagedIds.has(bill.id);
              const expanded = props.expandedId === bill.id;
              const rate = billRate(bill);
              return (
                <BillRow
                  key={bill.id}
                  bill={bill}
                  staged={staged}
                  expanded={expanded}
                  rate={rate}
                  onExpand={() => props.onExpand(expanded ? null : bill.id)}
                  onUpdate={patch => props.onUpdate(bill.id, patch)}
                  onRemove={() => props.onRemove(bill.id)}
                />
              );
            })}
          </tbody>
        </table>
      </div>
      {props.typeFilter !== 'all' && rows.length === 0 && (
        <p className="mt-3 text-xs text-foreground-muted">No {props.typeFilter} bills yet.</p>
      )}
    </div>
  );
}

function BillRow(props: {
  bill: UtilityBill;
  staged: boolean;
  expanded: boolean;
  rate: number | null;
  onExpand: () => void;
  onUpdate: (patch: Partial<UtilityBill>) => void;
  onRemove: () => void;
}) {
  const { bill } = props;
  return (
    <>
      <tr className={`border-b border-border/60 ${props.staged ? 'bg-primary-light' : ''}`}>
        <td className="py-2 pr-3 font-mono" style={TNUM}>{bill.date}</td>
        <td className="py-2 pr-3">{bill.type}</td>
        <td className="max-w-[220px] truncate py-2 pr-3">
          {bill.provider || <span className="text-foreground-muted">Unnamed provider</span>}
          {props.staged && (
            <span className="ml-2 rounded-sm bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
              staged
            </span>
          )}
        </td>
        <td className="py-2 pr-3 text-right font-mono" style={TNUM}>{bill.usage.toLocaleString()} {bill.unit}</td>
        <td className="py-2 pr-3 text-right font-mono" style={TNUM}>{props.rate != null ? `$${props.rate.toFixed(2)}` : '—'}</td>
        <td className="py-2 pr-3 text-right font-mono" style={TNUM}>{formatCurrency(bill.totalCost)}</td>
        <td className="py-2 pr-3">
          {bill.receiptId
            ? <ReceiptLink receiptId={bill.receiptId} className="text-xs text-primary underline-offset-2 hover:underline" />
            : <span className="text-xs text-foreground-muted">manual</span>}
        </td>
        <td className="py-2 text-right">
          <button type="button" onClick={props.onExpand} className="text-xs text-primary" aria-expanded={props.expanded}>
            {props.expanded ? 'Close' : 'Edit'}
          </button>
        </td>
      </tr>
      {props.expanded && (
        <tr className="border-b border-border/60">
          <td colSpan={8} className="py-3">
            <FieldGrid>
              <Field label="Date"><input type="date" className={`${INPUT} font-mono`} value={bill.date} onChange={event => props.onUpdate({ date: event.target.value })} /></Field>
              <Field label="Type"><select className={INPUT} value={bill.type} onChange={event => { const type = event.target.value as UtilityBill['type']; props.onUpdate({ type, unit: type === 'electric' ? 'kWh' : type === 'gas' ? 'therms' : 'gallons' }); }}><option>electric</option><option>gas</option><option>water</option></select></Field>
              <Field label="Provider"><input className={INPUT} value={bill.provider} onChange={event => props.onUpdate({ provider: event.target.value })} /></Field>
              <Field label={`Usage (${bill.unit})`}><input type="number" className={`${INPUT} font-mono`} value={bill.usage} onChange={event => props.onUpdate({ usage: numberValue(event.target.value) })} /></Field>
              <Field label="Total cost"><input type="number" className={`${INPUT} font-mono`} value={bill.totalCost} onChange={event => props.onUpdate({ totalCost: numberValue(event.target.value) })} /></Field>
            </FieldGrid>
            {bill.periodStart && (
              <p className="mt-2 text-xs text-foreground-muted">
                Service period {bill.periodStart} → {bill.periodEnd}
              </p>
            )}
            <UtilityChargeBreakdown bill={bill} />
            <div className="mt-3 flex justify-end">
              <button type="button" onClick={props.onRemove} className="text-xs text-foreground-muted transition-colors hover:text-negative">
                Remove bill
              </button>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

export function UtilitiesPlannerPage() {
  const toast = useToast();
  const searchParams = useSearchParams();
  const state = useSection<UtilitiesProfile, UtilityResponse>('utilities', {
    bills: [],
    solar: { enabled: false, systemCost: 0, incentives: 0, annualProductionKwh: 0, degradationRate: 0.5, electricRateInflation: 3, annualMaintenance: 0, analysisYears: 25 },
  });
  // Honor the Action Center's deep link into the solar scenario.
  const [tab, setTab] = useState<'usage' | 'solar'>(searchParams.get('tab') === 'solar' ? 'solar' : 'usage');
  // OCR runs on a worker, so a fresh upload has no suggestion yet. Poll the
  // section until one appears (or we give up), refreshing only the computed
  // half of the response so unsaved bill edits survive.
  const [analyzing, setAnalyzing] = useState(false);
  const suggestionBaseline = useRef(0);
  const refreshRef = useRef(state.refresh);
  useEffect(() => { refreshRef.current = state.refresh; });

  // Review-queue state: which suggestions are ticked, which imported bills are
  // staged-but-unsaved (they get the row highlight and the undo affordance),
  // and which table row is open for editing.
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [stagedIds, setStagedIds] = useState<readonly string[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');

  const responseSuggestions = state.response?.suggestions;
  const suggestions = useMemo(() => responseSuggestions ?? [], [responseSuggestions]);
  const suggestionCount = suggestions.length;

  useEffect(() => {
    if (!analyzing) return;
    const deadline = Date.now() + BILL_ANALYSIS_TIMEOUT_MS;
    const timer = setInterval(() => {
      // Stop as soon as a new suggestion lands, or when the worker has had
      // long enough that a bill this OCR pass could not parse is the likelier
      // explanation than a slow queue.
      void refreshRef.current()
        .then(next => {
          if (next.suggestions.length > suggestionBaseline.current) setAnalyzing(false);
        })
        .catch(() => undefined)
        .finally(() => { if (Date.now() > deadline) setAnalyzing(false); });
    }, BILL_ANALYSIS_POLL_MS);
    return () => clearInterval(timer);
  }, [analyzing]);

  const handleUploaded = useCallback((succeeded: number) => {
    if (succeeded === 0) return;
    suggestionBaseline.current = suggestionCount;
    setAnalyzing(true);
    void refreshRef.current().catch(() => undefined);
  }, [suggestionCount]);

  // The server filters suggestions against SAVED bills only; filtering against
  // the edit buffer here is what makes Import feel immediate — the row leaves
  // the queue the moment the bill is staged, before any Save.
  const bufferReceiptIds = useMemo(
    () => new Set(state.profile.bills.flatMap(bill => bill.receiptId ? [bill.receiptId] : [])),
    [state.profile.bills],
  );
  const queue = useMemo(() =>
    suggestions
      .filter(bill => !bill.receiptId || !bufferReceiptIds.has(bill.receiptId))
      .map(bill => ({ bill, duplicate: findDuplicateUtilityBill(bill, state.profile.bills) })),
    [suggestions, bufferReceiptIds, state.profile.bills]);
  const cleanIds = useMemo(
    () => queue.filter(item => !item.duplicate).map(item => item.bill.id),
    [queue],
  );
  const selectedBills = queue.filter(item => selected.has(item.bill.id)).map(item => item.bill);
  const allCleanSelected = cleanIds.length > 0 && cleanIds.every(id => selected.has(id));

  if (state.loading) return <div className="p-6 text-sm text-foreground-muted">Loading utility history…</div>;

  const updateBill = (id: string, patch: Partial<UtilityBill>) => state.change({ ...state.profile, bills: state.profile.bills.map(bill => bill.id === id ? { ...bill, ...patch } : bill) });
  const removeBill = (id: string) => {
    state.change({ ...state.profile, bills: state.profile.bills.filter(bill => bill.id !== id) });
    setStagedIds(current => current.filter(item => item !== id));
    if (expandedId === id) setExpandedId(null);
  };
  const updateSolar = (patch: Partial<UtilitiesProfile['solar']>) => state.change({ ...state.profile, solar: { ...state.profile.solar, ...patch } });

  const addManualBill = () => {
    const bill: UtilityBill = { id: uid(), date: today(), type: 'electric', provider: '', usage: 0, unit: 'kWh', totalCost: 0, receiptId: null, transactionGuid: null };
    state.change({ ...state.profile, bills: [...state.profile.bills, bill] });
    setTypeFilter('all');
    setExpandedId(bill.id);
  };

  const importBills = (bills: UtilityBill[]) => {
    if (bills.length === 0) return;
    state.change({ ...state.profile, bills: [...state.profile.bills, ...bills] });
    setStagedIds(current => [...current, ...bills.map(bill => bill.id)]);
    setSelected(current => {
      const next = new Set(current);
      for (const bill of bills) next.delete(bill.id);
      return next;
    });
    toast.success(bills.length === 1
      ? 'Bill staged in the table below — Save to keep it'
      : `${bills.length} bills staged in the table below — Save to keep them`);
  };

  const undoStagedImports = () => {
    const staged = new Set(stagedIds);
    state.change({ ...state.profile, bills: state.profile.bills.filter(bill => !staged.has(bill.id)) });
    if (expandedId && staged.has(expandedId)) setExpandedId(null);
    toast.info(`${stagedIds.length} staged bill${stagedIds.length === 1 ? '' : 's'} returned to the review queue`);
    setStagedIds([]);
  };

  const toggleSelected = (id: string) => setSelected(current => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleAllClean = () => setSelected(allCleanSelected ? new Set() : new Set(cleanIds));

  const saveAll = async () => {
    if (await state.save()) setStagedIds([]);
  };
  const discardAll = () => {
    state.discard();
    setStagedIds([]);
    setSelected(new Set());
    setExpandedId(null);
  };

  return (
    <div className="mx-auto max-w-[1400px] space-y-6 p-4 sm:p-6">
      <PageHeader title="Utilities & Solar" subtitle="Separate usage changes from rate increases and test solar against actual household bills." actions={<button type="button" onClick={addManualBill} className="rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary-hover">Add bill</button>} />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'usage', label: 'Usage & rates' }, { value: 'solar', label: 'Solar scenario' }]} />
      {tab === 'usage' && <>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4"><Metric label="Trailing 12-month cost" value={formatCurrency(state.response?.analysis.trailing12Cost ?? 0)} />{state.response?.analysis.byType.map(row => <Metric key={row.type} label={`${row.type} unit rate`} value={`$${row.latestRate.toFixed(2)}`} tone={row.rateChangePercent > 15 ? 'warning' : undefined} />)}</div>
        <Panel
          title="Review queue — bills read from receipts"
          description="Uploaded bills are stored as receipts and read by OCR. Importing stages a bill in the table below and removes it from this queue; nothing is stored until you Save."
          action={queue.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              {stagedIds.length > 0 && (
                <button type="button" onClick={undoStagedImports} className="rounded-md border border-border px-3 py-2 text-xs text-foreground-secondary transition-colors hover:text-foreground">
                  Undo staged imports ({stagedIds.length})
                </button>
              )}
              <button
                type="button"
                onClick={() => importBills(selectedBills)}
                disabled={selectedBills.length === 0}
                className="rounded-md bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary-hover disabled:opacity-50"
              >
                Import selected ({selectedBills.length})
              </button>
            </div>
          ) : stagedIds.length > 0 ? (
            <button type="button" onClick={undoStagedImports} className="rounded-md border border-border px-3 py-2 text-xs text-foreground-secondary transition-colors hover:text-foreground">
              Undo staged imports ({stagedIds.length})
            </button>
          ) : undefined}
        >
          <UtilityBillCapture onUploaded={handleUploaded} />
          <div className="mt-4">
            {queue.length > 0 ? (
              <div>
                <label className="flex items-center gap-2 border-b border-border pb-2 text-xs text-foreground-secondary">
                  <input
                    type="checkbox"
                    checked={allCleanSelected}
                    onChange={toggleAllClean}
                    aria-label="Select all bills without warnings"
                  />
                  Select all without warnings ({cleanIds.length} of {queue.length})
                </label>
                {queue.map(({ bill, duplicate }) => (
                  <SuggestionRow
                    key={bill.id}
                    bill={bill}
                    duplicate={duplicate}
                    selected={selected.has(bill.id)}
                    onToggle={() => toggleSelected(bill.id)}
                    onImport={() => importBills([bill])}
                  />
                ))}
              </div>
            ) : (
              <Empty>
                {analyzing
                  ? 'Reading the uploaded bills — usage and amount appear here once OCR finishes.'
                  : 'No bills waiting for review. Drop a bill above, or add one by hand with “Add bill”.'}
              </Empty>
            )}
          </div>
          {analyzing && queue.length > 0 && (
            <p className="mt-3 text-xs text-foreground-muted" aria-live="polite">Still reading the most recent upload…</p>
          )}
        </Panel>
        <Panel title="Utility bills" description="Rate and usage changes are calculated independently. Staged rows are imported but not yet saved.">
          {state.profile.bills.length === 0
            ? <Empty>Add a bill manually, or drop one into bill capture above.</Empty>
            : (
              <BillsTable
                bills={state.profile.bills}
                stagedIds={new Set(stagedIds)}
                expandedId={expandedId}
                onExpand={setExpandedId}
                onUpdate={updateBill}
                onRemove={removeBill}
                typeFilter={typeFilter}
                onTypeFilter={setTypeFilter}
              />
            )}
        </Panel>
      </>}
      {tab === 'solar' && <>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4"><Metric label="Net upfront cost" value={formatCurrency(state.response?.solar.upfrontCost ?? 0)} /><Metric label="Current electric rate" value={`$${(state.response?.solar.currentElectricRate ?? 0).toFixed(2)}/kWh`} /><Metric label="Simple payback" value={state.response?.solar.paybackYear ? `${state.response.solar.paybackYear} years` : 'Not reached'} tone={state.response?.solar.paybackYear ? 'positive' : 'warning'} /><Metric label="Lifetime net savings" value={formatCurrency(state.response?.solar.lifetimeSavings ?? 0)} tone={(state.response?.solar.lifetimeSavings ?? 0) >= 0 ? 'positive' : 'negative'} /></div>
        <Panel title="Solar capital scenario" description="Uses entered production and actual latest electric rate; this is a planning scenario, not a contractor quote."><label className="mb-4 flex items-center gap-2 text-sm"><input type="checkbox" checked={state.profile.solar.enabled} onChange={event => updateSolar({ enabled: event.target.checked })} /> Enable scenario</label><FieldGrid>{([['System cost','systemCost'],['Incentives','incentives'],['Annual production kWh','annualProductionKwh'],['Degradation %','degradationRate'],['Electric inflation %','electricRateInflation'],['Annual maintenance','annualMaintenance'],['Analysis years','analysisYears']] as const).map(([label, key]) => <Field key={key} label={label}><input type="number" step="0.1" className={`${INPUT} font-mono`} value={state.profile.solar[key]} onChange={event => updateSolar({ [key]: numberValue(event.target.value) })} /></Field>)}</FieldGrid></Panel>
      </>}
      <SaveBar
        saving={state.saving}
        dirty={state.dirty}
        onSave={saveAll}
        onDiscard={discardAll}
        message={stagedIds.length > 0
          ? `${stagedIds.length} imported bill${stagedIds.length === 1 ? '' : 's'} staged — not saved yet`
          : undefined}
      />
    </div>
  );
}

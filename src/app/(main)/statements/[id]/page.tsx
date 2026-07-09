'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { AccountSelector } from '@/components/ui/AccountSelector';
import { useToast } from '@/contexts/ToastContext';
import { useKeyboardShortcut } from '@/lib/hooks/useKeyboardShortcut';
import { useAccounts } from '@/lib/hooks/useAccounts';
import { formatAccountPath } from '@/lib/account-utils';
import { formatCurrency } from '@/lib/format';
import {
  statusBadge,
  tieOutDisplay,
  canFinalize,
  buildMissingDecisions,
  buildUnmatchDecision,
  missingCounterparts,
  amountTone,
  isPollingStatus,
  type TieOut,
  type MissingLineState,
  type MissingDecision,
} from '../statement-ui';

// ---------------------------------------------------------------------------
// Types (from GET /api/statements/[id]/reconcile)
// ---------------------------------------------------------------------------

interface ReconcileBatch {
  id: number;
  status: string;
  accountGuid: string | null;
  statementStartDate: string | null;
  statementEndDate: string | null;
  openingBalance: number | string | null;
  closingBalance: number | string | null;
  currency: string | null;
  originalFilename: string;
}

interface LineRef {
  date: string;
  description: string;
  amount: number;
}

interface MatchedPair {
  lineId: number;
  splitGuid: string;
  auto: boolean;
  line: LineRef;
  split: LineRef & { reconcileState?: string };
}

interface MissingLine {
  lineId: number;
  date: string;
  description: string;
  amount: number;
  suggestedAccountGuid: string | null;
  suggestedAccountName: string | null;
  decision: 'add' | null;
}

interface LedgerOnly {
  splitGuid: string;
  date: string;
  description: string;
  amount: number;
  reconcileState?: string;
}

interface ReconcileView {
  batch: ReconcileBatch;
  matched: MatchedPair[];
  missing: MissingLine[];
  inLedgerNotOnStatement: LedgerOnly[];
  tieOut: TieOut | null;
  windowDays: number;
}

// Also used for the initial batch fetch (status / error surfacing).
interface DetailBatch {
  id: number;
  status: string;
  accountGuid: string | null;
  originalFilename: string;
  source: string;
  error: string | null;
  statementStartDate: string | null;
  statementEndDate: string | null;
  openingBalance: number | string | null;
  closingBalance: number | string | null;
  currency: string | null;
}

const num = (v: number | string | null | undefined): number => {
  if (v === null || v === undefined || v === '') return 0;
  return typeof v === 'string' ? parseFloat(v) : v;
};

function formatDate(value: string | null): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' });
}

// ---------------------------------------------------------------------------
// Signed amount cell
// ---------------------------------------------------------------------------

function Amount({ value, currency }: { value: number; currency: string | null }) {
  return (
    <span className={`font-mono tabular-nums ${amountTone(value)}`}>
      {formatCurrency(value, currency || 'USD')}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function StatementReconcilePage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const toast = useToast();
  const id = params?.id;

  const { data: accounts } = useAccounts({ flat: true });
  const accountName = useCallback(
    (guid: string | null | undefined): string => {
      if (!guid) return '';
      const a = (accounts ?? []).find((x) => x.guid === guid) as
        | { fullname?: string; name: string }
        | undefined;
      return a ? formatAccountPath(a.fullname, a.name) : '';
    },
    [accounts],
  );

  const [batch, setBatch] = useState<DetailBatch | null>(null);
  const [view, setView] = useState<ReconcileView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reparsing, setReparsing] = useState(false);

  // Local decision state for the "missing" section.
  const [missingState, setMissingState] = useState<Record<number, MissingLineState>>({});
  const [saving, setSaving] = useState(false);
  const [finalizing, setFinalizing] = useState(false);

  // Live tie-out — starts from the reconcile view, updated by each PUT response.
  const [tieOut, setTieOut] = useState<TieOut | null>(null);

  // --- data fetching --------------------------------------------------------

  const fetchDetail = useCallback(async (): Promise<DetailBatch | null> => {
    const res = await fetch(`/api/statements/${id}`);
    if (!res.ok) throw new Error('Statement not found');
    const data = await res.json();
    return data.batch as DetailBatch;
  }, [id]);

  const fetchReconcile = useCallback(async (): Promise<ReconcileView | null> => {
    const res = await fetch(`/api/statements/${id}/reconcile`);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Failed to load reconcile view');
    }
    return (await res.json()) as ReconcileView;
  }, [id]);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const b = await fetchDetail();
      setBatch(b);
      if (b && b.status !== 'error' && !isPollingStatus(b.status)) {
        const v = await fetchReconcile();
        setView(v);
        setTieOut(v?.tieOut ?? null);
        // Seed local missing state from persisted decisions / suggestions.
        setMissingState((prev) => {
          const next: Record<number, MissingLineState> = {};
          for (const m of v?.missing ?? []) {
            const existing = prev[m.lineId];
            next[m.lineId] = existing ?? {
              lineId: m.lineId,
              decision: (m.decision ?? 'add') as MissingDecision,
              counterpartAccountGuid: m.suggestedAccountGuid ?? undefined,
            };
          }
          return next;
        });
      } else {
        setView(null);
      }
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load statement');
    } finally {
      setLoading(false);
    }
  }, [id, fetchDetail, fetchReconcile]);

  useEffect(() => {
    load();
  }, [load]);

  // Poll while parsing.
  const parsing = batch ? isPollingStatus(batch.status) : false;
  useEffect(() => {
    if (!parsing) return;
    const interval = setInterval(load, 2500);
    return () => clearInterval(interval);
  }, [parsing, load]);

  // --- mutations ------------------------------------------------------------

  const setDecision = useCallback((lineId: number, decision: MissingDecision) => {
    setMissingState((prev) => ({
      ...prev,
      [lineId]: { ...prev[lineId], lineId, decision },
    }));
  }, []);

  const setCounterpart = useCallback((lineId: number, guid: string) => {
    setMissingState((prev) => ({
      ...prev,
      [lineId]: { ...prev[lineId], lineId, counterpartAccountGuid: guid },
    }));
  }, []);

  const putDecisions = useCallback(
    async (payload: ReturnType<typeof buildMissingDecisions>): Promise<boolean> => {
      const res = await fetch(`/api/statements/${id}/lines`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to save decisions');
      }
      const data = await res.json();
      if (data.tieOut) setTieOut(data.tieOut as TieOut);
      if (Array.isArray(data.errors) && data.errors.length > 0) {
        toast.warning(`${data.errors.length} line(s) had problems and were skipped.`);
      }
      return true;
    },
    [id, toast],
  );

  const missingStates = useMemo(() => Object.values(missingState), [missingState]);
  const unresolved = useMemo(() => missingCounterparts(missingStates), [missingStates]);

  const handleSaveMissing = useCallback(async () => {
    if (unresolved.length > 0) {
      toast.error('Choose an account for every line marked "Add" before saving.');
      return;
    }
    setSaving(true);
    try {
      await putDecisions(buildMissingDecisions(missingStates));
      toast.success('Decisions saved.');
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }, [unresolved, missingStates, putDecisions, toast, load]);

  const handleUnmatch = useCallback(
    async (lineId: number) => {
      try {
        await putDecisions([buildUnmatchDecision(lineId)]);
        toast.success('Match removed.');
        await load();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to un-match');
      }
    },
    [putDecisions, toast, load],
  );

  const handleFinalize = useCallback(async () => {
    if (!canFinalize(tieOut)) return;
    setFinalizing(true);
    try {
      const res = await fetch(`/api/statements/${id}/finalize`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 409 && data.tieOut) {
          const diff = num(data.tieOut.difference);
          toast.error(
            `Cannot finalize — statement is out of balance by ${formatCurrency(Math.abs(diff), batch?.currency || 'USD')}.`,
          );
          setTieOut(data.tieOut as TieOut);
        } else {
          toast.error(data.error || 'Finalize failed.');
        }
        return;
      }
      toast.success('Statement reconciled.');
      router.push('/statements');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Finalize failed');
    } finally {
      setFinalizing(false);
    }
  }, [tieOut, id, batch, toast, router]);

  const reparse = useCallback(async () => {
    setReparsing(true);
    try {
      const res = await fetch(`/api/statements/${id}/parse`, { method: 'POST' });
      if (!res.ok) throw new Error('Re-parse failed');
      toast.success('Re-parsing statement…');
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Re-parse failed');
    } finally {
      setReparsing(false);
    }
  }, [id, toast, load]);

  // Finalize keyboard shortcut (Enter-free to avoid clashing with pickers).
  useKeyboardShortcut(
    'statement-finalize',
    'f',
    'Finalize reconciliation',
    () => { if (canFinalize(tieOut) && !finalizing) handleFinalize(); },
    'page',
    !!view && canFinalize(tieOut),
  );

  const currency = batch?.currency ?? view?.batch.currency ?? 'USD';
  const tieDisplay = tieOutDisplay(tieOut);

  // --- render ---------------------------------------------------------------

  if (loading) {
    return (
      <div className="max-w-5xl mx-auto px-6 py-8">
        <div className="flex items-center justify-center py-24 gap-3 text-sm text-foreground-muted">
          <span className="w-4 h-4 border-2 border-foreground-muted/30 border-t-foreground-muted rounded-full animate-spin" />
          Loading statement…
        </div>
      </div>
    );
  }

  if (loadError || !batch) {
    return (
      <div className="max-w-5xl mx-auto px-6 py-8 space-y-4">
        <BackLink />
        <div className="flex flex-col items-center justify-center py-20 gap-3">
          <span className="text-sm text-[color:var(--negative)]">{loadError || 'Statement not found.'}</span>
          <button
            onClick={() => { setLoading(true); load(); }}
            className="px-3 py-1.5 text-xs font-medium rounded-lg border border-border text-foreground-secondary hover:bg-surface-hover hover:text-foreground transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const st = statusBadge(batch.status);

  return (
    <div className="max-w-5xl mx-auto px-6 py-8 space-y-6">
      <BackLink />

      {/* Header */}
      <div className="space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-xl sm:text-2xl font-bold text-foreground truncate" title={batch.originalFilename}>
              {batch.originalFilename}
            </h1>
            <p className="text-sm text-foreground-secondary mt-0.5">
              {accountName(batch.accountGuid) || 'No account assigned'}
              {' · '}
              <span className="font-mono tabular-nums">
                {formatDate(batch.statementStartDate)} – {formatDate(batch.statementEndDate)}
              </span>
            </p>
          </div>
          <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium shrink-0 ${st.className}`}>
            {st.label}
          </span>
        </div>

        {/* Balance summary */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <SummaryTile label="Opening" value={formatCurrency(num(batch.openingBalance), currency)} />
          <SummaryTile label="Closing" value={formatCurrency(num(batch.closingBalance), currency)} />
          <SummaryTile
            label="Statement Change"
            value={formatCurrency(num(batch.closingBalance) - num(batch.openingBalance), currency)}
          />
          <SummaryTile label="Currency" value={currency} mono={false} />
        </div>
      </div>

      {/* Error state */}
      {batch.status === 'error' && (
        <div className="bg-[color:var(--negative)]/10 border border-[color:var(--negative)]/30 rounded-xl p-5 space-y-3">
          <div>
            <h2 className="text-sm font-semibold text-[color:var(--negative)]">Parsing failed</h2>
            <p className="text-sm text-foreground-secondary mt-1">
              {batch.error || 'The statement could not be extracted. Try re-parsing, or re-upload a clearer file.'}
            </p>
          </div>
          <button
            onClick={reparse}
            disabled={reparsing}
            className="px-3 py-1.5 text-sm font-medium rounded-lg bg-primary text-primary-foreground hover:bg-primary-hover disabled:opacity-40 transition-colors inline-flex items-center gap-2"
          >
            {reparsing && <span className="w-4 h-4 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" />}
            {reparsing ? 'Re-parsing…' : 'Re-parse'}
          </button>
        </div>
      )}

      {/* Parsing state */}
      {parsing && (
        <div className="bg-surface border border-border rounded-xl p-8 flex flex-col items-center justify-center gap-3">
          <span className="w-5 h-5 border-2 border-foreground-muted/30 border-t-foreground-muted rounded-full animate-spin" />
          <span className="text-sm text-foreground-secondary">Extracting transactions from this statement…</span>
        </div>
      )}

      {/* Reconcile workspace */}
      {view && batch.status !== 'error' && !parsing && (
        <>
          {/* Tie-out banner (sticky) */}
          <div
            className={`sticky top-2 z-10 rounded-xl border p-4 backdrop-blur-sm ${
              tieDisplay.tone === 'positive'
                ? 'border-[color:var(--positive)]/40 bg-[color:var(--positive)]/10'
                : tieDisplay.tone === 'negative'
                  ? 'border-[color:var(--negative)]/40 bg-[color:var(--negative)]/10'
                  : 'border-[color:var(--warning)]/40 bg-[color:var(--warning)]/10'
            }`}
          >
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div className="min-w-0">
                <div
                  className={`text-sm font-semibold ${
                    tieDisplay.tone === 'positive'
                      ? 'text-[color:var(--positive)]'
                      : tieDisplay.tone === 'negative'
                        ? 'text-[color:var(--negative)]'
                        : 'text-[color:var(--warning)]'
                  }`}
                >
                  {tieDisplay.status}
                </div>
                <p className="text-xs text-foreground-secondary mt-0.5">{tieDisplay.detail}</p>
              </div>
              <div className="flex items-center gap-4 font-mono tabular-nums text-xs">
                <TieCell label="Opening" value={formatCurrency(num(batch.openingBalance), currency)} />
                <span className="text-foreground-muted">+</span>
                <TieCell
                  label="Expected Δ"
                  value={tieOut?.expectedChange != null ? formatCurrency(tieOut.expectedChange, currency) : '—'}
                />
                <span className="text-foreground-muted">→</span>
                <TieCell label="Closing" value={formatCurrency(num(batch.closingBalance), currency)} />
                <TieCell
                  label="Actual Δ"
                  value={tieOut?.actualChange != null ? formatCurrency(tieOut.actualChange, currency) : '—'}
                />
                <TieCell
                  label="Difference"
                  value={tieOut?.difference != null ? formatCurrency(tieOut.difference, currency) : '—'}
                  tone={tieDisplay.tone}
                />
              </div>
            </div>
          </div>

          {/* a. Matched */}
          <Section
            title="Matched"
            count={view.matched.length}
            hint="Statement lines paired with a ledger transaction. Un-match anything that shouldn't clear."
          >
            {view.matched.length === 0 ? (
              <EmptyRow text="No matched lines yet." />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="text-left border-b border-border">
                      <th className="text-xs text-foreground-muted font-medium py-2 px-3">Statement</th>
                      <th className="text-xs text-foreground-muted font-medium py-2 px-3 text-right">Amount</th>
                      <th className="text-xs text-foreground-muted font-medium py-2 px-3">Ledger</th>
                      <th className="text-xs text-foreground-muted font-medium py-2 px-3 text-right">Amount</th>
                      <th className="py-2 px-3" />
                    </tr>
                  </thead>
                  <tbody>
                    {view.matched.map((m) => (
                      <tr key={m.lineId} className="border-b border-border/50 last:border-0 bg-[color:var(--positive)]/[0.04]">
                        <td className="py-2 px-3">
                          <div className="text-foreground truncate max-w-[220px]" title={m.line.description}>
                            {m.line.description}
                          </div>
                          <div className="font-mono tabular-nums text-xs text-foreground-muted">{formatDate(m.line.date)}</div>
                        </td>
                        <td className="py-2 px-3 text-right whitespace-nowrap">
                          <Amount value={num(m.line.amount)} currency={currency} />
                        </td>
                        <td className="py-2 px-3">
                          <div className="text-foreground truncate max-w-[220px] flex items-center gap-1.5" title={m.split.description}>
                            {m.split.description}
                            {m.auto && (
                              <span className="text-[10px] font-medium uppercase tracking-wider text-secondary bg-secondary-light rounded px-1 py-px">
                                auto
                              </span>
                            )}
                          </div>
                          <div className="font-mono tabular-nums text-xs text-foreground-muted">{formatDate(m.split.date)}</div>
                        </td>
                        <td className="py-2 px-3 text-right whitespace-nowrap">
                          <Amount value={num(m.split.amount)} currency={currency} />
                        </td>
                        <td className="py-2 px-3 text-right">
                          <button
                            onClick={() => handleUnmatch(m.lineId)}
                            className="text-xs font-medium text-foreground-muted hover:text-[color:var(--negative)] transition-colors"
                          >
                            Un-match
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>

          {/* b. Missing → add */}
          <Section
            title="On statement, not in ledger"
            count={view.missing.length}
            hint="Add these as new transactions (pick the other side of the entry) or ignore them."
            tone="warning"
            action={
              view.missing.length > 0 ? (
                <button
                  onClick={handleSaveMissing}
                  disabled={saving}
                  className="px-3 py-1.5 text-sm font-medium rounded-lg bg-primary text-primary-foreground hover:bg-primary-hover disabled:opacity-40 transition-colors inline-flex items-center gap-2"
                >
                  {saving && <span className="w-4 h-4 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" />}
                  {saving ? 'Saving…' : 'Save decisions'}
                </button>
              ) : undefined
            }
          >
            {view.missing.length === 0 ? (
              <EmptyRow text="Nothing to add — every statement line is accounted for." />
            ) : (
              <div className="divide-y divide-border/50">
                {view.missing.map((m) => {
                  const state = missingState[m.lineId];
                  const decision: MissingDecision = state?.decision ?? 'add';
                  const counterpart = state?.counterpartAccountGuid ?? '';
                  const needsAccount = decision === 'add' && !counterpart;
                  return (
                    <div
                      key={m.lineId}
                      className={`py-3 px-3 flex flex-col sm:flex-row sm:items-center gap-3 ${
                        decision === 'add' ? 'bg-[color:var(--warning)]/[0.05]' : 'opacity-60'
                      }`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="text-[13px] text-foreground truncate" title={m.description}>{m.description}</div>
                        <div className="font-mono tabular-nums text-xs text-foreground-muted">{formatDate(m.date)}</div>
                      </div>
                      <div className="w-28 text-right shrink-0">
                        <Amount value={num(m.amount)} currency={currency} />
                      </div>
                      <div className="w-full sm:w-72 shrink-0">
                        <AccountSelector
                          value={counterpart}
                          onChange={(guid) => setCounterpart(m.lineId, guid)}
                          placeholder={m.suggestedAccountName ? `e.g. ${m.suggestedAccountName}` : 'Select account…'}
                          disabled={decision !== 'add'}
                          hasError={needsAccount}
                          compact
                        />
                      </div>
                      <div className="flex items-center gap-1 shrink-0 bg-input-bg border border-border rounded-lg p-0.5">
                        <ToggleButton active={decision === 'add'} onClick={() => setDecision(m.lineId, 'add')}>
                          Add
                        </ToggleButton>
                        <ToggleButton active={decision === 'ignore'} onClick={() => setDecision(m.lineId, 'ignore')}>
                          Ignore
                        </ToggleButton>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Section>

          {/* c. In ledger, not on statement */}
          <Section
            title="In ledger, not on statement"
            count={view.inLedgerNotOnStatement.length}
            hint="These stay uncleared — informational only."
            muted
          >
            {view.inLedgerNotOnStatement.length === 0 ? (
              <EmptyRow text="No unexplained ledger activity in this period." />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="text-left border-b border-border">
                      <th className="text-xs text-foreground-muted font-medium py-2 px-3">Date</th>
                      <th className="text-xs text-foreground-muted font-medium py-2 px-3">Description</th>
                      <th className="text-xs text-foreground-muted font-medium py-2 px-3 text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.inLedgerNotOnStatement.map((l) => (
                      <tr key={l.splitGuid} className="border-b border-border/50 last:border-0 text-foreground-muted">
                        <td className="py-2 px-3 font-mono tabular-nums whitespace-nowrap">{formatDate(l.date)}</td>
                        <td className="py-2 px-3 truncate max-w-[320px]" title={l.description}>{l.description}</td>
                        <td className="py-2 px-3 text-right font-mono tabular-nums whitespace-nowrap">
                          {formatCurrency(num(l.amount), currency)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>

          {/* Finalize */}
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-t border-border pt-5">
            <p className="text-xs text-foreground-muted max-w-xl">
              Finalizing adds the reviewed missing transactions and marks every matched entry reconciled
              to this statement. Enabled only when the statement ties out exactly.
            </p>
            <button
              onClick={handleFinalize}
              disabled={!canFinalize(tieOut) || finalizing}
              title={!canFinalize(tieOut) ? 'Statement must tie out before finalizing' : 'Finalize (f)'}
              className="px-5 py-2 text-sm font-medium rounded-lg bg-primary text-primary-foreground hover:bg-primary-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors inline-flex items-center justify-center gap-2 shrink-0"
            >
              {finalizing && <span className="w-4 h-4 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" />}
              {finalizing ? 'Finalizing…' : 'Finalize reconciliation'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small components
// ---------------------------------------------------------------------------

function BackLink() {
  const router = useRouter();
  return (
    <button
      onClick={() => router.push('/statements')}
      className="inline-flex items-center gap-1.5 text-sm text-foreground-secondary hover:text-foreground transition-colors"
    >
      <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
      </svg>
      Statements
    </button>
  );
}

function SummaryTile({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="bg-surface border border-border rounded-lg px-3 py-2">
      <div className="text-[10px] text-foreground-muted uppercase tracking-wider">{label}</div>
      <div className={`text-sm text-foreground mt-0.5 ${mono ? 'font-mono tabular-nums' : ''}`}>{value}</div>
    </div>
  );
}

function TieCell({ label, value, tone }: { label: string; value: string; tone?: string }) {
  const color =
    tone === 'positive'
      ? 'text-[color:var(--positive)]'
      : tone === 'negative'
        ? 'text-[color:var(--negative)]'
        : tone === 'warning'
          ? 'text-[color:var(--warning)]'
          : 'text-foreground';
  return (
    <div className="text-right">
      <div className="text-[9px] text-foreground-muted uppercase tracking-wider">{label}</div>
      <div className={color}>{value}</div>
    </div>
  );
}

function Section({
  title,
  count,
  hint,
  action,
  tone,
  muted,
  children,
}: {
  title: string;
  count: number;
  hint: string;
  action?: React.ReactNode;
  tone?: 'warning';
  muted?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="bg-surface border border-border rounded-xl overflow-hidden">
      <div className="flex items-start justify-between gap-3 px-4 py-3 border-b border-border">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
            {title}
            <span
              className={`text-xs font-medium rounded px-1.5 py-px ${
                tone === 'warning'
                  ? 'bg-[color:var(--warning)]/10 text-[color:var(--warning)]'
                  : muted
                    ? 'bg-surface-hover text-foreground-muted'
                    : 'bg-secondary-light text-secondary'
              }`}
            >
              {count}
            </span>
          </h2>
          <p className="text-xs text-foreground-muted mt-0.5">{hint}</p>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function EmptyRow({ text }: { text: string }) {
  return <div className="px-4 py-8 text-center text-sm text-foreground-muted">{text}</div>;
}

function ToggleButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
        active
          ? 'bg-primary text-primary-foreground'
          : 'text-foreground-secondary hover:text-foreground'
      }`}
    >
      {children}
    </button>
  );
}

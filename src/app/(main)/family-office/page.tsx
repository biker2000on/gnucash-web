'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  FamilyDocumentResult,
  FamilyOfficeSummary,
  TransferCandidate,
} from '@/lib/family-office/service';
import type { FinancialEvent, TimelineConflict } from '@/lib/money-timeline/types';

interface FamilyOfficePayload {
  summary: FamilyOfficeSummary;
  transfers: TransferCandidate[];
  documents: FamilyDocumentResult[];
  actionCounts: Record<string, number>;
  timeline: { events: FinancialEvent[]; conflicts: TimelineConflict[] };
}

function money(value: number, currency: string): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency === 'UNKNOWN' ? 'USD' : currency,
    maximumFractionDigits: 0,
  }).format(value);
}

function localDate(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

export default function FamilyOfficePage() {
  const [data, setData] = useState<FamilyOfficePayload | null>(null);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [workingId, setWorkingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (q = '') => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/family-office?q=${encodeURIComponent(q)}`, { cache: 'no-store' });
      if (!response.ok) throw new Error('The Family Office could not be loaded.');
      setData(await response.json() as FamilyOfficePayload);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The Family Office could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (data) void load(query);
    }, 350);
    return () => window.clearTimeout(timer);
    // Deliberately search only when query changes; `load` is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, load]);

  const approve = async (candidate: TransferCandidate) => {
    setWorkingId(candidate.id);
    setError(null);
    try {
      const response = await fetch('/api/family-office', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'approve_elimination', candidateId: candidate.id }),
      });
      const result = await response.json() as { candidate?: TransferCandidate; error?: string };
      if (!response.ok) throw new Error(result.error || 'The elimination could not be approved.');
      setData(previous => previous ? {
        ...previous,
        transfers: previous.transfers.map(item => item.id === candidate.id ? { ...item, approved: true } : item),
      } : previous);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The elimination could not be approved.');
    } finally {
      setWorkingId(null);
    }
  };

  const pendingTransfers = data?.transfers.filter(candidate => !candidate.approved) ?? [];
  const openActions = data
    ? Object.values(data.actionCounts).reduce((sum, count) => sum + count, 0)
    : 0;
  const nextEvents = useMemo(() => {
    if (!data) return [];
    const today = localDate(new Date());
    return data.timeline.events.filter(event => event.date >= today).slice(0, 8);
  }, [data]);

  if (loading && !data) {
    return <div className="mx-auto max-w-7xl p-6 text-sm text-foreground-muted">Building the permission-safe household and entity graph…</div>;
  }

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-4 sm:p-6">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-5">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary">Cross-book consolidation</p>
          <h1 className="mt-1 text-2xl font-bold text-foreground">Family Office</h1>
          <p className="mt-1 max-w-2xl text-sm text-foreground-secondary">
            Household, businesses, farms, rentals, and future entities as one ownership graph—without erasing book or permission boundaries.
          </p>
        </div>
        <div className="flex gap-2">
          <Link href="/settings" className="rounded-lg border border-border px-3 py-2 text-xs font-semibold text-foreground-secondary hover:border-primary/50">
            Manage ownership & access
          </Link>
          <Link href="/actions?scope=family" className="rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-background hover:bg-primary-hover">
            Review {openActions} actions
          </Link>
        </div>
      </header>

      {error && <div className="rounded-lg border border-negative/40 bg-negative/10 p-3 text-sm text-negative">{error}</div>}

      {data && (
        <>
          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
            {[
              ['Consolidated net worth', money(data.summary.consolidated.netWorth, data.summary.reportingCurrency)],
              ['Trailing income', money(data.summary.consolidated.totalIncome, data.summary.reportingCurrency)],
              ['Trailing expenses', money(data.summary.consolidated.totalExpenses, data.summary.reportingCurrency)],
              ['Cash flow', money(data.summary.consolidated.cashFlow, data.summary.reportingCurrency)],
              ['Investments', money(data.summary.consolidated.investmentValue, data.summary.reportingCurrency)],
              ['Liquidity', money(data.summary.consolidated.liquidity, data.summary.reportingCurrency)],
            ].map(([label, value]) => (
              <div key={label} className="rounded-lg border border-border bg-surface p-4">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-foreground-muted">{label}</p>
                <p className="mt-1 font-mono text-base font-semibold text-foreground">{value}</p>
              </div>
            ))}
          </section>

          {data.summary.warnings.length > 0 && (
            <section className="rounded-lg border border-warning/40 bg-warning/5 p-4">
              <h2 className="text-sm font-semibold text-warning">Consolidation warnings</h2>
              <ul className="mt-2 space-y-1 text-xs text-foreground-secondary">
                {data.summary.warnings.map(warning => <li key={warning}>• {warning}</li>)}
              </ul>
            </section>
          )}

          <section className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
            <div className="rounded-lg border border-border bg-surface/30 p-5">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold text-foreground">Entity & ownership graph</h2>
                  <p className="mt-1 text-xs text-foreground-muted">{data.summary.graph.entities.length} authorized books · reporting in {data.summary.reportingCurrency}</p>
                </div>
              </div>
              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-border text-[10px] uppercase tracking-wider text-foreground-muted">
                    <tr>
                      <th className="pb-2 font-semibold">Entity</th>
                      <th className="pb-2 font-semibold">Type</th>
                      <th className="pb-2 text-right font-semibold">Ownership</th>
                      <th className="pb-2 text-right font-semibold">Look-through net worth</th>
                      <th className="pb-2 text-right font-semibold">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.summary.entities.map(row => (
                      <tr key={row.entity.bookGuid} className="border-b border-border/60">
                        <td className="py-3">
                          <p className="font-medium text-foreground">{row.entity.entityName || row.entity.name}</p>
                          <p className="mt-0.5 font-mono text-[10px] text-foreground-muted">{row.entity.reportingCurrency} · {row.entity.role}</p>
                        </td>
                        <td className="py-3 capitalize text-foreground-secondary">{row.entity.entityType.replace(/_/g, ' ')}</td>
                        <td className="py-3 text-right font-mono text-foreground">{row.ownershipPercent.toFixed(1)}%</td>
                        <td className="py-3 text-right font-mono font-semibold text-foreground">
                          {row.ownedSummary ? money(row.ownedSummary.netWorth, data.summary.reportingCurrency) : 'Excluded'}
                        </td>
                        <td className="py-3 text-right font-mono text-foreground-secondary">{data.actionCounts[row.entity.bookGuid] ?? 0}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {data.summary.graph.relationships.length > 0 && (
                <div className="mt-4 grid gap-2 sm:grid-cols-2">
                  {data.summary.graph.relationships.map(rel => {
                    const from = data.summary.graph.entities.find(entity => entity.bookGuid === rel.fromBookGuid);
                    const to = data.summary.graph.entities.find(entity => entity.bookGuid === rel.toBookGuid);
                    return (
                      <div key={`${rel.fromBookGuid}:${rel.toBookGuid}`} className="rounded-lg border border-border bg-surface px-3 py-2">
                        <p className="text-xs text-foreground">
                          {from?.entityName || from?.name} <span className="text-primary">→ {rel.ownershipPercent}%</span> {to?.entityName || to?.name}
                        </p>
                        <p className="mt-0.5 text-[10px] uppercase tracking-wider text-foreground-muted">{rel.type.replace(/_/g, ' ')}</p>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="rounded-lg border border-border bg-surface/30 p-5">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold text-foreground">Shared timeline</h2>
                  <p className="mt-1 text-xs text-foreground-muted">{data.timeline.conflicts.length} graph-wide conflict{data.timeline.conflicts.length === 1 ? '' : 's'}</p>
                </div>
                <Link href="/money/timeline" className="text-xs font-semibold text-primary">Open timeline</Link>
              </div>
              <div className="mt-4 space-y-2">
                {nextEvents.map(event => {
                  const entity = data.summary.graph.entities.find(item => item.bookGuid === event.bookGuid);
                  return (
                    <div key={event.id} className="flex items-start justify-between gap-3 rounded-lg border border-border bg-surface p-3">
                      <div>
                        <p className="text-xs font-medium text-foreground">{event.title}</p>
                        <p className="mt-1 text-[10px] text-foreground-muted">{entity?.name} · {event.domain.replace(/_/g, ' ')}</p>
                      </div>
                      <div className="text-right">
                        <p className="font-mono text-[11px] text-foreground-secondary">{event.date}</p>
                        {event.cashImpact !== null && (
                          <p className={`mt-1 font-mono text-[11px] ${event.cashImpact >= 0 ? 'text-positive' : 'text-negative'}`}>
                            {money(event.cashImpact, event.currency)}
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })}
                {nextEvents.length === 0 && <p className="text-sm text-foreground-muted">No upcoming graph-wide events.</p>}
              </div>
            </div>
          </section>

          <section className="rounded-lg border border-border bg-surface/30 p-5">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-foreground">Inter-book transfer matching</h2>
                <p className="mt-1 text-xs text-foreground-muted">
                  Proposed eliminations are presentation-only until explicitly approved. Source books are never changed.
                </p>
              </div>
              <span className="font-mono text-xs text-foreground-muted">{pendingTransfers.length} pending · {data.transfers.length - pendingTransfers.length} approved</span>
            </div>
            <div className="mt-4 space-y-2">
              {data.transfers.map(candidate => (
                <div key={candidate.id} className="grid items-center gap-3 rounded-lg border border-border bg-surface p-3 md:grid-cols-[1fr_auto_1fr_auto]">
                  <div>
                    <p className="text-xs font-medium text-foreground">{candidate.leftBookName}</p>
                    <p className="mt-1 font-mono text-[10px] text-foreground-muted">{candidate.leftDate} · {candidate.leftDescription || candidate.leftTransactionGuid}</p>
                  </div>
                  <div className="text-center">
                    <p className="font-mono text-sm font-semibold text-primary">{money(candidate.amount, candidate.currency)}</p>
                    <p className="text-[10px] text-foreground-muted">{Math.round(candidate.confidence * 100)}% match</p>
                  </div>
                  <div>
                    <p className="text-xs font-medium text-foreground">{candidate.rightBookName}</p>
                    <p className="mt-1 font-mono text-[10px] text-foreground-muted">{candidate.rightDate} · {candidate.rightDescription || candidate.rightTransactionGuid}</p>
                  </div>
                  {candidate.approved ? (
                    <span className="rounded border border-positive/40 px-2 py-1 text-[10px] font-semibold uppercase text-positive">Approved</span>
                  ) : (
                    <button type="button" disabled={workingId === candidate.id} onClick={() => void approve(candidate)} className="rounded-lg border border-primary/50 px-3 py-2 text-xs font-semibold text-primary disabled:opacity-50">
                      {workingId === candidate.id ? 'Approving…' : 'Approve elimination'}
                    </button>
                  )}
                </div>
              ))}
              {data.transfers.length === 0 && (
                <p className="rounded-lg border border-border p-5 text-center text-sm text-foreground-muted">
                  No equal-and-opposite cross-book cash transfers were found within the matching window.
                </p>
              )}
            </div>
          </section>

          <section className="rounded-lg border border-border bg-surface/30 p-5">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-foreground">Global document search</h2>
                <p className="mt-1 text-xs text-foreground-muted">Entity vault documents and receipt OCR across the authorized graph.</p>
              </div>
              <input
                type="search"
                value={query}
                onChange={event => setQuery(event.target.value)}
                placeholder="Search filenames, notes, OCR…"
                className="w-full max-w-sm rounded-lg border border-border bg-background-tertiary px-3 py-2 text-sm text-foreground focus:border-primary/60 focus-visible:ring-2 focus-visible:ring-primary/60"
              />
            </div>
            <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {data.documents.map(document => (
                <Link key={document.id} href={document.href} className="rounded-lg border border-border bg-surface p-3 hover:border-primary/50">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm font-medium text-foreground">{document.title}</p>
                    <span className="rounded border border-border px-1.5 py-0.5 text-[9px] uppercase text-foreground-muted">{document.kind.replace('_', ' ')}</span>
                  </div>
                  <p className="mt-1 text-[10px] font-semibold uppercase tracking-wider text-primary">{document.bookName}</p>
                  {document.detail && <p className="mt-2 line-clamp-2 text-xs leading-5 text-foreground-muted">{document.detail}</p>}
                </Link>
              ))}
              {data.documents.length === 0 && <p className="text-sm text-foreground-muted">No authorized documents match this search.</p>}
            </div>
          </section>

          <section className="rounded-lg border border-border bg-surface/30 p-5">
            <h2 className="text-base font-semibold text-foreground">Scoped advisor access</h2>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-foreground-secondary">
              Family Office follows existing per-book roles. Grant an accountant read-only access only to the entities they should see; the graph, consolidated figures, documents, actions, and timeline automatically omit every unauthorized book.
            </p>
            <div className="mt-3 flex gap-2">
              <Link href="/settings" className="rounded-lg border border-primary/50 px-3 py-2 text-xs font-semibold text-primary">Manage book members</Link>
              <Link href="/reports" className="rounded-lg border border-border px-3 py-2 text-xs font-semibold text-foreground-secondary">Open consolidated report sources</Link>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

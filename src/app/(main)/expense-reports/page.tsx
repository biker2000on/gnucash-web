'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatCard, StatGrid } from '@/components/ui/StatCard';
import { useBooks } from '@/contexts/BookContext';
import { useToast } from '@/contexts/ToastContext';
import { formatCents, REPORT_STATUS_LABELS } from '@/lib/expense-reports/model';
import { api, STATUS_CLASS, type LinkOverview, type Overview, type ReportView } from '@/components/expense-reports/api';
import { SetupPanel } from '@/components/expense-reports/SetupPanel';
import { HouseholdView } from '@/components/expense-reports/HouseholdView';
import { ReportPanel } from '@/components/expense-reports/ReportPanel';

const OPEN = new Set(['submitted', 'posted', 'paid']);

/**
 * Owner expense reports. On a household book: report personal-card charges
 * to a linked business. On a business book: categorize, approve and pay the
 * reports its owners submit. The same page serves both sides of a link.
 */
export default function ExpenseReportsPage() {
  const params = useSearchParams();
  const { error: showError } = useToast();
  const { books, activeBookGuid } = useBooks();
  const role = books.find((b) => b.guid === activeBookGuid)?.role;
  const canEdit = role === 'edit' || role === 'admin';

  const [overview, setOverview] = useState<Overview | null>(null);
  const [linkKey, setLinkKey] = useState<string | null>(null);
  const [openReport, setOpenReport] = useState<number | null>(() => {
    const r = Number(params.get('report'));
    return Number.isInteger(r) && r > 0 ? r : null;
  });
  const [showClosed, setShowClosed] = useState(false);

  // Bumped by children after a write; the effect below refetches.
  const [reloadKey, setReloadKey] = useState(0);
  const load = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let cancelled = false;
    api<Overview>('/api/expense-reports')
      .then((data) => {
        if (!cancelled) setOverview(data);
      })
      .catch((e) => showError(e instanceof Error ? e.message : 'Failed to load expense reports'));
    return () => {
      cancelled = true;
    };
  }, [showError, activeBookGuid, reloadKey]);

  const keyOf = (l: LinkOverview) => `${l.businessBookGuid}:${l.householdBookGuid}`;
  const link = useMemo(() => {
    if (!overview || overview.links.length === 0) return null;
    const wanted = params.get('business');
    return (
      overview.links.find((l) => keyOf(l) === linkKey) ??
      overview.links.find((l) => l.businessBookGuid === wanted) ??
      overview.links[0]
    );
  }, [overview, linkKey, params]);

  const reports = useMemo(
    () =>
      (overview?.reports ?? []).filter(
        (r) => !link || (r.businessBookGuid === link.businessBookGuid && r.householdBookGuid === link.householdBookGuid),
      ),
    [overview, link],
  );
  const open = reports.filter((r) => OPEN.has(r.status));
  const closed = reports.filter((r) => !OPEN.has(r.status));
  const sumOf = (list: ReportView[]) => list.reduce((s, r) => s + r.totalCents, 0);

  if (overview && overview.links.length === 0) {
    return (
      <div className="space-y-4">
        <PageHeader title="Owner Expense Reports" subtitle="Business expenses paid personally, reimbursed by a linked business." />
        <div className="rounded-lg border border-border p-6 text-sm text-foreground-secondary">
          This book is not linked to a business or household book. Link a business book to its owner&apos;s household
          book in <Link href="/settings" className="text-primary hover:underline">Settings → Linked household books</Link>,
          then report personal-card business expenses here.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Owner Expense Reports"
        subtitle={
          link?.side === 'business'
            ? `Categorize, approve and reimburse expenses the owner paid personally.`
            : `Report business expenses you paid on personal cards to ${link?.businessName ?? 'your business'}.`
        }
      />

      {overview && overview.links.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {overview.links.map((l) => (
            <button
              key={keyOf(l)}
              type="button"
              onClick={() => setLinkKey(keyOf(l))}
              className={`rounded-md border px-3 py-1 text-sm ${
                link && keyOf(link) === keyOf(l) ? 'border-primary bg-primary-light text-primary' : 'border-border text-foreground-secondary'
              }`}
            >
              {l.side === 'household' ? l.businessName : l.householdName}
            </button>
          ))}
        </div>
      )}

      {!overview && <p className="text-sm text-foreground-muted">Loading…</p>}

      {link && (
        <>
          <StatGrid cols={3}>
            <StatCard label="Awaiting approval" value={formatCents(sumOf(open.filter((r) => r.status === 'submitted')))} />
            <StatCard label="Approved, unpaid" value={formatCents(sumOf(open.filter((r) => r.status === 'posted')))} tone="warning" />
            <StatCard label="Paid, not yet recorded" value={formatCents(sumOf(open.filter((r) => r.status === 'paid')))} />
          </StatGrid>

          <SetupPanel
            link={link}
            canEditActive={canEdit}
            onSaved={() => load()}
          />

          {link.side === 'household' && <HouseholdView link={link} canEdit={canEdit} onChanged={load} />}

          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-foreground">
                {link.side === 'business' ? `Reports from ${link.householdName}` : 'Your reports'}
              </h2>
              {closed.length > 0 && (
                <button type="button" className="text-sm text-foreground-secondary hover:text-foreground" onClick={() => setShowClosed(!showClosed)}>
                  {showClosed ? 'Hide' : 'Show'} {closed.length} closed
                </button>
              )}
            </div>
            {open.length === 0 && !showClosed && (
              <p className="text-sm text-foreground-muted">No open reports.</p>
            )}
            {[...open, ...(showClosed ? closed : [])].map((r) =>
              openReport === r.id ? (
                <div key={r.id} className="space-y-1">
                  <button type="button" className="text-xs text-foreground-secondary hover:text-foreground" onClick={() => setOpenReport(null)}>
                    ← Collapse
                  </button>
                  <ReportPanel report={r} link={link} canEdit={canEdit} onChanged={load} />
                </div>
              ) : (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => setOpenReport(r.id)}
                  className="flex w-full flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-surface px-4 py-3 text-left hover:bg-surface-hover"
                >
                  <span className="flex items-center gap-2">
                    <span className="font-medium text-foreground">{r.label}</span>
                    <span className={`rounded-sm border px-1.5 py-0.5 text-[11px] font-medium ${STATUS_CLASS[r.status]}`}>
                      {REPORT_STATUS_LABELS[r.status]}
                    </span>
                    <span className="text-xs text-foreground-muted">
                      {r.lines.length} line{r.lines.length === 1 ? '' : 's'}
                      {r.side === 'business' && r.status === 'submitted' && r.lines.some((l) => !l.expenseAccountGuid) &&
                        ` · ${r.lines.filter((l) => !l.expenseAccountGuid).length} uncategorized`}
                    </span>
                  </span>
                  <span className="font-mono text-foreground" style={{ fontFeatureSettings: "'tnum'" }}>{formatCents(r.totalCents)}</span>
                </button>
              ),
            )}
          </section>
        </>
      )}
    </div>
  );
}

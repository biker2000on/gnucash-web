'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { ReconciliationCoverage } from '@/lib/reconciliation-coverage';

function metric(value: string, label: string, tone = 'text-foreground') {
  return (
    <div className="border border-border bg-surface rounded-lg p-4">
      <p className={`font-mono text-2xl font-semibold ${tone}`}>{value}</p>
      <p className="mt-1 text-xs uppercase tracking-wider text-foreground-muted">{label}</p>
    </div>
  );
}

export function ContinuousCloseDashboard() {
  const [coverage, setCoverage] = useState<ReconciliationCoverage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/reconciliation/coverage')
      .then(async response => {
        if (!response.ok) throw new Error((await response.json().catch(() => null))?.error || 'Failed to load');
        return response.json() as Promise<ReconciliationCoverage>;
      })
      .then(setCoverage)
      .catch(reason => setError(reason instanceof Error ? reason.message : 'Failed to load'));
  }, []);

  if (error) {
    return <div className="rounded-lg border border-negative/40 bg-negative/10 p-4 text-sm text-negative">{error}</div>;
  }
  if (!coverage) {
    return <div className="rounded-lg border border-border bg-surface p-5 text-sm text-foreground-muted">Measuring close readiness…</div>;
  }

  const needsAttention = coverage.accounts.filter(account => account.status !== 'current');
  return (
    <section className="space-y-4" aria-labelledby="continuous-close-heading">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-primary">Continuous Close</p>
          <h2 id="continuous-close-heading" className="mt-1 text-xl font-semibold text-foreground">Book verification coverage</h2>
          <p className="mt-1 text-sm text-foreground-secondary">
            How current the cash and balance-sheet accounts are, plus friction observed during reconciliation.
          </p>
        </div>
        <Link href="/actions?origin=statement_reconciliation" className="text-sm font-medium text-primary hover:text-primary-hover">
          Open close actions
        </Link>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {metric(`${coverage.coveragePercent.toFixed(1)}%`, 'Split coverage', coverage.coveragePercent >= 95 ? 'text-positive' : 'text-warning')}
        {metric(coverage.verifiedThrough ?? 'Not complete', 'Verified through')}
        {metric(String(coverage.staleAccounts + coverage.neverReconciledAccounts), 'Accounts needing attention', needsAttention.length ? 'text-warning' : 'text-positive')}
        {metric(coverage.sessions.averageMinutes === null ? '—' : `${coverage.sessions.averageMinutes}m`, 'Average close time')}
        {metric(String(coverage.sessions.abandoned), 'Abandoned sessions', coverage.sessions.abandoned ? 'text-negative' : 'text-positive')}
      </div>

      <div className="overflow-x-auto rounded-lg border border-border bg-surface">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="border-b border-border bg-background-secondary/50 text-left text-xs uppercase tracking-wider text-foreground-muted">
            <tr>
              <th className="px-4 py-3">Account</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3 text-right">Coverage</th>
              <th className="px-4 py-3 text-right">Cleared</th>
              <th className="px-4 py-3 text-right">Outstanding</th>
              <th className="px-4 py-3">Verified through</th>
              <th className="px-4 py-3 text-right">Next step</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {coverage.accounts.map(account => (
              <tr key={account.accountGuid}>
                <td className="px-4 py-3">
                  <p className="font-medium text-foreground">{account.name}</p>
                  <p className="text-xs text-foreground-muted">{account.type}</p>
                </td>
                <td className="px-4 py-3">
                  <span className={`inline-flex rounded border px-2 py-1 text-xs font-medium uppercase tracking-wider ${
                    account.status === 'current'
                      ? 'border-positive/40 text-positive'
                      : account.status === 'stale'
                        ? 'border-warning/40 text-warning'
                        : 'border-negative/40 text-negative'
                  }`}>
                    {account.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-right font-mono">{account.coveragePercent.toFixed(1)}%</td>
                <td className="px-4 py-3 text-right font-mono">{account.clearedSplits}</td>
                <td className="px-4 py-3 text-right font-mono">{account.outstandingSplits}</td>
                <td className="px-4 py-3 font-mono text-foreground-secondary">
                  {account.verifiedThrough ?? 'Never'}
                  {account.staleDays !== null && <span className="ml-2 text-xs text-foreground-muted">({account.staleDays}d)</span>}
                </td>
                <td className="px-4 py-3 text-right">
                  <Link href={`/accounts/${account.accountGuid}/reconcile`} className="font-medium text-primary hover:text-primary-hover">
                    Reconcile
                  </Link>
                </td>
              </tr>
            ))}
            {coverage.accounts.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-foreground-muted">No reconcilable accounts found.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-foreground-muted">
        {coverage.sessions.completed} completed session{coverage.sessions.completed === 1 ? '' : 's'} · average {coverage.sessions.averageInteractions ?? '—'} interactions · {coverage.sessions.active} active
      </p>
    </section>
  );
}

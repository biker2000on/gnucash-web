'use client';

import { useEffect, useState, useMemo, useCallback } from 'react';
import Link from 'next/link';
import { formatCurrency } from '@/lib/format';
import { CreateScheduledPanel } from '@/components/scheduled-transactions/CreateScheduledPanel';

// ---------------------------------------------------------------------------
// Types matching API responses
// ---------------------------------------------------------------------------

interface ScheduledTransactionSplit {
  accountGuid: string;
  accountName: string;
  amount: number;
}

interface ScheduledTransaction {
  guid: string;
  name: string;
  enabled: boolean;
  startDate: string | null;
  endDate: string | null;
  lastOccur: string | null;
  remainingOccurrences: number;
  autoCreate: boolean;
  recurrence: {
    periodType: string;
    mult: number;
    periodStart: string;
    weekendAdjust: string;
  } | null;
  nextOccurrence: string | null;
  splits: ScheduledTransactionSplit[];
}

interface UpcomingOccurrence {
  date: string;
  scheduledTransactionGuid: string;
  scheduledTransactionName: string;
  splits: ScheduledTransactionSplit[];
}

interface MortgageConfig {
  id: number;
  account_guid: string | null;
  config: {
    interestAccountGuid?: string;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type SortKey = 'nextOccurrence' | 'name' | 'amount';
type SortDir = 'asc' | 'desc';

function formatFrequency(recurrence: ScheduledTransaction['recurrence']): string {
  if (!recurrence) return 'None';
  const { periodType, mult } = recurrence;

  const labels: Record<string, string> = {
    daily: 'day',
    weekly: 'week',
    month: 'month',
    'end of month': 'month (end)',
    semi_monthly: 'semi-monthly',
    year: 'year',
    once: 'one-time',
    'nth weekday': 'month',
    'last weekday': 'month',
  };

  if (periodType === 'once') return 'One-time';
  if (periodType === 'semi_monthly') return mult > 1 ? `Semi-monthly (x${mult})` : 'Semi-monthly';

  const label = labels[periodType] || periodType;
  if (mult === 1) {
    // "Monthly", "Weekly", etc.
    const capitalize = label.charAt(0).toUpperCase() + label.slice(1);
    return capitalize === 'Day' ? 'Daily' : capitalize === 'Week' ? 'Weekly' : capitalize === 'Month' ? 'Monthly' : capitalize === 'Year' ? 'Yearly' : capitalize === 'Month (end)' ? 'Monthly (end of month)' : capitalize;
  }
  return `Every ${mult} ${label}s`;
}

function getTotalAmount(splits: ScheduledTransactionSplit[]): number {
  // Sum positive amounts (debits) — represents the total transaction amount
  const positives = splits.filter(s => s.amount > 0);
  if (positives.length > 0) {
    return positives.reduce((sum, s) => sum + s.amount, 0);
  }
  // Fallback: absolute value of first split
  return splits.length > 0 ? Math.abs(splits[0].amount) : 0;
}

function formatDateDisplay(dateStr: string | null): string {
  if (!dateStr) return '--';
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ---------------------------------------------------------------------------
// Skeleton row component
// ---------------------------------------------------------------------------

function SkeletonRow() {
  return (
    <div className="px-4 py-4 sm:px-6 animate-pulse">
      <div className="flex items-center justify-between gap-4">
        <div className="flex-1 min-w-0 space-y-2">
          <div className="h-4 bg-surface-hover rounded w-48" />
          <div className="h-3 bg-surface-hover rounded w-32" />
        </div>
        <div className="h-4 bg-surface-hover rounded w-20" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page component
// ---------------------------------------------------------------------------

export default function ScheduledTransactionsPage() {
  // View mode: 'all' or 'upcoming'
  const [viewMode, setViewMode] = useState<'all' | 'upcoming'>('all');

  // Data
  const [transactions, setTransactions] = useState<ScheduledTransaction[]>([]);
  const [upcoming, setUpcoming] = useState<UpcomingOccurrence[]>([]);
  const [mortgageAccountGuids, setMortgageAccountGuids] = useState<Set<string>>(new Set());

  // UI state
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionStates, setActionStates] = useState<Record<string, 'loading' | 'executed' | 'skipped' | 'error'>>({});
  const [batchLoading, setBatchLoading] = useState(false);
  const [showCreatePanel, setShowCreatePanel] = useState(false);

  // Filters
  const [searchQuery, setSearchQuery] = useState('');
  const [enabledFilter, setEnabledFilter] = useState<'all' | 'enabled' | 'disabled'>('all');

  // Sort
  const [sortKey, setSortKey] = useState<SortKey>('nextOccurrence');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  // Fetch mortgage configs to detect mortgage-linked accounts
  useEffect(() => {
    async function fetchMortgageConfigs() {
      try {
        const res = await fetch('/api/tools/config?toolType=mortgage');
        if (!res.ok) return;
        const configs: MortgageConfig[] = await res.json();
        const guids = new Set<string>();
        for (const c of configs) {
          if (c.account_guid) guids.add(c.account_guid);
          if (c.config?.interestAccountGuid) guids.add(c.config.interestAccountGuid);
        }
        setMortgageAccountGuids(guids);
      } catch {
        // Non-critical — silently ignore
      }
    }
    fetchMortgageConfigs();
  }, []);

  // Fetch data based on view mode
  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (viewMode === 'all') {
        const res = await fetch('/api/scheduled-transactions');
        if (!res.ok) throw new Error('Failed to fetch');
        const data: ScheduledTransaction[] = await res.json();
        setTransactions(data);
      } else {
        const res = await fetch('/api/scheduled-transactions/upcoming?days=30');
        if (!res.ok) throw new Error('Failed to fetch');
        const data: UpcomingOccurrence[] = await res.json();
        setUpcoming(data);
      }
    } catch {
      setError("Couldn't load scheduled transactions.");
    } finally {
      setLoading(false);
    }
  }, [viewMode]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Check if any splits reference a mortgage-linked account
  const hasMortgageLink = useCallback(
    (splits: ScheduledTransactionSplit[]) =>
      splits.some(s => mortgageAccountGuids.has(s.accountGuid)),
    [mortgageAccountGuids]
  );

  // Filter & sort for "All" view
  const filteredTransactions = useMemo(() => {
    let items = [...transactions];

    // Enabled filter
    if (enabledFilter === 'enabled') items = items.filter(t => t.enabled);
    if (enabledFilter === 'disabled') items = items.filter(t => !t.enabled);

    // Search
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      items = items.filter(t => t.name.toLowerCase().includes(q));
    }

    // Sort
    items.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case 'name':
          cmp = a.name.localeCompare(b.name);
          break;
        case 'amount':
          cmp = getTotalAmount(a.splits) - getTotalAmount(b.splits);
          break;
        case 'nextOccurrence':
        default:
          // nulls last
          if (!a.nextOccurrence && !b.nextOccurrence) cmp = 0;
          else if (!a.nextOccurrence) cmp = 1;
          else if (!b.nextOccurrence) cmp = -1;
          else cmp = a.nextOccurrence.localeCompare(b.nextOccurrence);
          break;
      }
      return sortDir === 'desc' ? -cmp : cmp;
    });

    return items;
  }, [transactions, enabledFilter, searchQuery, sortKey, sortDir]);

  // Filter upcoming by search
  const filteredUpcoming = useMemo(() => {
    if (!searchQuery.trim()) return upcoming;
    const q = searchQuery.toLowerCase();
    return upcoming.filter(o => o.scheduledTransactionName.toLowerCase().includes(q));
  }, [upcoming, searchQuery]);

  // Toggle sort
  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(prev => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  const sortIndicator = (key: SortKey) => {
    if (sortKey !== key) return '';
    return sortDir === 'asc' ? ' \u2191' : ' \u2193';
  };

  // Handler: execute a single upcoming occurrence
  const handleExecute = async (guid: string, date: string) => {
    const key = `${guid}-${date}`;
    setActionStates(prev => ({ ...prev, [key]: 'loading' }));
    try {
      const res = await fetch(`/api/scheduled-transactions/${guid}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ occurrenceDate: date }),
      });
      if (!res.ok) throw new Error('Failed');
      setActionStates(prev => ({ ...prev, [key]: 'executed' }));
    } catch {
      setActionStates(prev => ({ ...prev, [key]: 'error' }));
    }
  };

  // Handler: skip a single upcoming occurrence
  const handleSkip = async (guid: string, date: string) => {
    const key = `${guid}-${date}`;
    setActionStates(prev => ({ ...prev, [key]: 'loading' }));
    try {
      const res = await fetch(`/api/scheduled-transactions/${guid}/skip`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ occurrenceDate: date }),
      });
      if (!res.ok) throw new Error('Failed');
      setActionStates(prev => ({ ...prev, [key]: 'skipped' }));
    } catch {
      setActionStates(prev => ({ ...prev, [key]: 'error' }));
    }
  };

  // Handler: batch execute all overdue occurrences
  const handleBatchExecute = async () => {
    const today = new Date().toISOString().split('T')[0];
    const overdue = filteredUpcoming.filter(o => o.date < today);
    if (overdue.length === 0) return;

    setBatchLoading(true);
    // Mark all as loading
    const loadingStates: Record<string, 'loading'> = {};
    for (const o of overdue) {
      loadingStates[`${o.scheduledTransactionGuid}-${o.date}`] = 'loading';
    }
    setActionStates(prev => ({ ...prev, ...loadingStates }));

    try {
      const items = overdue.map(o => ({
        guid: o.scheduledTransactionGuid,
        occurrenceDate: o.date,
        action: 'execute' as const,
      }));
      const res = await fetch('/api/scheduled-transactions/batch-execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
      });
      if (!res.ok) throw new Error('Failed');
      const data = await res.json();
      const resultStates: Record<string, 'executed' | 'error'> = {};
      if (data.results) {
        for (const r of data.results) {
          const key = `${r.guid}-${r.occurrenceDate}`;
          resultStates[key] = r.success ? 'executed' : 'error';
        }
      } else {
        for (const o of overdue) {
          resultStates[`${o.scheduledTransactionGuid}-${o.date}`] = 'executed';
        }
      }
      setActionStates(prev => ({ ...prev, ...resultStates }));
      // Refetch data
      await fetchData();
    } catch {
      const errorStates: Record<string, 'error'> = {};
      for (const o of overdue) {
        errorStates[`${o.scheduledTransactionGuid}-${o.date}`] = 'error';
      }
      setActionStates(prev => ({ ...prev, ...errorStates }));
    } finally {
      setBatchLoading(false);
    }
  };

  // Compute overdue occurrences for banner
  const overdueOccurrences = useMemo(() => {
    const today = new Date().toISOString().split('T')[0];
    return filteredUpcoming.filter(o => o.date < today);
  }, [filteredUpcoming]);

  // ---------------------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------------------

  function renderAccountChips(splits: ScheduledTransactionSplit[]) {
    if (splits.length < 2) return null;
    // Show "from -> to" using first positive and first negative
    const from = splits.find(s => s.amount < 0);
    const to = splits.find(s => s.amount > 0);
    if (!from || !to) return null;

    return (
      <span className="text-xs text-foreground-muted">
        {from.accountName} &rarr; {to.accountName}
      </span>
    );
  }

  function renderTransactionRow(tx: ScheduledTransaction) {
    const amount = getTotalAmount(tx.splits);
    const isMortgage = hasMortgageLink(tx.splits);

    return (
      <div
        key={tx.guid}
        className="px-4 py-4 sm:px-6 border-b border-border last:border-b-0 hover:bg-surface-hover/50 transition-colors"
      >
        {/* Mobile: compact layout */}
        <div className="flex items-start justify-between gap-3 sm:hidden">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-foreground truncate">{tx.name}</span>
              <button
                onClick={async () => {
                  const newEnabled = !tx.enabled;
                  setTransactions(prev => prev.map(t =>
                    t.guid === tx.guid ? { ...t, enabled: newEnabled } : t
                  ));
                  try {
                    const res = await fetch(`/api/scheduled-transactions/${tx.guid}/enable`, {
                      method: 'PATCH',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ enabled: newEnabled }),
                    });
                    if (!res.ok) {
                      setTransactions(prev => prev.map(t =>
                        t.guid === tx.guid ? { ...t, enabled: !newEnabled } : t
                      ));
                    }
                  } catch {
                    setTransactions(prev => prev.map(t =>
                      t.guid === tx.guid ? { ...t, enabled: !newEnabled } : t
                    ));
                  }
                }}
                className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                  tx.enabled ? 'bg-emerald-500' : 'bg-gray-600'
                }`}
                role="switch"
                aria-checked={tx.enabled}
                aria-label={`${tx.enabled ? 'Disable' : 'Enable'} ${tx.name}`}
              >
                <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                  tx.enabled ? 'translate-x-4' : 'translate-x-1'
                }`} />
              </button>
            </div>
            <div className="text-xs text-foreground-muted mt-0.5">
              {formatFrequency(tx.recurrence)} &middot; {formatDateDisplay(tx.nextOccurrence)}
            </div>
            {renderAccountChips(tx.splits)}
          </div>
          <span className="font-mono text-sm font-medium text-foreground whitespace-nowrap">
            {formatCurrency(amount)}
          </span>
        </div>

        {/* Desktop: full layout */}
        <div className="hidden sm:flex sm:items-center sm:gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-foreground">{tx.name}</span>
              <button
                onClick={async () => {
                  const newEnabled = !tx.enabled;
                  setTransactions(prev => prev.map(t =>
                    t.guid === tx.guid ? { ...t, enabled: newEnabled } : t
                  ));
                  try {
                    const res = await fetch(`/api/scheduled-transactions/${tx.guid}/enable`, {
                      method: 'PATCH',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ enabled: newEnabled }),
                    });
                    if (!res.ok) {
                      setTransactions(prev => prev.map(t =>
                        t.guid === tx.guid ? { ...t, enabled: !newEnabled } : t
                      ));
                    }
                  } catch {
                    setTransactions(prev => prev.map(t =>
                      t.guid === tx.guid ? { ...t, enabled: !newEnabled } : t
                    ));
                  }
                }}
                className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                  tx.enabled ? 'bg-emerald-500' : 'bg-gray-600'
                }`}
                role="switch"
                aria-checked={tx.enabled}
                aria-label={`${tx.enabled ? 'Disable' : 'Enable'} ${tx.name}`}
              >
                <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                  tx.enabled ? 'translate-x-4' : 'translate-x-1'
                }`} />
              </button>
            </div>
            <div className="flex items-center gap-3 mt-1 text-xs text-foreground-muted">
              <span>{formatFrequency(tx.recurrence)}</span>
              <span>&middot;</span>
              <span>Next: {formatDateDisplay(tx.nextOccurrence)}</span>
              {tx.splits.length >= 2 && (
                <>
                  <span>&middot;</span>
                  {renderAccountChips(tx.splits)}
                </>
              )}
            </div>
          </div>
          <div className="flex items-center gap-3">
            {isMortgage && (
              <Link
                href="/tools/mortgage"
                className="text-xs text-cyan-400 hover:text-cyan-300 transition-colors whitespace-nowrap"
              >
                View in Mortgage Calculator
              </Link>
            )}
            <span className="font-mono text-sm font-medium text-foreground whitespace-nowrap min-w-[80px] text-right">
              {formatCurrency(amount)}
            </span>
          </div>
        </div>
        {/* Mortgage link on mobile */}
        {isMortgage && (
          <div className="sm:hidden mt-1">
            <Link
              href="/tools/mortgage"
              className="text-xs text-cyan-400 hover:text-cyan-300 transition-colors"
            >
              View in Mortgage Calculator
            </Link>
          </div>
        )}
      </div>
    );
  }

  function renderUpcomingRow(occ: UpcomingOccurrence) {
    const amount = getTotalAmount(occ.splits);
    const isMortgage = hasMortgageLink(occ.splits);
    const actionKey = `${occ.scheduledTransactionGuid}-${occ.date}`;
    const actionState = actionStates[actionKey];

    return (
      <div
        key={actionKey}
        className="px-4 py-4 sm:px-6 border-b border-border last:border-b-0 hover:bg-surface-hover/50 transition-colors"
      >
        {/* Mobile */}
        <div className="flex items-start justify-between gap-3 sm:hidden">
          <div className="flex-1 min-w-0">
            <span className="font-semibold text-foreground truncate block">{occ.scheduledTransactionName}</span>
            <span className="text-xs text-foreground-muted">{formatDateDisplay(occ.date)}</span>
            {occ.splits.length >= 2 && (
              <div className="mt-0.5">{renderAccountChips(occ.splits)}</div>
            )}
          </div>
          <span className="font-mono text-sm font-medium text-foreground whitespace-nowrap">
            {formatCurrency(amount)}
          </span>
        </div>
        {/* Mobile action buttons */}
        <div className="sm:hidden mt-2 flex gap-2">
          {actionState === 'executed' ? (
            <span className="text-xs text-emerald-400 font-medium">Executed ✓</span>
          ) : actionState === 'skipped' ? (
            <span className="text-xs text-foreground-muted font-medium">Skipped</span>
          ) : (
            <>
              <button
                onClick={() => handleExecute(occ.scheduledTransactionGuid, occ.date)}
                disabled={actionState === 'loading'}
                className="px-3 py-1 text-xs font-medium rounded-md bg-emerald-600 hover:bg-emerald-500 text-white transition-colors disabled:opacity-50"
              >
                {actionState === 'loading' ? '...' : 'Execute'}
              </button>
              <button
                onClick={() => handleSkip(occ.scheduledTransactionGuid, occ.date)}
                disabled={actionState === 'loading'}
                className="px-3 py-1 text-xs font-medium rounded-md bg-gray-600/50 hover:bg-gray-500/50 text-foreground-muted transition-colors disabled:opacity-50"
              >
                {actionState === 'loading' ? '...' : 'Skip'}
              </button>
            </>
          )}
        </div>
        {/* Desktop */}
        <div className="hidden sm:flex sm:items-center sm:gap-4">
          <div className="w-28 text-sm text-foreground-secondary">{formatDateDisplay(occ.date)}</div>
          <div className="flex-1 min-w-0">
            <span className="font-semibold text-foreground">{occ.scheduledTransactionName}</span>
            {occ.splits.length >= 2 && (
              <div className="mt-0.5">{renderAccountChips(occ.splits)}</div>
            )}
          </div>
          <div className="flex items-center gap-3">
            {isMortgage && (
              <Link
                href="/tools/mortgage"
                className="text-xs text-cyan-400 hover:text-cyan-300 transition-colors whitespace-nowrap"
              >
                View in Mortgage Calculator
              </Link>
            )}
            <span className="font-mono text-sm font-medium text-foreground whitespace-nowrap min-w-[80px] text-right">
              {formatCurrency(amount)}
            </span>
            {actionState === 'executed' ? (
              <span className="text-xs text-emerald-400 font-medium whitespace-nowrap">Executed ✓</span>
            ) : actionState === 'skipped' ? (
              <span className="text-xs text-foreground-muted font-medium whitespace-nowrap">Skipped</span>
            ) : (
              <>
                <button
                  onClick={() => handleExecute(occ.scheduledTransactionGuid, occ.date)}
                  disabled={actionState === 'loading'}
                  className="px-3 py-1.5 text-xs font-medium rounded-md bg-emerald-600 hover:bg-emerald-500 text-white transition-colors disabled:opacity-50 whitespace-nowrap"
                >
                  {actionState === 'loading' ? '...' : 'Execute'}
                </button>
                <button
                  onClick={() => handleSkip(occ.scheduledTransactionGuid, occ.date)}
                  disabled={actionState === 'loading'}
                  className="px-3 py-1.5 text-xs font-medium rounded-md bg-gray-600/50 hover:bg-gray-500/50 text-foreground-muted transition-colors disabled:opacity-50 whitespace-nowrap"
                >
                  {actionState === 'loading' ? '...' : 'Skip'}
                </button>
              </>
            )}
          </div>
        </div>
        {isMortgage && (
          <div className="sm:hidden mt-1">
            <Link
              href="/tools/mortgage"
              className="text-xs text-cyan-400 hover:text-cyan-300 transition-colors"
            >
              View in Mortgage Calculator
            </Link>
          </div>
        )}
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Page render
  // ---------------------------------------------------------------------------

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Scheduled Transactions</h1>
          <p className="text-foreground-muted">
            Manage recurring and one-time scheduled transactions.
          </p>
        </div>
        <button
          onClick={() => setShowCreatePanel(true)}
          className="px-4 py-2 text-sm font-medium rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white transition-colors flex items-center gap-2"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          New
        </button>
      </header>

      {/* Tab toggle */}
      <div className="flex items-center gap-1 p-1 bg-surface/50 backdrop-blur-xl rounded-xl border border-border w-fit">
        <button
          onClick={() => setViewMode('all')}
          className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
            viewMode === 'all'
              ? 'bg-surface-elevated text-foreground shadow-sm'
              : 'text-foreground-muted hover:text-foreground'
          }`}
        >
          All
        </button>
        <button
          onClick={() => setViewMode('upcoming')}
          className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
            viewMode === 'upcoming'
              ? 'bg-surface-elevated text-foreground shadow-sm'
              : 'text-foreground-muted hover:text-foreground'
          }`}
        >
          Upcoming 30 days
        </button>
      </div>

      {/* Filter controls */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        {/* Search */}
        <div className="relative flex-1 max-w-sm">
          <input
            type="text"
            placeholder="Search by name..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="w-full pl-9 pr-3 py-2 bg-input-bg border border-border rounded-lg text-sm text-foreground placeholder:text-foreground-muted focus:outline-none focus:ring-2 focus:ring-cyan-500/40 focus:border-cyan-500/40 transition-colors"
          />
          <svg
            className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-foreground-muted pointer-events-none"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            viewBox="0 0 24 24"
          >
            <circle cx="11" cy="11" r="8" />
            <path strokeLinecap="round" d="M21 21l-4.35-4.35" />
          </svg>
        </div>

        {/* Enabled/disabled filter (only in All view) */}
        {viewMode === 'all' && (
          <select
            value={enabledFilter}
            onChange={e => setEnabledFilter(e.target.value as typeof enabledFilter)}
            className="px-3 py-2 bg-input-bg border border-border rounded-lg text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-cyan-500/40 focus:border-cyan-500/40 transition-colors"
          >
            <option value="all">All statuses</option>
            <option value="enabled">Enabled only</option>
            <option value="disabled">Disabled only</option>
          </select>
        )}

        {/* Sort controls (only in All view) */}
        {viewMode === 'all' && (
          <div className="flex items-center gap-1">
            <span className="text-xs text-foreground-muted mr-1">Sort:</span>
            {(['nextOccurrence', 'name', 'amount'] as SortKey[]).map(key => (
              <button
                key={key}
                onClick={() => handleSort(key)}
                className={`px-2.5 py-1.5 text-xs rounded-md transition-colors ${
                  sortKey === key
                    ? 'bg-surface-elevated text-foreground font-medium'
                    : 'text-foreground-muted hover:text-foreground hover:bg-surface-hover'
                }`}
              >
                {key === 'nextOccurrence' ? 'Next date' : key === 'name' ? 'Name' : 'Amount'}
                {sortIndicator(key)}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Content */}
      <div className="bg-surface/30 backdrop-blur-xl border border-border rounded-2xl shadow-2xl overflow-hidden">
        {loading ? (
          <div className="divide-y divide-border">
            <SkeletonRow />
            <SkeletonRow />
            <SkeletonRow />
            <SkeletonRow />
            <SkeletonRow />
          </div>
        ) : error ? (
          <div className="p-12 flex flex-col items-center justify-center gap-3">
            <p className="text-rose-400">{error}</p>
            <button
              onClick={fetchData}
              className="px-4 py-2 text-sm font-medium bg-surface-elevated hover:bg-surface-hover text-foreground rounded-lg transition-colors border border-border"
            >
              Retry
            </button>
          </div>
        ) : viewMode === 'all' ? (
          filteredTransactions.length === 0 ? (
            <div className="p-12 text-center text-foreground-muted">
              {transactions.length === 0
                ? 'No scheduled transactions found. These are created in GnuCash desktop.'
                : 'No scheduled transactions match your filters.'}
            </div>
          ) : (
            <div>{filteredTransactions.map(renderTransactionRow)}</div>
          )
        ) : filteredUpcoming.length === 0 ? (
          <div className="p-12 text-center text-foreground-muted">
            {upcoming.length === 0
              ? 'No upcoming transactions in the next 30 days.'
              : 'No upcoming transactions match your search.'}
          </div>
        ) : (
          <div>
            {overdueOccurrences.length > 0 && (
              <div className="px-4 py-3 sm:px-6 bg-amber-500/10 border-b border-amber-500/30 flex items-center justify-between gap-3">
                <span className="text-sm text-amber-400 font-medium">
                  {overdueOccurrences.length} overdue transaction{overdueOccurrences.length !== 1 ? 's' : ''}
                </span>
                <button
                  onClick={handleBatchExecute}
                  disabled={batchLoading}
                  className="px-3 py-1.5 text-xs font-medium rounded-md bg-amber-500/20 hover:bg-amber-500/30 text-amber-400 border border-amber-500/30 transition-colors disabled:opacity-50"
                >
                  {batchLoading ? 'Processing...' : 'Process All'}
                </button>
              </div>
            )}
            {filteredUpcoming.map(renderUpcomingRow)}
          </div>
        )}
      </div>

      {showCreatePanel && (
        <CreateScheduledPanel
          onClose={() => setShowCreatePanel(false)}
          onCreated={() => {
            setShowCreatePanel(false);
            fetchData();
          }}
        />
      )}
    </div>
  );
}

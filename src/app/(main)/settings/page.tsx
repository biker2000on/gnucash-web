'use client';

import { useState, useEffect, useCallback } from 'react';
import { useToast } from '@/contexts/ToastContext';
import { useUserPreferences } from '@/contexts/UserPreferencesContext';
import type { DateFormat } from '@/lib/date-format';
import { BalanceReversal } from '@/lib/format';

interface ScheduleSettings {
  enabled: boolean;
  intervalHours: number;
  refreshTime: string; // HH:MM in UTC
}

interface IndexCoverage {
  earliestTransaction: string | null;
  indices: { symbol: string; name: string; count: number; earliest: string | null; latest: string | null }[];
  isUpToDate: boolean;
}

const INTERVAL_OPTIONS = [
  { value: 24, label: 'Daily' },
  { value: 12, label: 'Every 12 Hours' },
  { value: 6, label: 'Every 6 Hours' },
];

const BALANCE_REVERSAL_OPTIONS: { value: BalanceReversal; label: string; description: string }[] = [
  {
    value: 'none',
    label: 'None (Raw Values)',
    description: 'Show raw GnuCash accounting values. Income and liabilities appear negative.',
  },
  {
    value: 'credit',
    label: 'Credit Accounts',
    description: 'Reverse credit-balance accounts (Income, Liability, Equity). Income and liabilities appear positive.',
  },
  {
    value: 'income_expense',
    label: 'Income & Expense',
    description: 'Reverse both Income and Expense accounts. Both appear as positive values.',
  },
];

export default function SettingsPage() {
  const { success, error: showError } = useToast();
  const { defaultTaxRate, setDefaultTaxRate, dateFormat, setDateFormat, defaultLedgerMode, setDefaultLedgerMode, balanceReversal, setBalanceReversal } = useUserPreferences();

  const [schedule, setSchedule] = useState<ScheduleSettings>({ enabled: false, intervalHours: 24, refreshTime: '21:00' });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [backfilling, setBackfilling] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [indexCoverage, setIndexCoverage] = useState<IndexCoverage | null>(null);
  const [taxRateInput, setTaxRateInput] = useState('');
  const [simplefinSyncEnabled, setSimplefinSyncEnabled] = useState(false);
  const [simplefinConnected, setSimplefinConnected] = useState(false);
  const [savingBalance, setSavingBalance] = useState(false);

  // Sync tax rate input from context (mount only)
  useEffect(() => {
    if (defaultTaxRate > 0) {
      setTaxRateInput((defaultTaxRate * 100).toString());
    } else {
      setTaxRateInput('');
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Load schedule settings
  useEffect(() => {
    async function loadSchedule() {
      try {
        const res = await fetch('/api/settings/schedules');
        if (res.ok) {
          const data = await res.json();
          setSchedule(data);
        }
      } catch (err) {
        console.error('Failed to load schedule settings:', err);
      } finally {
        setLoading(false);
      }
    }
    loadSchedule();
  }, []);

  // Check SimpleFin connection status (for sync toggle visibility)
  const fetchSimplefinStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/simplefin/status');
      if (res.ok) {
        const data = await res.json();
        setSimplefinConnected(data.connected);
        setSimplefinSyncEnabled(data.syncEnabled ?? false);
      }
    } catch {
      // Silently fail
    }
  }, []);

  useEffect(() => {
    fetchSimplefinStatus();
  }, [fetchSimplefinStatus]);

  // Load index coverage
  useEffect(() => {
    async function loadCoverage() {
      try {
        const res = await fetch('/api/investments/index-coverage');
        if (res.ok) {
          setIndexCoverage(await res.json());
        }
      } catch (err) {
        console.error('Failed to load index coverage:', err);
      }
    }
    loadCoverage();
  }, []);

  const handleBalanceReversalChange = async (value: BalanceReversal) => {
    setSavingBalance(true);
    try {
      await setBalanceReversal(value);
      success('Balance display preference saved');
    } catch {
      showError('Failed to save balance display preference');
    } finally {
      setSavingBalance(false);
    }
  };

  const handleScheduleToggle = async (enabled: boolean) => {
    try {
      const res = await fetch('/api/settings/schedules', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });

      if (!res.ok) throw new Error('Failed to update schedule');

      setSchedule((prev) => ({ ...prev, enabled }));
      success(`Automatic refresh ${enabled ? 'enabled' : 'disabled'}`);
    } catch {
      showError('Failed to update schedule setting');
    }
  };

  const updateSimplefinSync = async (enabled: boolean) => {
    try {
      await fetch('/api/user/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preferences: { simplefin_sync_with_refresh: enabled ? 'true' : 'false' } }),
      });
      setSimplefinSyncEnabled(enabled);
      success(`SimpleFin sync ${enabled ? 'enabled' : 'disabled'} with price refresh`);
    } catch {
      showError('Failed to update SimpleFin sync setting');
    }
  };

  const handleIntervalChange = async (intervalHours: number) => {
    try {
      const res = await fetch('/api/settings/schedules', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intervalHours }),
      });

      if (!res.ok) throw new Error('Failed to update interval');

      setSchedule((prev) => ({ ...prev, intervalHours }));
      success(`Refresh interval set to ${INTERVAL_OPTIONS.find((o) => o.value === intervalHours)?.label}`);
    } catch {
      showError('Failed to update refresh interval');
    }
  };

  // Convert UTC HH:MM to local HH:MM for the time input
  const utcToLocal = (utcTime: string): string => {
    const [h, m] = utcTime.split(':').map(Number);
    const d = new Date();
    d.setUTCHours(h, m, 0, 0);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  // Convert local HH:MM to UTC HH:MM for storage
  const localToUtc = (localTime: string): string => {
    const [h, m] = localTime.split(':').map(Number);
    const d = new Date();
    d.setHours(h, m, 0, 0);
    return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  };

  const handleTimeChange = async (localTime: string) => {
    const utcTime = localToUtc(localTime);
    try {
      const res = await fetch('/api/settings/schedules', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshTime: utcTime }),
      });

      if (!res.ok) throw new Error('Failed to update refresh time');

      setSchedule((prev) => ({ ...prev, refreshTime: utcTime }));
      success(`Refresh time set to ${localTime} (${utcTime} UTC)`);
    } catch {
      showError('Failed to update refresh time');
    }
  };

  const handleRefreshNow = async () => {
    setRefreshing(true);
    try {
      const res = await fetch('/api/settings/schedules/run-now', {
        method: 'POST',
      });

      if (!res.ok) throw new Error('Failed to trigger refresh');

      const data = await res.json();
      if (data.direct) {
        success(`${data.message} (${data.backfilled} new, ${data.gapsFilled} gaps filled)`);
      } else {
        success(data.message);
      }
    } catch {
      showError('Failed to start price refresh');
    } finally {
      setRefreshing(false);
    }
  };

  const handleBackfillIndices = async () => {
    setBackfilling(true);
    try {
      const res = await fetch('/api/investments/backfill-indices', {
        method: 'POST',
      });

      if (!res.ok) throw new Error('Failed to backfill indices');

      const data = await res.json();
      const resultSummary = data.results
        .map((r: { symbol: string; stored: number }) => `${r.symbol}: ${r.stored}`)
        .join(', ');
      success(`Backfilled ${data.totalStored} index prices (${resultSummary})`);

      // Refresh coverage info
      const coverageRes = await fetch('/api/investments/index-coverage');
      if (coverageRes.ok) {
        setIndexCoverage(await coverageRes.json());
      }
    } catch {
      showError('Failed to backfill index data');
    } finally {
      setBackfilling(false);
    }
  };

  const handleClearCache = async () => {
    setClearing(true);
    try {
      const res = await fetch('/api/settings/cache/clear', {
        method: 'POST',
      });

      if (!res.ok) throw new Error('Failed to clear cache');

      const data = await res.json();
      success(data.message);
    } catch {
      showError('Failed to clear cache');
    } finally {
      setClearing(false);
    }
  };

  if (loading) {
    return (
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center gap-3">
          <div className="w-5 h-5 border-2 border-emerald-500/30 border-t-emerald-500 rounded-full animate-spin" />
          <span className="text-foreground-secondary">Loading settings...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold text-foreground">Settings</h1>

      {/* Price Refresh Schedule */}
      <div className="bg-surface rounded-xl border border-border p-6">
        <h2 className="text-lg font-semibold text-foreground mb-4">Price Refresh Schedule</h2>

        <div className="space-y-4">
          {/* Enable/Disable Toggle */}
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={schedule.enabled}
              onChange={(e) => handleScheduleToggle(e.target.checked)}
              className="w-4 h-4 text-emerald-500 bg-background-tertiary border-border-hover rounded focus:ring-emerald-500/50"
            />
            <span className="text-sm text-foreground">Enable automatic price refresh</span>
          </label>

          {/* SimpleFin Sync Toggle - only show if connected */}
          {simplefinConnected && (
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={simplefinSyncEnabled}
                onChange={(e) => updateSimplefinSync(e.target.checked)}
                className="w-4 h-4 text-emerald-500 bg-background-tertiary border-border-hover rounded focus:ring-emerald-500/50"
              />
              <span className="text-sm text-foreground">Sync SimpleFin transactions with each refresh</span>
            </label>
          )}

          {/* Refresh Frequency */}
          <div className="space-y-2">
            <label className="block text-sm text-foreground-secondary">Refresh Frequency</label>
            <select
              value={schedule.intervalHours}
              onChange={(e) => handleIntervalChange(Number(e.target.value))}
              disabled={!schedule.enabled}
              className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-cyan-500/50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {INTERVAL_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          {/* Refresh Time */}
          <div className="space-y-2">
            <label className="block text-sm text-foreground-secondary">
              Refresh Time
            </label>
            <input
              type="time"
              value={utcToLocal(schedule.refreshTime)}
              onChange={(e) => handleTimeChange(e.target.value)}
              disabled={!schedule.enabled}
              className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-cyan-500/50 disabled:opacity-50 disabled:cursor-not-allowed"
            />
            <p className="text-xs text-foreground-muted">
              Schedule after US market close (4 PM ET) for complete daily prices.
            </p>
          </div>

          {/* Refresh Now Button */}
          <button
            onClick={handleRefreshNow}
            disabled={refreshing}
            className="w-full bg-emerald-600 hover:bg-emerald-700 disabled:bg-emerald-600/50 text-white font-medium px-4 py-2 rounded-lg transition-colors disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {refreshing && (
              <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            )}
            <span>{refreshing ? 'Refreshing...' : 'Refresh Now'}</span>
          </button>
        </div>
      </div>

      {/* Index Data */}
      <div className="bg-surface rounded-xl border border-border p-6">
        <h2 className="text-lg font-semibold text-foreground mb-4">Index Data</h2>

        <div className="space-y-4">
          <p className="text-sm text-foreground-muted">
            Historical price data for market indices (S&P 500, DJIA) used in performance charts.
          </p>

          {indexCoverage && (
            <div className="space-y-2">
              {indexCoverage.indices.map((idx) => (
                <div key={idx.symbol} className="flex items-center justify-between text-sm py-1.5 px-3 bg-background-tertiary rounded-lg">
                  <span className="font-medium text-foreground">{idx.name}</span>
                  <span className="text-foreground-secondary">
                    {idx.count > 0
                      ? `${idx.earliest} — ${idx.latest} (${Number(idx.count).toLocaleString()} prices)`
                      : 'No data'}
                  </span>
                </div>
              ))}
            </div>
          )}

          {indexCoverage?.isUpToDate && (
            <p className="text-sm text-emerald-500 flex items-center gap-1.5">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              Index data is up to date
            </p>
          )}

          <button
            onClick={handleBackfillIndices}
            disabled={backfilling || (indexCoverage?.isUpToDate ?? false)}
            className="w-full bg-cyan-600 hover:bg-cyan-700 disabled:bg-cyan-600/50 text-white font-medium px-4 py-2 rounded-lg transition-colors disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {backfilling && (
              <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            )}
            <span>{backfilling ? 'Backfilling...' : 'Backfill Historical Index Data'}</span>
          </button>
        </div>
      </div>

      {/* Cache Management */}
      <div className="bg-surface rounded-xl border border-border p-6">
        <h2 className="text-lg font-semibold text-foreground mb-4">Cache Management</h2>

        <div className="space-y-4">
          <p className="text-sm text-foreground-muted">
            Clears all cached dashboard calculations. Data will be recalculated on next visit.
          </p>

          <button
            onClick={handleClearCache}
            disabled={clearing}
            className="w-full bg-rose-600 hover:bg-rose-700 disabled:bg-rose-600/50 text-white font-medium px-4 py-2 rounded-lg transition-colors disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {clearing && (
              <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            )}
            <span>{clearing ? 'Clearing...' : 'Clear All Caches'}</span>
          </button>
        </div>
      </div>

      {/* Tax Rate */}
      <div className="bg-surface rounded-xl border border-border p-6">
        <h2 className="text-lg font-semibold text-foreground mb-4">Tax Rate</h2>

        <div className="space-y-4">
          <p className="text-sm text-foreground-muted">
            Set a default tax rate to quickly apply to transaction amounts using the T keyboard shortcut.
          </p>

          <div className="space-y-2">
            <label className="block text-sm text-foreground-secondary">Default Tax Rate</label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                step="0.01"
                min="0"
                max="100"
                value={taxRateInput}
                onChange={(e) => setTaxRateInput(e.target.value)}
                onBlur={() => {
                  const pct = parseFloat(taxRateInput);
                  if (!isNaN(pct) && pct >= 0 && pct <= 100) {
                    setDefaultTaxRate(pct / 100);
                  } else if (taxRateInput === '') {
                    setDefaultTaxRate(0);
                  }
                }}
                placeholder="0.00"
                className="w-32 bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-cyan-500/50"
              />
              <span className="text-sm text-foreground-muted">%</span>
            </div>
            <p className="text-xs text-foreground-muted">
              Press{' '}
              <kbd className="px-1.5 py-0.5 bg-background-tertiary rounded border border-border-hover text-xs">
                T
              </kbd>{' '}
              in amount fields to apply this tax rate to the current value.
            </p>
          </div>
        </div>
      </div>

      {/* Balance Display */}
      <div className="bg-surface rounded-xl border border-border p-6">
        <h2 className="text-lg font-semibold text-foreground mb-2">Balance Display</h2>
        <p className="text-sm text-foreground-muted mb-4">
          Choose how account balances are displayed throughout the app.
        </p>

        <div className="space-y-3">
          {BALANCE_REVERSAL_OPTIONS.map((option) => (
            <label
              key={option.value}
              className={`block p-4 rounded-xl border cursor-pointer transition-all ${
                balanceReversal === option.value
                  ? 'bg-emerald-500/10 border-emerald-500/50'
                  : 'bg-surface border-border hover:border-border-hover'
              }`}
            >
              <div className="flex items-start gap-3">
                <input
                  type="radio"
                  name="balanceReversal"
                  value={option.value}
                  checked={balanceReversal === option.value}
                  onChange={() => handleBalanceReversalChange(option.value)}
                  disabled={savingBalance}
                  className="mt-1 w-4 h-4 text-emerald-500 bg-background-tertiary border-border-hover focus:ring-emerald-500/50"
                />
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-foreground">{option.label}</span>
                    {savingBalance && balanceReversal === option.value && (
                      <div className="w-3 h-3 border-2 border-emerald-500/30 border-t-emerald-500 rounded-full animate-spin" />
                    )}
                  </div>
                  <p className="text-sm text-foreground-muted mt-1">{option.description}</p>
                </div>
              </div>
            </label>
          ))}
        </div>

        <details className="mt-4">
          <summary className="text-sm text-foreground-secondary cursor-pointer hover:text-foreground">
            Understanding Balance Reversal
          </summary>
          <div className="mt-2 text-sm text-foreground-muted space-y-2">
            <p>
              In double-entry accounting, some accounts naturally have credit balances (shown as negative in GnuCash):
            </p>
            <ul className="list-disc list-inside space-y-1">
              <li><strong className="text-foreground-secondary">Income</strong> - Money you earn appears negative</li>
              <li><strong className="text-foreground-secondary">Liabilities</strong> - Debts you owe appear negative</li>
              <li><strong className="text-foreground-secondary">Equity</strong> - Net worth appears negative</li>
            </ul>
            <p>
              The balance reversal setting displays these with positive values for easier reading,
              while maintaining proper accounting relationships.
            </p>
          </div>
        </details>
      </div>

      {/* Display Preferences */}
      <div className="bg-surface rounded-xl border border-border p-6">
        <h2 className="text-lg font-semibold text-foreground mb-4">Display Preferences</h2>

        <div className="space-y-4">
          {/* Date Format */}
          <div className="space-y-2">
            <label className="block text-sm text-foreground-secondary">Date Format</label>
            <select
              value={dateFormat}
              onChange={(e) => setDateFormat(e.target.value as DateFormat)}
              className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-cyan-500/50"
            >
              <option value="MM/DD/YYYY">MM/DD/YYYY</option>
              <option value="YYYY-MM-DD">YYYY-MM-DD</option>
              <option value="MM-DD-YYYY">MM-DD-YYYY</option>
            </select>
            <p className="text-xs text-foreground-muted">
              Format used for all date fields in the application.
            </p>
          </div>

          {/* Default Ledger Mode */}
          <div className="space-y-2">
            <label className="block text-sm text-foreground-secondary">Default Ledger Mode</label>
            <select
              value={defaultLedgerMode}
              onChange={(e) => setDefaultLedgerMode(e.target.value as 'readonly' | 'edit')}
              className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:border-cyan-500/50"
            >
              <option value="readonly">Read-only</option>
              <option value="edit">Edit Mode</option>
            </select>
            <p className="text-xs text-foreground-muted">
              Whether account ledgers open in read-only or edit mode by default.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

'use client';

import { useState, useEffect } from 'react';
import { useToast } from '@/contexts/ToastContext';
import { useUserPreferences } from '@/contexts/UserPreferencesContext';

interface ScheduleSettings {
  enabled: boolean;
  intervalHours: number;
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

export default function SettingsPage() {
  const { success, error: showError } = useToast();
  const { defaultTaxRate, setDefaultTaxRate } = useUserPreferences();

  const [schedule, setSchedule] = useState<ScheduleSettings>({ enabled: false, intervalHours: 24 });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [backfilling, setBackfilling] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [indexCoverage, setIndexCoverage] = useState<IndexCoverage | null>(null);

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
    } catch (err) {
      showError('Failed to update schedule setting');
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
    } catch (err) {
      showError('Failed to update refresh interval');
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
    } catch (err) {
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
    } catch (err) {
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
    } catch (err) {
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

          {/* Frequency Dropdown */}
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
            Set a default tax rate to quickly apply to transaction amounts using the Ctrl+T keyboard shortcut.
          </p>

          <div className="space-y-2">
            <label className="block text-sm text-foreground-secondary">Default Tax Rate</label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                step="0.01"
                min="0"
                max="100"
                value={defaultTaxRate > 0 ? (defaultTaxRate * 100).toFixed(2) : ''}
                onChange={(e) => {
                  const pct = parseFloat(e.target.value);
                  if (!isNaN(pct) && pct >= 0 && pct <= 100) {
                    setDefaultTaxRate(pct / 100);
                  } else if (e.target.value === '') {
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
                Ctrl
              </kbd>
              +
              <kbd className="px-1.5 py-0.5 bg-background-tertiary rounded border border-border-hover text-xs">
                T
              </kbd>{' '}
              in amount fields to apply this tax rate to the current value.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

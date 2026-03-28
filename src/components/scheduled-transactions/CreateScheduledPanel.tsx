'use client';

import { useState, useEffect, useCallback } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SplitInput {
  accountGuid: string;
  amount: string;
}

interface CreateScheduledPanelProps {
  onClose: () => void;
  onCreated: () => void;
}

const PERIOD_OPTIONS = [
  { value: 'month', label: 'Monthly' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'daily', label: 'Daily' },
  { value: 'year', label: 'Yearly' },
  { value: 'semi_monthly', label: 'Semi-monthly' },
  { value: 'end of month', label: 'End of month' },
  { value: 'once', label: 'One-time' },
];

const WEEKEND_ADJUST_OPTIONS = [
  { value: 'none', label: 'None' },
  { value: 'back', label: 'Back (to Friday)' },
  { value: 'forward', label: 'Forward (to Monday)' },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CreateScheduledPanel({ onClose, onCreated }: CreateScheduledPanelProps) {
  // Form state
  const [name, setName] = useState('');
  const [periodType, setPeriodType] = useState('month');
  const [multiplier, setMultiplier] = useState(1);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [weekendAdjust, setWeekendAdjust] = useState('none');
  const [splits, setSplits] = useState<SplitInput[]>([
    { accountGuid: '', amount: '' },
    { accountGuid: '', amount: '' },
  ]);
  const [autoCreate, setAutoCreate] = useState(false);
  const [autoNotify, setAutoNotify] = useState(false);

  // UI state
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Derived visibility flags
  const isOnce = periodType === 'once';
  const isDaily = periodType === 'daily';
  const showMultiplier = !isOnce;
  const showWeekendAdjust = !isOnce && !isDaily;

  // Split helpers
  const updateSplit = useCallback((index: number, field: keyof SplitInput, value: string) => {
    setSplits(prev => {
      const next = [...prev];
      next[index] = { ...next[index], [field]: value };

      // Auto-balance: when there are exactly 2 splits and the amount of the first changes,
      // set the second to the negative of the first.
      if (field === 'amount' && prev.length === 2) {
        const otherIndex = index === 0 ? 1 : 0;
        const numVal = parseFloat(value);
        if (!isNaN(numVal) && value !== '') {
          next[otherIndex] = { ...next[otherIndex], amount: String(-numVal) };
        }
      }

      return next;
    });
  }, []);

  const addSplit = () => {
    setSplits(prev => [...prev, { accountGuid: '', amount: '' }]);
  };

  const removeSplit = (index: number) => {
    setSplits(prev => prev.filter((_, i) => i !== index));
  };

  // Validation
  const isValid =
    name.trim() !== '' &&
    startDate !== '' &&
    splits.length >= 2 &&
    splits.every(s => s.accountGuid.trim() !== '' && s.amount !== '' && !isNaN(parseFloat(s.amount)));

  // Submit
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValid || submitting) return;

    setSubmitting(true);
    setError(null);

    try {
      const body = {
        name: name.trim(),
        recurrence: {
          periodType,
          mult: showMultiplier ? multiplier : 1,
          periodStart: startDate,
          weekendAdjust: showWeekendAdjust ? weekendAdjust : 'none',
        },
        startDate,
        endDate: endDate || null,
        autoCreate,
        autoNotify,
        splits: splits.map(s => ({
          accountGuid: s.accountGuid.trim(),
          amount: parseFloat(s.amount),
        })),
      };

      const res = await fetch('/api/scheduled-transactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || `Failed to create (${res.status})`);
      }

      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unexpected error occurred.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/50 z-40"
        onClick={onClose}
      />

      {/* Panel */}
      <div
        className="fixed right-0 top-0 bottom-0 w-full sm:w-[480px] bg-surface z-50 overflow-y-auto"
        role="dialog"
        aria-modal="true"
        aria-label="New Scheduled Transaction"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-lg font-semibold text-foreground">New Scheduled Transaction</h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors"
            aria-label="Close"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-6 space-y-6">
          {/* Name */}
          <div>
            <label className="text-xs text-foreground-secondary block mb-1">Name</label>
            <input
              type="text"
              required
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Monthly Rent"
              className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-foreground-muted focus:outline-none focus:ring-2 focus:ring-cyan-500/40 focus:border-cyan-500/40 transition-colors"
            />
          </div>

          {/* Recurrence */}
          <fieldset className="space-y-4">
            <legend className="text-sm font-medium text-foreground">Recurrence</legend>

            {/* Period type */}
            <div>
              <label className="text-xs text-foreground-secondary block mb-1">Period</label>
              <select
                value={periodType}
                onChange={e => setPeriodType(e.target.value)}
                className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-cyan-500/40 focus:border-cyan-500/40 transition-colors"
              >
                {PERIOD_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>

            {/* Multiplier */}
            {showMultiplier && (
              <div>
                <label className="text-xs text-foreground-secondary block mb-1">
                  Every N {periodType === 'weekly' ? 'weeks' : periodType === 'daily' ? 'days' : periodType === 'year' ? 'years' : 'months'}
                </label>
                <input
                  type="number"
                  min={1}
                  value={multiplier}
                  onChange={e => setMultiplier(Math.max(1, parseInt(e.target.value) || 1))}
                  className="w-24 bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-cyan-500/40 focus:border-cyan-500/40 transition-colors"
                />
              </div>
            )}

            {/* Start date */}
            <div>
              <label className="text-xs text-foreground-secondary block mb-1">Start date</label>
              <input
                type="date"
                required
                value={startDate}
                onChange={e => setStartDate(e.target.value)}
                className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-cyan-500/40 focus:border-cyan-500/40 transition-colors"
              />
            </div>

            {/* End date */}
            <div>
              <label className="text-xs text-foreground-secondary block mb-1">End date (optional)</label>
              <input
                type="date"
                value={endDate}
                onChange={e => setEndDate(e.target.value)}
                className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-cyan-500/40 focus:border-cyan-500/40 transition-colors"
              />
            </div>

            {/* Weekend adjust */}
            {showWeekendAdjust && (
              <div>
                <label className="text-xs text-foreground-secondary block mb-1">Weekend adjustment</label>
                <select
                  value={weekendAdjust}
                  onChange={e => setWeekendAdjust(e.target.value)}
                  className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-cyan-500/40 focus:border-cyan-500/40 transition-colors"
                >
                  {WEEKEND_ADJUST_OPTIONS.map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>
            )}
          </fieldset>

          {/* Splits */}
          <fieldset className="space-y-3">
            <legend className="text-sm font-medium text-foreground">Splits</legend>

            {splits.map((split, idx) => (
              <div key={idx} className="flex items-start gap-2">
                <div className="flex-1 space-y-1">
                  <label className="text-xs text-foreground-secondary block">Account</label>
                  <input
                    type="text"
                    value={split.accountGuid}
                    onChange={e => updateSplit(idx, 'accountGuid', e.target.value)}
                    placeholder="Account GUID"
                    className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-foreground-muted focus:outline-none focus:ring-2 focus:ring-cyan-500/40 focus:border-cyan-500/40 transition-colors"
                  />
                </div>
                <div className="w-28 space-y-1">
                  <label className="text-xs text-foreground-secondary block">Amount</label>
                  <input
                    type="number"
                    step="any"
                    value={split.amount}
                    onChange={e => updateSplit(idx, 'amount', e.target.value)}
                    placeholder="0.00"
                    className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-foreground-muted focus:outline-none focus:ring-2 focus:ring-cyan-500/40 focus:border-cyan-500/40 transition-colors"
                  />
                </div>
                {splits.length > 2 && (
                  <button
                    type="button"
                    onClick={() => removeSplit(idx)}
                    className="mt-6 p-1.5 rounded-lg text-foreground-muted hover:text-red-400 hover:bg-surface-hover transition-colors"
                    aria-label="Remove split"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                )}
              </div>
            ))}

            <button
              type="button"
              onClick={addSplit}
              className="text-xs text-cyan-400 hover:text-cyan-300 transition-colors font-medium"
            >
              + Add Split
            </button>
          </fieldset>

          {/* Options */}
          <fieldset className="space-y-3">
            <legend className="text-sm font-medium text-foreground">Options</legend>

            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={autoCreate}
                onChange={e => setAutoCreate(e.target.checked)}
                className="rounded border-border bg-input-bg text-cyan-600 focus:ring-cyan-500/40"
              />
              <span className="text-sm text-foreground">Auto-create</span>
            </label>

            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={autoNotify}
                onChange={e => setAutoNotify(e.target.checked)}
                className="rounded border-border bg-input-bg text-cyan-600 focus:ring-cyan-500/40"
              />
              <span className="text-sm text-foreground">Auto-notify</span>
            </label>
          </fieldset>

          {/* Error message */}
          {error && (
            <p className="text-red-400 text-sm">{error}</p>
          )}

          {/* Footer buttons */}
          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium rounded-lg bg-gray-600/50 hover:bg-gray-500/50 text-foreground-muted transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!isValid || submitting}
              className="px-4 py-2 text-sm font-medium rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting ? 'Creating...' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </>
  );
}

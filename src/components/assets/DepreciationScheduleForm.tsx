'use client';

import { useState, useEffect } from 'react';
import { useToast } from '@/contexts/ToastContext';

interface AccountOption {
  guid: string;
  name: string;
  fullname: string;
  account_type: string;
}

interface ScheduleData {
  id?: number;
  accountGuid: string;
  purchasePrice: number;
  purchaseDate: string;
  usefulLifeYears: number;
  salvageValue: number;
  method: 'straight-line' | 'declining-balance';
  declineRate: number | null;
  contraAccountGuid: string;
  frequency: 'monthly' | 'quarterly' | 'yearly';
  isAppreciation: boolean;
  notes: string;
}

interface DepreciationScheduleFormProps {
  assetAccountGuid: string;
  existingSchedule?: ScheduleData | null;
  onSaved?: () => void;
  onProcessed?: () => void;
}

export function DepreciationScheduleForm({
  assetAccountGuid,
  existingSchedule,
  onSaved,
  onProcessed,
}: DepreciationScheduleFormProps) {
  const { success, error: showError } = useToast();

  const [saving, setSaving] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [contraAccounts, setContraAccounts] = useState<AccountOption[]>([]);

  const [form, setForm] = useState<ScheduleData>({
    accountGuid: assetAccountGuid,
    purchasePrice: existingSchedule?.purchasePrice ?? 0,
    purchaseDate: existingSchedule?.purchaseDate ?? new Date().toISOString().split('T')[0],
    usefulLifeYears: existingSchedule?.usefulLifeYears ?? 5,
    salvageValue: existingSchedule?.salvageValue ?? 0,
    method: existingSchedule?.method ?? 'straight-line',
    declineRate: existingSchedule?.declineRate ?? null,
    contraAccountGuid: existingSchedule?.contraAccountGuid ?? '',
    frequency: existingSchedule?.frequency ?? 'monthly',
    isAppreciation: existingSchedule?.isAppreciation ?? false,
    notes: existingSchedule?.notes ?? '',
  });

  // Fetch contra accounts (EXPENSE for depreciation, INCOME for appreciation)
  useEffect(() => {
    const targetType = form.isAppreciation ? 'INCOME' : 'EXPENSE';
    fetch('/api/accounts?flat=true')
      .then((res) => res.json())
      .then((data) => {
        const all = (Array.isArray(data) ? data : data.accounts || []) as AccountOption[];
        setContraAccounts(all.filter((a) => a.account_type === targetType));
      })
      .catch(() => {});
  }, [form.isAppreciation]);

  const handleChange = <K extends keyof ScheduleData>(key: K, value: ScheduleData[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const handleSave = async () => {
    if (!form.contraAccountGuid) {
      showError('Please select a contra account');
      return;
    }
    if (form.purchasePrice <= 0) {
      showError('Purchase price must be greater than 0');
      return;
    }

    setSaving(true);
    try {
      const res = await fetch('/api/assets/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (res.ok) {
        success('Depreciation schedule saved');
        onSaved?.();
      } else {
        showError(data.error || 'Failed to save schedule');
      }
    } catch {
      showError('Failed to save schedule');
    } finally {
      setSaving(false);
    }
  };

  const handleProcessPending = async () => {
    if (!existingSchedule?.id) {
      showError('Save the schedule first before generating transactions');
      return;
    }

    setProcessing(true);
    try {
      const res = await fetch('/api/assets/transactions?action=process-schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scheduleId: existingSchedule.id }),
      });
      const data = await res.json();
      if (res.ok) {
        success(`Generated ${data.transactionsCreated} transactions. New balance: ${data.newBalance.toFixed(2)}`);
        onProcessed?.();
      } else {
        showError(data.error || 'Failed to process schedule');
      }
    } catch {
      showError('Failed to process schedule');
    } finally {
      setProcessing(false);
    }
  };

  return (
    <div className="bg-background-secondary rounded-lg border border-border p-5 space-y-4">
      <h3 className="text-lg font-semibold text-foreground">
        {existingSchedule ? 'Edit' : 'Configure'} Depreciation Schedule
      </h3>

      {/* Type Toggle */}
      <div>
        <label className="block text-sm font-medium text-foreground-secondary mb-1">
          Schedule Type
        </label>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => handleChange('isAppreciation', false)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              !form.isAppreciation
                ? 'bg-amber-500/20 text-amber-400 border border-amber-500/40'
                : 'bg-background-tertiary text-foreground-secondary border border-border hover:border-foreground-muted'
            }`}
          >
            Depreciation
          </button>
          <button
            type="button"
            onClick={() => handleChange('isAppreciation', true)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              form.isAppreciation
                ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40'
                : 'bg-background-tertiary text-foreground-secondary border border-border hover:border-foreground-muted'
            }`}
          >
            Appreciation
          </button>
        </div>
      </div>

      {/* Purchase Price & Date */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-foreground-secondary mb-1">
            Purchase Price
          </label>
          <input
            type="number"
            step="0.01"
            min="0"
            value={form.purchasePrice || ''}
            onChange={(e) => handleChange('purchasePrice', parseFloat(e.target.value) || 0)}
            className="w-full px-3 py-2 rounded-lg bg-input-bg border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-cyan-500/40"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-foreground-secondary mb-1">
            Purchase Date
          </label>
          <input
            type="date"
            value={form.purchaseDate}
            onChange={(e) => handleChange('purchaseDate', e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-input-bg border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-cyan-500/40"
          />
        </div>
      </div>

      {/* Useful Life & Salvage Value */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-foreground-secondary mb-1">
            Useful Life (years)
          </label>
          <input
            type="number"
            min="1"
            value={form.usefulLifeYears || ''}
            onChange={(e) => handleChange('usefulLifeYears', parseInt(e.target.value) || 1)}
            className="w-full px-3 py-2 rounded-lg bg-input-bg border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-cyan-500/40"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-foreground-secondary mb-1">
            Salvage Value
          </label>
          <input
            type="number"
            step="0.01"
            min="0"
            value={form.salvageValue || ''}
            onChange={(e) => handleChange('salvageValue', parseFloat(e.target.value) || 0)}
            className="w-full px-3 py-2 rounded-lg bg-input-bg border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-cyan-500/40"
          />
        </div>
      </div>

      {/* Method & Frequency */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-foreground-secondary mb-1">
            Method
          </label>
          <select
            value={form.method}
            onChange={(e) => handleChange('method', e.target.value as ScheduleData['method'])}
            className="w-full px-3 py-2 rounded-lg bg-input-bg border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-cyan-500/40"
          >
            <option value="straight-line">Straight-Line</option>
            <option value="declining-balance">Declining Balance</option>
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-foreground-secondary mb-1">
            Frequency
          </label>
          <select
            value={form.frequency}
            onChange={(e) => handleChange('frequency', e.target.value as ScheduleData['frequency'])}
            className="w-full px-3 py-2 rounded-lg bg-input-bg border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-cyan-500/40"
          >
            <option value="monthly">Monthly</option>
            <option value="quarterly">Quarterly</option>
            <option value="yearly">Yearly</option>
          </select>
        </div>
      </div>

      {/* Decline Rate (only for declining balance) */}
      {form.method === 'declining-balance' && (
        <div>
          <label className="block text-sm font-medium text-foreground-secondary mb-1">
            Decline Rate (default: {(2 / form.usefulLifeYears).toFixed(4)})
          </label>
          <input
            type="number"
            step="0.0001"
            min="0"
            max="1"
            value={form.declineRate ?? ''}
            onChange={(e) =>
              handleChange('declineRate', e.target.value ? parseFloat(e.target.value) : null)
            }
            placeholder={`${(2 / form.usefulLifeYears).toFixed(4)}`}
            className="w-full px-3 py-2 rounded-lg bg-input-bg border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-cyan-500/40"
          />
        </div>
      )}

      {/* Contra Account */}
      <div>
        <label className="block text-sm font-medium text-foreground-secondary mb-1">
          {form.isAppreciation ? 'Income Account' : 'Expense Account'} (Contra)
        </label>
        <select
          value={form.contraAccountGuid}
          onChange={(e) => handleChange('contraAccountGuid', e.target.value)}
          className="w-full px-3 py-2 rounded-lg bg-input-bg border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-cyan-500/40"
        >
          <option value="">-- Select account --</option>
          {contraAccounts.map((acc) => (
            <option key={acc.guid} value={acc.guid}>
              {acc.fullname || acc.name}
            </option>
          ))}
        </select>
      </div>

      {/* Notes */}
      <div>
        <label className="block text-sm font-medium text-foreground-secondary mb-1">
          Notes (optional)
        </label>
        <textarea
          value={form.notes}
          onChange={(e) => handleChange('notes', e.target.value)}
          rows={2}
          className="w-full px-3 py-2 rounded-lg bg-input-bg border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-cyan-500/40 resize-none"
        />
      </div>

      {/* Action Buttons */}
      <div className="flex gap-3 pt-2">
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-4 py-2 bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg transition-colors disabled:opacity-50 font-medium"
        >
          {saving ? 'Saving...' : 'Save Schedule'}
        </button>
        {existingSchedule?.id && (
          <button
            onClick={handleProcessPending}
            disabled={processing}
            className="px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded-lg transition-colors disabled:opacity-50 font-medium"
          >
            {processing ? 'Generating...' : 'Generate Pending Transactions'}
          </button>
        )}
      </div>
    </div>
  );
}

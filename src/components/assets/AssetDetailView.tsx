'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { formatDateForDisplay, parseDateInput } from '@/lib/date-format';
import { useUserPreferences } from '@/contexts/UserPreferencesContext';
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer,
  CartesianGrid,
} from 'recharts';
import { formatCurrency } from '@/lib/format';
import { useToast } from '@/contexts/ToastContext';
import { DepreciationScheduleForm } from './DepreciationScheduleForm';

interface Transaction {
  guid: string;
  date: string;
  description: string;
  amount: number;
  runningBalance: number;
}

interface ScheduleInfo {
  id: number;
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
  lastTransactionDate: string | null;
  enabled: boolean;
  notes: string;
}

interface AssetInfo {
  guid: string;
  name: string;
  accountPath: string;
  currentBalance: number;
}

interface AssetDetailViewProps {
  accountGuid: string;
}

interface AccountOption {
  guid: string;
  name: string;
  fullname: string;
  account_type: string;
}

export function AssetDetailView({ accountGuid }: AssetDetailViewProps) {
  const { success, error: showError } = useToast();
  const { dateFormat } = useUserPreferences();

  const [asset, setAsset] = useState<AssetInfo | null>(null);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [schedule, setSchedule] = useState<ScheduleInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [showScheduleForm, setShowScheduleForm] = useState(false);
  const [showAdjustForm, setShowAdjustForm] = useState(false);

  // Manual adjustment form state
  const [adjustTarget, setAdjustTarget] = useState('');
  const [adjustDate, setAdjustDate] = useState(new Date().toISOString().split('T')[0]);
  const [adjustDateDisplay, setAdjustDateDisplay] = useState(() => formatDateForDisplay(new Date().toISOString().split('T')[0], dateFormat));
  const [adjustContraGuid, setAdjustContraGuid] = useState('');
  const [adjustNotes, setAdjustNotes] = useState('');
  const [adjusting, setAdjusting] = useState(false);
  const [contraAccounts, setContraAccounts] = useState<AccountOption[]>([]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      // Fetch account info from account hierarchy
      const accountRes = await fetch(`/api/accounts/${accountGuid}/info`);
      if (accountRes.ok) {
        const accountData = await accountRes.json();

        setAsset({
          guid: accountGuid,
          name: accountData.name,
          accountPath: accountData.fullname || accountData.name,
          currentBalance: 0, // Will be set from transactions
        });
      }

      // Fetch transactions for this account
      // The API returns transactions in desc order with running_balance and account_split_value
      const txRes = await fetch(`/api/accounts/${accountGuid}/transactions?limit=1000`);
      if (txRes.ok) {
        const rawTxs = await txRes.json();
        // rawTxs is an array (or could be an empty array)
        const txArray = Array.isArray(rawTxs) ? rawTxs : [];

        // Transactions come in descending date order with running_balance already computed
        // We need to reverse to ascending for chart display
        const txList: Transaction[] = txArray.map((tx: {
          guid: string;
          post_date: string | null;
          description: string | null;
          account_split_value: string;
          running_balance: string;
        }) => ({
          guid: tx.guid,
          date: tx.post_date
            ? new Date(tx.post_date).toISOString().split('T')[0]
            : '',
          description: tx.description || '',
          amount: parseFloat(tx.account_split_value) || 0,
          runningBalance: parseFloat(tx.running_balance) || 0,
        }));

        // Reverse to ascending order for chart and display
        txList.reverse();
        setTransactions(txList);

        // Update asset balance from the most recent transaction (last in reversed/ascending list)
        if (txList.length > 0) {
          // The first element of the original (desc) response has the most recent balance
          const mostRecentBalance = parseFloat(txArray[0].running_balance) || 0;
          setAsset((prev) =>
            prev ? { ...prev, currentBalance: mostRecentBalance } : prev
          );
        }
      }

      // Fetch depreciation schedule
      const schedRes = await fetch(`/api/assets/schedules?accountGuid=${accountGuid}`);
      if (schedRes.ok) {
        const schedData = await schedRes.json();
        setSchedule(schedData.schedule || null);
      }
    } catch (err) {
      console.error('Error loading asset details:', err);
      showError('Failed to load asset details');
    } finally {
      setLoading(false);
    }
  }, [accountGuid, showError]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Fetch contra accounts for manual adjustment (EXPENSE and INCOME types)
  useEffect(() => {
    fetch('/api/accounts?flat=true')
      .then((res) => res.json())
      .then((data) => {
        const all = (Array.isArray(data) ? data : data.accounts || []) as AccountOption[];
        setContraAccounts(all.filter((a) => a.account_type === 'EXPENSE' || a.account_type === 'INCOME'));
      })
      .catch(() => {});
  }, []);

  // Chart data: balance over time
  const chartData = useMemo(() => {
    return transactions.map((tx) => ({
      date: tx.date,
      balance: tx.runningBalance,
    }));
  }, [transactions]);

  const handleAdjust = async () => {
    const target = parseFloat(adjustTarget);
    if (isNaN(target)) {
      showError('Enter a valid target value');
      return;
    }
    if (!adjustContraGuid) {
      showError('Select a contra account');
      return;
    }

    setAdjusting(true);
    try {
      const res = await fetch('/api/assets/transactions?action=adjust', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assetAccountGuid: accountGuid,
          contraAccountGuid: adjustContraGuid,
          targetValue: target,
          date: adjustDate,
          description: adjustNotes || undefined,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        success(
          `Adjusted by ${formatCurrency(data.adjustmentAmount)} (${data.type})`
        );
        setShowAdjustForm(false);
        setAdjustTarget('');
        setAdjustNotes('');
        fetchData();
      } else {
        showError(data.error || 'Failed to adjust value');
      }
    } catch {
      showError('Failed to adjust value');
    } finally {
      setAdjusting(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="h-8 bg-background-tertiary rounded animate-pulse w-64" />
        <div className="h-64 bg-background-tertiary rounded-lg animate-pulse" />
        <div className="h-48 bg-background-tertiary rounded-lg animate-pulse" />
      </div>
    );
  }

  if (!asset) {
    return (
      <div className="bg-background-secondary rounded-lg p-8 border border-border text-center">
        <p className="text-foreground-secondary">Asset account not found</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <header className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-3xl font-bold text-foreground">{asset.name}</h1>
          <p className="text-foreground-muted text-sm">{asset.accountPath}</p>
          <p className="text-2xl font-bold text-foreground mt-1">
            {formatCurrency(asset.currentBalance)}
          </p>
        </div>
        <button
          onClick={() => setShowAdjustForm((prev) => !prev)}
          className="px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded-lg transition-colors font-medium"
        >
          Record Valuation Change
        </button>
      </header>

      {/* Manual Adjustment Form */}
      {showAdjustForm && (
        <div className="bg-background-secondary rounded-lg border border-border p-5 space-y-4">
          <h3 className="text-lg font-semibold text-foreground">
            Record Valuation Change
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-foreground-secondary mb-1">
                New Value
              </label>
              <input
                type="number"
                step="0.01"
                value={adjustTarget}
                onChange={(e) => setAdjustTarget(e.target.value)}
                placeholder={asset.currentBalance.toFixed(2)}
                className="w-full px-3 py-2 rounded-lg bg-input-bg border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-cyan-500/40"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-foreground-secondary mb-1">
                Date
              </label>
              <input
                type="text"
                value={adjustDateDisplay}
                onChange={(e) => setAdjustDateDisplay(e.target.value)}
                onFocus={(e) => e.target.select()}
                onBlur={() => {
                  const parsed = parseDateInput(adjustDateDisplay);
                  if (parsed) {
                    setAdjustDate(parsed);
                    setAdjustDateDisplay(formatDateForDisplay(parsed, dateFormat));
                  } else {
                    setAdjustDateDisplay(formatDateForDisplay(adjustDate, dateFormat));
                  }
                }}
                placeholder="MM/DD/YYYY"
                className="w-full px-3 py-2 rounded-lg bg-input-bg border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-cyan-500/40"
              />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-foreground-secondary mb-1">
              Contra Account
            </label>
            <select
              value={adjustContraGuid}
              onChange={(e) => setAdjustContraGuid(e.target.value)}
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
          <div>
            <label className="block text-sm font-medium text-foreground-secondary mb-1">
              Notes (optional)
            </label>
            <input
              type="text"
              value={adjustNotes}
              onChange={(e) => setAdjustNotes(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-input-bg border border-border text-foreground focus:outline-none focus:ring-2 focus:ring-cyan-500/40"
            />
          </div>
          <div className="flex gap-3">
            <button
              onClick={handleAdjust}
              disabled={adjusting}
              className="px-4 py-2 bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg transition-colors disabled:opacity-50 font-medium"
            >
              {adjusting ? 'Adjusting...' : 'Submit Adjustment'}
            </button>
            <button
              onClick={() => setShowAdjustForm(false)}
              className="px-4 py-2 bg-background-tertiary text-foreground-secondary rounded-lg border border-border hover:bg-surface-hover transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Value Chart */}
      {chartData.length > 1 && (
        <div className="bg-background-secondary rounded-lg border border-border p-5">
          <h3 className="text-lg font-semibold text-foreground mb-4">Value History</h3>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                <XAxis
                  dataKey="date"
                  stroke="#888"
                  fontSize={12}
                  tickFormatter={(val) => {
                    const d = new Date(val);
                    return `${d.getUTCMonth() + 1}/${d.getUTCFullYear().toString().slice(2)}`;
                  }}
                />
                <YAxis
                  stroke="#888"
                  fontSize={12}
                  tickFormatter={(val) => formatCurrency(val)}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: 'rgba(17,24,39,0.95)',
                    border: '1px solid rgba(255,255,255,0.1)',
                    borderRadius: '8px',
                    color: '#fff',
                  }}
                  formatter={(value: number | undefined) => [formatCurrency(value ?? 0), 'Value']}
                  labelFormatter={(label) => `Date: ${label}`}
                />
                <Line
                  type="monotone"
                  dataKey="balance"
                  stroke="#06b6d4"
                  strokeWidth={2}
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Transaction History */}
      <div className="bg-background-secondary rounded-lg border border-border p-5">
        <h3 className="text-lg font-semibold text-foreground mb-4">
          Transaction History
        </h3>
        {transactions.length === 0 ? (
          <p className="text-foreground-muted text-center py-4">
            No transactions found for this account
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="pb-2 text-foreground-secondary font-medium">Date</th>
                  <th className="pb-2 text-foreground-secondary font-medium">Description</th>
                  <th className="pb-2 text-foreground-secondary font-medium text-right">Amount</th>
                  <th className="pb-2 text-foreground-secondary font-medium text-right">Balance</th>
                </tr>
              </thead>
              <tbody>
                {[...transactions].reverse().map((tx) => (
                  <tr key={tx.guid} className="border-b border-border/50 hover:bg-surface-hover">
                    <td className="py-2 text-foreground-secondary">{tx.date}</td>
                    <td className="py-2 text-foreground">{tx.description}</td>
                    <td className={`py-2 text-right ${
                      tx.amount >= 0 ? 'text-emerald-400' : 'text-rose-400'
                    }`}>
                      {tx.amount >= 0 ? '+' : ''}{formatCurrency(tx.amount)}
                    </td>
                    <td className="py-2 text-right text-foreground">
                      {formatCurrency(tx.runningBalance)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Depreciation Schedule Card */}
      <div className="bg-background-secondary rounded-lg border border-border p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-foreground">
            Depreciation / Appreciation Schedule
          </h3>
          <button
            onClick={() => setShowScheduleForm((prev) => !prev)}
            className="text-sm text-cyan-400 hover:text-cyan-300 transition-colors"
          >
            {showScheduleForm ? 'Hide Form' : schedule ? 'Edit Schedule' : 'Configure Schedule'}
          </button>
        </div>

        {/* Current schedule info */}
        {schedule && !showScheduleForm && (
          <div className="space-y-2">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
              <div>
                <p className="text-foreground-muted">Type</p>
                <p className="text-foreground font-medium">
                  {schedule.isAppreciation ? 'Appreciation' : 'Depreciation'}
                </p>
              </div>
              <div>
                <p className="text-foreground-muted">Method</p>
                <p className="text-foreground font-medium capitalize">
                  {schedule.method.replace('-', ' ')}
                </p>
              </div>
              <div>
                <p className="text-foreground-muted">Frequency</p>
                <p className="text-foreground font-medium capitalize">{schedule.frequency}</p>
              </div>
              <div>
                <p className="text-foreground-muted">Status</p>
                <p className={`font-medium ${schedule.enabled ? 'text-emerald-400' : 'text-gray-400'}`}>
                  {schedule.enabled ? 'Active' : 'Disabled'}
                </p>
              </div>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm mt-3">
              <div>
                <p className="text-foreground-muted">Purchase Price</p>
                <p className="text-foreground font-medium">
                  {formatCurrency(schedule.purchasePrice)}
                </p>
              </div>
              <div>
                <p className="text-foreground-muted">Salvage Value</p>
                <p className="text-foreground font-medium">
                  {formatCurrency(schedule.salvageValue)}
                </p>
              </div>
              <div>
                <p className="text-foreground-muted">Useful Life</p>
                <p className="text-foreground font-medium">{schedule.usefulLifeYears} years</p>
              </div>
              <div>
                <p className="text-foreground-muted">Last Transaction</p>
                <p className="text-foreground font-medium">
                  {schedule.lastTransactionDate || 'None'}
                </p>
              </div>
            </div>
            {schedule.notes && (
              <p className="text-sm text-foreground-muted mt-2 italic">{schedule.notes}</p>
            )}
          </div>
        )}

        {!schedule && !showScheduleForm && (
          <p className="text-foreground-muted text-center py-4">
            No depreciation schedule configured for this asset.
          </p>
        )}

        {/* Schedule Form */}
        {showScheduleForm && (
          <DepreciationScheduleForm
            assetAccountGuid={accountGuid}
            existingSchedule={schedule}
            onSaved={() => {
              setShowScheduleForm(false);
              fetchData();
            }}
            onProcessed={() => {
              fetchData();
            }}
          />
        )}
      </div>
    </div>
  );
}

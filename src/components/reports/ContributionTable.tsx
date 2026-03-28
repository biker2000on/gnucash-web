'use client';

import { useState } from 'react';
import { formatCurrency } from '@/lib/format';
import { AccountContributionSummary, ContributionLineItem } from '@/lib/reports/types';
import { ContributionLimitBar } from './ContributionLimitBar';

const TYPE_LABELS: Record<string, string> = {
  contribution: 'Contribution',
  income_contribution: 'Payroll',
  employer_match: 'Employer Match',
  transfer: 'Transfer/Rollover',
  fee: 'Fee',
  withdrawal: 'Withdrawal',
  dividend: 'Dividend',
  other: 'Other',
};

const TYPE_COLORS: Record<string, string> = {
  contribution: 'text-green-400',
  income_contribution: 'text-green-400',
  employer_match: 'text-cyan-400',
  transfer: 'text-foreground-secondary',
  fee: 'text-red-400',
  withdrawal: 'text-red-400',
  dividend: 'text-yellow-400',
  other: 'text-foreground-tertiary',
};

const RETIREMENT_TYPE_LABELS: Record<string, string> = {
  roth_ira: 'ROTH IRA',
  traditional_ira: 'TRAD IRA',
  '401k': '401K',
  roth_401k: 'ROTH 401K',
  '403b': '403B',
  '457b': '457B',
  sep_ira: 'SEP IRA',
  simple_ira: 'SIMPLE IRA',
  hsa: 'HSA',
};

interface ContributionTableProps {
  accounts: AccountContributionSummary[];
  year: number;
  onTaxYearChange?: (splitGuid: string, newYear: number) => void;
}

function TransactionRow({
  item,
  onTaxYearChange,
}: {
  item: ContributionLineItem;
  onTaxYearChange?: (splitGuid: string, newYear: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(item.taxYear);

  const handleSave = () => {
    if (editValue !== item.taxYear && onTaxYearChange) {
      onTaxYearChange(item.splitGuid, editValue);
    }
    setEditing(false);
  };

  const handleCancel = () => {
    setEditValue(item.taxYear);
    setEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSave();
    if (e.key === 'Escape') handleCancel();
  };

  return (
    <tr className="border-t border-border/50 hover:bg-background-tertiary/30 transition-colors">
      <td className="px-4 py-2 text-sm text-foreground-secondary whitespace-nowrap">
        {new Date(item.date).toLocaleDateString()}
      </td>
      <td className="px-4 py-2 text-sm text-foreground">
        {item.description}
      </td>
      <td className="px-4 py-2 text-sm">
        <span className={TYPE_COLORS[item.type] || TYPE_COLORS.other}>
          {TYPE_LABELS[item.type] || item.type}
        </span>
      </td>
      <td className="px-4 py-2 text-sm text-foreground-secondary">
        {item.sourceAccountName}
      </td>
      <td className="px-4 py-2 text-sm text-right font-mono">
        <span className={item.amount < 0 ? 'text-red-400' : 'text-foreground'}>
          {formatCurrency(item.amount)}
        </span>
      </td>
      <td className="px-4 py-2 text-sm text-center">
        {editing ? (
          <span className="inline-flex items-center gap-1">
            <input
              type="number"
              value={editValue}
              onChange={(e) => setEditValue(parseInt(e.target.value, 10))}
              onKeyDown={handleKeyDown}
              className="w-16 px-1 py-0.5 text-xs bg-input-bg border border-border rounded text-foreground text-center"
              autoFocus
            />
            <button
              onClick={handleSave}
              className="text-green-400 hover:text-green-300 text-xs px-1"
              title="Save"
            >
              Save
            </button>
            <button
              onClick={handleCancel}
              className="text-foreground-tertiary hover:text-foreground-secondary text-xs px-1"
              title="Cancel"
            >
              Cancel
            </button>
          </span>
        ) : (
          <button
            onClick={() => onTaxYearChange && setEditing(true)}
            className={`text-foreground-secondary hover:text-foreground text-xs ${
              onTaxYearChange ? 'cursor-pointer hover:underline' : 'cursor-default'
            }`}
            disabled={!onTaxYearChange}
          >
            {item.taxYear}
          </button>
        )}
      </td>
    </tr>
  );
}

function AccountCard({
  account,
  onTaxYearChange,
}: {
  account: AccountContributionSummary;
  onTaxYearChange?: (splitGuid: string, newYear: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  const retirementLabel = account.retirementAccountType
    ? RETIREMENT_TYPE_LABELS[account.retirementAccountType] || account.retirementAccountType.toUpperCase()
    : null;

  return (
    <div className="border border-border rounded-xl overflow-hidden">
      {/* Account header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-4 py-3 flex items-center justify-between bg-background-secondary/50 hover:bg-background-secondary/80 transition-colors text-left"
      >
        <div className="flex items-center gap-3 min-w-0">
          <svg
            className={`w-4 h-4 text-foreground-tertiary transition-transform flex-shrink-0 ${
              expanded ? 'rotate-90' : ''
            }`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
          <span className="text-sm font-medium text-foreground truncate">
            {account.accountPath}
          </span>
          {retirementLabel && (
            <span className="text-xs px-2 py-0.5 bg-cyan-500/20 text-cyan-400 rounded-full flex-shrink-0">
              {retirementLabel}
            </span>
          )}
        </div>
        <div className="flex items-center gap-6 text-xs flex-shrink-0">
          {account.contributions !== 0 && (
            <span className="text-green-400">
              Contributions: {formatCurrency(account.contributions)}
            </span>
          )}
          {account.employerMatch !== 0 && (
            <span className="text-cyan-400">
              Employer: {formatCurrency(account.employerMatch)}
            </span>
          )}
          {account.transfers !== 0 && (
            <span className="text-foreground-secondary">
              Transfers: {formatCurrency(account.transfers)}
            </span>
          )}
          {account.withdrawals !== 0 && (
            <span className="text-red-400">
              Withdrawals: {formatCurrency(account.withdrawals)}
            </span>
          )}
          <span className="font-medium text-foreground">
            Net: {formatCurrency(account.netContributions)}
          </span>
        </div>
      </button>

      {/* IRS limit bar */}
      {account.irsLimit && (
        <div className="px-4 py-2 border-t border-border/50 bg-background-secondary/30">
          <ContributionLimitBar
            current={account.contributions + account.incomeContributions}
            limit={account.irsLimit.total}
            label="IRS Contribution Limit"
            catchUp={account.irsLimit.catchUp > 0 ? account.irsLimit.catchUp : undefined}
          />
        </div>
      )}

      {/* Expanded transaction list */}
      {expanded && (
        <div className="border-t border-border/50">
          {account.transactions.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-foreground-tertiary">
              No transactions in this period
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="text-xs text-foreground-tertiary">
                    <th className="px-4 py-2 text-left font-medium">Date</th>
                    <th className="px-4 py-2 text-left font-medium">Description</th>
                    <th className="px-4 py-2 text-left font-medium">Type</th>
                    <th className="px-4 py-2 text-left font-medium">Source</th>
                    <th className="px-4 py-2 text-right font-medium">Amount</th>
                    <th className="px-4 py-2 text-center font-medium">Tax Year</th>
                  </tr>
                </thead>
                <tbody>
                  {account.transactions.map((tx) => (
                    <TransactionRow
                      key={tx.splitGuid}
                      item={tx}
                      onTaxYearChange={onTaxYearChange}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function ContributionTable({ accounts, year, onTaxYearChange }: ContributionTableProps) {
  if (accounts.length === 0) {
    return (
      <div className="text-center py-8 text-foreground-tertiary text-sm">
        No contribution data for {year}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {accounts.map((account) => (
        <AccountCard
          key={account.accountGuid}
          account={account}
          onTaxYearChange={onTaxYearChange}
        />
      ))}
    </div>
  );
}

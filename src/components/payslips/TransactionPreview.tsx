'use client';

import { formatCurrency } from '@/lib/format';
import { validatePayslipBalance, buildSplitsFromLineItems } from '@/lib/services/payslip-post.service';
import type { PayslipLineItem } from '@/lib/types';

interface TransactionPreviewProps {
  lineItems: PayslipLineItem[];
  mappings: Record<string, string>;
  accountNames: Record<string, string>;
  depositAccountGuid: string;
  depositAccountName: string;
  netPay: number;
  employerName: string;
  payDate: string;
}

export function TransactionPreview({
  lineItems,
  mappings,
  accountNames,
  depositAccountGuid,
  depositAccountName,
  netPay,
  employerName,
  payDate,
}: TransactionPreviewProps) {
  const imbalance = validatePayslipBalance(lineItems, netPay);
  const splits = buildSplitsFromLineItems(lineItems, mappings, depositAccountGuid, netPay);

  // Format the pay date for display
  const payDateObj = new Date(payDate);
  const formattedDate = payDateObj.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

  return (
    <div className="bg-surface/50 rounded-xl border border-border p-4">
      {/* Header */}
      <div className="mb-4">
        <h3 className="text-xs font-semibold text-foreground-secondary uppercase tracking-wider mb-2">
          Transaction Preview
        </h3>
        <p className="text-sm text-foreground">
          Payslip: {employerName} • {formattedDate}
        </p>
      </div>

      {/* Warning banner if imbalanced */}
      {Math.abs(imbalance) >= 0.01 && (
        <div className="mb-4 bg-yellow-500/10 text-yellow-400 text-xs rounded-lg p-3 border border-yellow-500/20">
          Imbalance: ${Math.abs(imbalance).toFixed(2)}
        </div>
      )}

      {/* Transaction table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          {/* Table header */}
          <thead>
            <tr className="border-b border-border">
              <th className="text-xs text-foreground-muted font-semibold text-left py-2 px-2">Account</th>
              <th className="text-xs text-foreground-muted font-semibold text-right py-2 px-2">Debit</th>
              <th className="text-xs text-foreground-muted font-semibold text-right py-2 px-2">Credit</th>
            </tr>
          </thead>

          {/* Table body */}
          <tbody>
            {splits.map((split, idx) => {
              const accountName = split.accountGuid === depositAccountGuid
                ? depositAccountName
                : (accountNames[split.accountGuid] || `Unknown Account`);
              const isDebit = split.amount > 0;

              return (
                <tr key={idx} className="border-b border-border/30">
                  <td className="text-foreground py-2 px-2">{accountName}</td>
                  <td className="text-right font-mono tabular-nums text-foreground py-2 px-2">
                    {isDebit ? formatCurrency(split.amount, 'USD') : ''}
                  </td>
                  <td className="text-right font-mono tabular-nums text-foreground py-2 px-2">
                    {!isDebit ? formatCurrency(Math.abs(split.amount), 'USD') : ''}
                  </td>
                </tr>
              );
            })}
          </tbody>

          {/* Totals row */}
          <tfoot>
            <tr className="border-t-2 border-border">
              <td className="text-foreground-secondary font-semibold py-2 px-2">Total</td>
              <td className="text-right font-mono tabular-nums font-semibold text-foreground py-2 px-2">
                {formatCurrency(
                  splits.filter((s) => s.amount > 0).reduce((sum, s) => sum + s.amount, 0),
                  'USD'
                )}
              </td>
              <td className="text-right font-mono tabular-nums font-semibold text-foreground py-2 px-2">
                {formatCurrency(
                  splits
                    .filter((s) => s.amount < 0)
                    .reduce((sum, s) => sum + Math.abs(s.amount), 0),
                  'USD'
                )}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

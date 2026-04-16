'use client';

import { formatCurrency } from '@/lib/format';

interface SplitDisplay {
  guid: string;
  account_name: string;
  account_fullname: string;
  memo: string;
  value_decimal: number;
  quantity_decimal: number;
  account_guid: string;
  commodity_mnemonic?: string;
}

interface SplitRowsProps {
  splits: SplitDisplay[];
  currencyMnemonic: string;
  columns: number;
  /** Number of trailing columns after the debit/credit content (balance, shareBalance, costBasis, actions, etc.) */
  trailingColumns?: number;
  /** Column IDs from TanStack Table — preferred over arithmetic counting for alignment */
  columnIds?: string[];
  /** If true, render investment-style columns: memo, account, shares, price, buy, sell */
  isInvestmentAccount?: boolean;
  /** The account currency for investment accounts (e.g. 'USD') */
  accountCurrency?: string;
  sharePrecision?: number;
}

// IMPORTANT: Pass ALL splits including the account's own split.
// Do NOT filter out splits where account_guid === current account.

export default function SplitRows({ splits, currencyMnemonic, columns, trailingColumns, columnIds, isInvestmentAccount, accountCurrency, sharePrecision: sp = 4 }: SplitRowsProps) {
  // Compute leading/trailing from columnIds when provided, falling back to arithmetic.
  // Content columns are what the split row renders body cells for.
  const splitContentColumns = isInvestmentAccount
    ? ['description', 'transfer', 'shares', 'price', 'buy', 'sell']
    : ['description', 'transfer', 'debit', 'credit'];
  const splitContentSet = new Set(splitContentColumns);
  let leadingIds: string[] = [];
  let trailingIds: string[] = [];
  if (columnIds) {
    let foundFirst = false;
    let lastContentIdx = -1;
    for (let i = 0; i < columnIds.length; i++) {
      if (splitContentSet.has(columnIds[i])) {
        if (!foundFirst) foundFirst = true;
        lastContentIdx = i;
      } else if (!foundFirst) {
        leadingIds.push(columnIds[i]);
      }
    }
    if (lastContentIdx >= 0) trailingIds = columnIds.slice(lastContentIdx + 1);
  }

  if (isInvestmentAccount) {
    // Investment layout: memo (description), account (transfer), shares, price, buy, sell
    // Leading: columns before description (select/expand, reconcile, date)
    // Trailing: shareBalance, costBasis, [actions]
    const contentCols = 6; // memo, account, shares, price, buy, sell
    const trailingEmpty = trailingColumns ?? 2; // shareBalance + costBasis
    const leadingEmpty = columnIds ? leadingIds.length : Math.max(0, columns - contentCols - trailingEmpty);
    const actualTrailing = columnIds ? trailingIds.length : columns - leadingEmpty - contentCols;
    const currency = accountCurrency || 'USD';

    return (
      <>
        {splits.map(split => {
          const qty = split.quantity_decimal;
          const val = split.value_decimal;
          const absQty = Math.abs(qty);
          const absVal = Math.abs(val);
          const splitCommodity = split.commodity_mnemonic || currencyMnemonic;
          // Determine if this split is a buy (positive qty) or sell (negative qty)
          const isBuy = qty > 0;
          // For non-stock splits (currency splits), qty === val, show in buy/sell based on value sign
          const isStockSplit = splitCommodity !== currency && splitCommodity !== 'USD' && !splitCommodity.startsWith('Trading');

          return (
            <tr key={split.guid} className="bg-background-secondary/30 border-b border-border/30">
              {Array.from({ length: leadingEmpty }, (_, i) => (
                <td key={`lead-${i}`} className="px-3 py-1.5" />
              ))}
              {/* Memo (description col) */}
              <td className="px-3 py-1.5 pl-8 text-xs text-foreground-muted">
                {split.memo || ''}
              </td>
              {/* Account (transfer col) */}
              <td className="px-3 py-1.5 text-xs text-primary">
                {split.account_fullname || split.account_name}
              </td>
              {/* Shares */}
              <td className="px-3 py-1.5 text-right text-xs text-foreground-secondary font-mono">
                {absQty > 0.0001 && qty !== val ? (
                  <span className={qty < 0 ? 'text-rose-400' : ''}>
                    {qty < 0 ? `(${absQty.toFixed(sp)})` : absQty.toFixed(sp)}
                  </span>
                ) : ''}
              </td>
              {/* Price */}
              <td className="px-3 py-1.5 text-right text-xs text-foreground-secondary font-mono">
                {absQty > 0.0001 && absVal > 0 && qty !== val ? (
                  `${Math.abs(val / qty).toFixed(2)}`
                ) : ''}
              </td>
              {/* Buy (positive value) */}
              <td className="px-3 py-1.5 text-right text-xs text-foreground-secondary font-mono">
                {val > 0 ? formatCurrency(absVal, splitCommodity) : ''}
              </td>
              {/* Sell (negative value) */}
              <td className="px-3 py-1.5 text-right text-xs text-foreground-secondary font-mono">
                {val < 0 ? formatCurrency(absVal, splitCommodity) : ''}
              </td>
              {Array.from({ length: actualTrailing }, (_, i) => (
                <td key={`trail-${i}`} className="px-3 py-1.5" />
              ))}
            </tr>
          );
        })}
      </>
    );
  }

  // Standard (non-investment) layout: memo, account, debit, credit
  const contentCols = 4;
  const trailingEmpty = trailingColumns ?? 2; // balance + receipt (default for non-edit, non-reconcile ledger)
  const leadingEmpty = columnIds ? leadingIds.length : Math.max(0, columns - contentCols - trailingEmpty);
  const actualTrailing = columnIds ? trailingIds.length : columns - leadingEmpty - contentCols;

  return (
    <>
      {splits.map(split => {
        const isDebit = split.value_decimal > 0;
        const absValue = Math.abs(split.value_decimal);

        return (
          <tr key={split.guid} className="bg-background-secondary/30 border-b border-border/30">
            {Array.from({ length: leadingEmpty }, (_, i) => (
              <td key={`lead-${i}`} className="px-3 py-1.5" />
            ))}
            {/* Memo in description column */}
            <td className="px-3 py-1.5 pl-8 text-xs text-foreground-muted">
              {split.memo || ''}
            </td>
            {/* Account path in transfer column */}
            <td className="px-3 py-1.5 text-xs text-primary">
              {split.account_fullname || split.account_name}
            </td>
            {/* Debit */}
            <td className="px-3 py-1.5 text-right text-xs text-foreground-secondary font-mono">
              {isDebit ? formatCurrency(absValue, split.commodity_mnemonic || currencyMnemonic) : ''}
            </td>
            {/* Credit */}
            <td className="px-3 py-1.5 text-right text-xs text-foreground-secondary font-mono">
              {!isDebit && absValue > 0 ? formatCurrency(absValue, split.commodity_mnemonic || currencyMnemonic) : ''}
            </td>
            {Array.from({ length: actualTrailing }, (_, i) => (
              <td key={`trail-${i}`} className="px-3 py-1.5" />
            ))}
          </tr>
        );
      })}
    </>
  );
}

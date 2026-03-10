import { AccountTransaction } from '../AccountLedger';
import { Split } from '@/lib/types';

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Check if a transaction is truly multi-split, excluding auto-generated
 * Trading: splits which shouldn't count toward the multi-split threshold.
 */
export function isMultiSplitTransaction(splits: Split[] | undefined): boolean {
    const nonTrading = (splits ?? []).filter(
        s => !(s.account_fullname ?? s.account_name ?? '').startsWith('Trading:')
    );
    return nonTrading.length > 2;
}

// ── Interfaces ──────────────────────────────────────────────────────────

export interface InvestmentRowData {
    guid: string;
    post_date: string | Date;
    description: string;
    transferAccount: string;
    transferAccountGuid: string;
    currencyMnemonic: string;    // transaction currency (e.g., "USD") for formatting monetary values
    shares: number | null;       // null for non-share transactions (cash dividends)
    price: number | null;        // null when shares is 0
    buyAmount: number | null;    // positive number or null
    sellAmount: number | null;   // positive number or null
    shareBalance: number;        // from server-side computation
    costBasis: number;           // from server-side computation
    transactionType: 'buy' | 'sell' | 'dividend' | 'other';
}

export interface InvestmentApiResponse {
    transactions: AccountTransaction[];
    is_investment: true;
}

// ── API response parsing ────────────────────────────────────────────────

/**
 * Parse the API response which may be either a plain array of transactions
 * or an investment-specific response with metadata.
 */
export function parseTransactionsResponse(data: unknown): AccountTransaction[] {
    if (data && typeof data === 'object' && 'is_investment' in data) {
        return (data as InvestmentApiResponse).transactions;
    }
    return data as AccountTransaction[];
}

// ── Row transformation ──────────────────────────────────────────────────

/**
 * Find the primary transfer split: the non-trading, non-self split with
 * the largest |value_decimal|. Falls back to the first non-self split.
 */
function findTransferSplit(splits: Split[], accountGuid: string): Split | undefined {
    const otherSplits = splits.filter(
        (s) => s.account_guid !== accountGuid
    );
    if (otherSplits.length === 0) return undefined;

    // Prefer non-trading splits
    const nonTrading = otherSplits.filter(
        (s) => !(s.account_fullname ?? s.account_name ?? '').startsWith('Trading:')
    );

    const candidates = nonTrading.length > 0 ? nonTrading : otherSplits;

    // Pick the one with the largest absolute value
    return candidates.reduce((best, cur) => {
        const bestVal = Math.abs(parseFloat(best.value_decimal ?? '0'));
        const curVal = Math.abs(parseFloat(cur.value_decimal ?? '0'));
        return curVal > bestVal ? cur : best;
    });
}

/**
 * Determine the transaction type from the share quantity.
 *
 * GnuCash sign convention for the stock account split:
 *  - Buy:  positive quantity (shares in), negative value (money out)
 *  - Sell: negative quantity (shares out), positive value (money in)
 *  - Dividend / other: zero quantity
 */
function classifyTransaction(shares: number): 'buy' | 'sell' | 'dividend' | 'other' {
    if (shares > 0) return 'buy';
    if (shares < 0) return 'sell';
    return 'dividend';
}

/**
 * Transform an AccountTransaction into an InvestmentRowData for display
 * in the investment ledger view.
 *
 * @param tx - The transaction row from the API (includes splits, share_balance, cost_basis)
 * @param accountGuid - The GUID of the investment account being viewed
 */
export function transformToInvestmentRow(
    tx: AccountTransaction & { share_balance?: string; cost_basis?: string },
    accountGuid: string,
): InvestmentRowData {
    const splits = tx.splits ?? [];

    // Find the account's own split
    const accountSplit = splits.find((s) => s.account_guid === accountGuid);

    const shares = accountSplit
        ? parseFloat(accountSplit.quantity_decimal ?? '0')
        : 0;

    const value = accountSplit
        ? parseFloat(accountSplit.value_decimal ?? '0')
        : 0;

    const absValue = Math.abs(value);
    const absShares = Math.abs(shares);

    // Derive per-share price when there are shares
    const price = absShares !== 0 ? absValue / absShares : null;

    // Buy: shares > 0 (value is negative in GnuCash, we show absolute)
    // Sell: shares < 0 (value is positive in GnuCash, we show absolute)
    const buyAmount = shares > 0 ? absValue : null;
    const sellAmount = shares < 0 ? absValue : null;

    const transactionType = classifyTransaction(shares);

    // Transfer account info
    const transferSplit = findTransferSplit(splits, accountGuid);
    const transferAccount = transferSplit?.account_fullname
        ?? transferSplit?.account_name
        ?? '';
    const transferAccountGuid = transferSplit?.account_guid ?? '';

    // Server-provided running totals
    const shareBalance = parseFloat(tx.share_balance ?? '0');
    const costBasis = parseFloat(tx.cost_basis ?? '0');

    // Currency mnemonic for monetary formatting — use the transfer split's commodity
    // (e.g., "USD") rather than the account's commodity (e.g., "AAPL")
    const currencyMnemonic = transferSplit?.commodity_mnemonic ?? 'USD';

    return {
        guid: tx.guid,
        post_date: tx.post_date,
        description: tx.description,
        transferAccount,
        transferAccountGuid,
        currencyMnemonic,
        shares: shares !== 0 ? shares : null,
        price,
        buyAmount,
        sellAmount,
        shareBalance,
        costBasis,
        transactionType,
    };
}

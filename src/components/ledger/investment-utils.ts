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
    transactionType: 'buy' | 'sell' | 'dividend' | 'stock_split' | 'return_of_capital' | 'reinvested_dividend' | 'other';
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
 * Determine the transaction type from the share quantity (simple fallback).
 *
 * GnuCash sign convention for the stock account split (matches desktop):
 *  - Buy:  positive quantity (shares in), positive value (debit)
 *  - Sell: negative quantity (shares out), negative value (credit)
 *  - Dividend / other: zero quantity
 */
function classifyTransaction(shares: number): 'buy' | 'sell' | 'dividend' | 'other' {
    if (shares > 0) return 'buy';
    if (shares < 0) return 'sell';
    return 'dividend';
}

// ── Account name pattern helpers ─────────────────────────────────────

function isIncomeAccount(name: string): boolean {
    return name.startsWith('Income:') || name === 'Income';
}

function isTradingAccount(name: string): boolean {
    return name.startsWith('Trading:') || name === 'Trading';
}

function isExpenseAccount(name: string): boolean {
    return name.startsWith('Expenses:') || name.startsWith('Expense:') || name === 'Expenses' || name === 'Expense';
}

function isCashLikeAccount(name: string): boolean {
    // Not Trading, not Income, not Expense → likely a bank/cash/asset counterparty
    return !isTradingAccount(name) && !isIncomeAccount(name) && !isExpenseAccount(name);
}

/**
 * Enhanced investment transaction classifier that examines the full split
 * array to distinguish between buys, sells, dividends, stock splits,
 * reinvested dividends (DRIPs), and return of capital.
 *
 * Detection order (most specific first):
 *  1. Stock split — shares changed, no cash movement
 *  2. Reinvested dividend — shares added, income source, no cash outflow
 *  3. Buy — shares added, cash outflow
 *  4. Sell — shares removed, cash inflow
 *  5. Return of capital — 0 shares, value present, income source
 *  6. Dividend — 0 shares, income source, cash to bank
 *  7. Other
 */
function classifyInvestmentTransaction(
    shares: number,
    value: number,
    splits: Split[],
    accountGuid: string,
): InvestmentRowData['transactionType'] {
    // Categorise the other splits (everything except the investment account itself)
    const otherSplits = splits.filter(s => s.account_guid !== accountGuid);

    const hasIncomeSplit = otherSplits.some(s => {
        const name = s.account_fullname ?? s.account_name ?? '';
        return isIncomeAccount(name);
    });

    const hasCashSplit = otherSplits.some(s => {
        const name = s.account_fullname ?? s.account_name ?? '';
        const val = Math.abs(parseFloat(s.value_decimal ?? '0'));
        return isCashLikeAccount(name) && val > 0;
    });

    // Check if all other splits are either Trading accounts or have zero value
    const allOtherAreTradingOrZero = otherSplits.every(s => {
        const name = s.account_fullname ?? s.account_name ?? '';
        const val = Math.abs(parseFloat(s.value_decimal ?? '0'));
        return isTradingAccount(name) || val === 0;
    });

    const hasShares = shares !== 0;
    const absValue = Math.abs(value);

    // 1. Stock split: shares changed but no monetary movement
    if (hasShares && allOtherAreTradingOrZero && otherSplits.length >= 0) {
        // For a true stock split, there should be no real cash flow.
        // Trading splits may exist for multi-currency but carry no economic value.
        // Also check the investment split's own value is zero (pure quantity change).
        if (absValue === 0 || (allOtherAreTradingOrZero && !hasCashSplit && !hasIncomeSplit)) {
            return 'stock_split';
        }
    }

    // 2. Reinvested dividend (DRIP): shares added, income source, no cash movement
    if (shares > 0 && hasIncomeSplit && !hasCashSplit) {
        return 'reinvested_dividend';
    }

    // 3. Buy: shares added, cash outflow
    if (shares > 0 && hasCashSplit) {
        return 'buy';
    }

    // 4. Sell: shares removed, cash inflow
    if (shares < 0 && hasCashSplit) {
        return 'sell';
    }

    // 5. Return of capital: zero shares, sell value present, income source
    if (!hasShares && absValue > 0 && hasIncomeSplit) {
        return 'return_of_capital';
    }

    // 6. Dividend: zero shares, income source, cash to bank
    if (!hasShares && hasIncomeSplit && hasCashSplit) {
        return 'dividend';
    }

    // 7. Fallback: use simple classifier for anything else
    if (!hasShares) {
        // Zero shares with cash but no income → could be fees, etc.
        return hasCashSplit ? 'dividend' : 'other';
    }

    // Shares changed but doesn't match any known pattern
    return shares > 0 ? 'buy' : 'sell';
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

    // Buy: shares > 0 (asset value positive in GnuCash, we show absolute)
    // Sell: shares < 0 (asset value negative in GnuCash, we show absolute)
    const buyAmount = shares > 0 ? absValue : null;
    const sellAmount = shares < 0 ? absValue : null;

    const transactionType = classifyInvestmentTransaction(shares, value, splits, accountGuid);

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

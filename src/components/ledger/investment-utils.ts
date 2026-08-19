import { AccountTransaction } from '../AccountLedger';
import { Split } from '@/lib/types';
import type { CostBasisCoverage } from '@/lib/holdings-coverage';

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Check if a transaction is truly multi-split, excluding auto-generated
 * Trading: splits which shouldn't count toward the multi-split threshold.
 */
export function isMultiSplitTransaction(splits: Split[] | undefined): boolean {
    const nonTrading = (splits ?? []).filter(s => !isTradingSplit(s));
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
    gainAmount: number | null;   // signed realized gain (+gain / -loss) for realized_gain rows
    shareBalance: number;        // from server-side computation
    costBasis: number;           // from server-side computation
    /**
     * What `costBasis` on THIS row actually describes.
     *
     * The route already computes it per row; the ledger used to drop it and
     * print the number bare, so a basis covering 150 of 200 shares read
     * exactly like one covering all 200. Carried here so the row can render
     * the same coverage mark the holdings surfaces do.
     */
    costBasisCoverage: CostBasisCoverage;
    transactionType: 'buy' | 'sell' | 'dividend' | 'stock_split' | 'return_of_capital' | 'reinvested_dividend' | 'realized_gain' | 'other';
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
    const nonTrading = otherSplits.filter((s) => !isTradingSplit(s));

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
// ── Account classification helpers ───────────────────────────────────
//
// Prefer the split's `account_type` (shipped by the transactions API from the
// DB) — renamed roots or non-English books make name prefixes unreliable.
// The fullname-prefix walk remains only as a fallback for payloads that
// predate the account_type field.

/**
 * Check whether a colon path starts with the given root segment, tolerating
 * one leading placeholder segment (some books nest everything under a
 * book-name account, e.g. "My Finances:Income:...").
 */
function hasRootSegment(name: string, segment: string): boolean {
    const segs = name.split(':');
    return segs[0] === segment || segs[1] === segment;
}

function splitName(s: Split): string {
    return s.account_fullname ?? s.account_name ?? '';
}

function isIncomeSplit(s: Split): boolean {
    if (s.account_type) return s.account_type === 'INCOME';
    return hasRootSegment(splitName(s), 'Income');
}

function isTradingSplit(s: Split): boolean {
    if (s.account_type) return s.account_type === 'TRADING';
    return hasRootSegment(splitName(s), 'Trading');
}

function isExpenseSplit(s: Split): boolean {
    if (s.account_type) return s.account_type === 'EXPENSE';
    const name = splitName(s);
    return hasRootSegment(name, 'Expenses') || hasRootSegment(name, 'Expense');
}

function isCashLikeSplit(s: Split): boolean {
    // Not Trading, not Income, not Expense → likely a bank/cash/asset counterparty
    return !isTradingSplit(s) && !isIncomeSplit(s) && !isExpenseSplit(s);
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

    const hasIncomeSplit = otherSplits.some(s => isIncomeSplit(s));

    const hasCashSplit = otherSplits.some(s => {
        const val = Math.abs(parseFloat(s.value_decimal ?? '0'));
        return isCashLikeSplit(s) && val > 0;
    });

    // Check if all other splits are either Trading accounts or have zero value
    const allOtherAreTradingOrZero = otherSplits.every(s => {
        const val = Math.abs(parseFloat(s.value_decimal ?? '0'));
        return isTradingSplit(s) || val === 0;
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

    // 5. Realized gain/loss: zero shares, value present, offset entirely by an
    //    income (capital gains) account with no cash movement. This is the
    //    double-balance gains transaction GnuCash creates when closing a lot
    //    (and what our lot-scrub engine generates).
    if (!hasShares && absValue > 0 && hasIncomeSplit && !hasCashSplit) {
        return 'realized_gain';
    }

    // 6. Return of capital: zero shares, value present, cash received with no
    //    income offset (GnuCash ROC reduces basis: stock -value, cash +value).
    if (!hasShares && absValue > 0 && hasCashSplit && !hasIncomeSplit) {
        return 'return_of_capital';
    }

    // 7. Dividend: zero shares, income source, cash to bank
    if (!hasShares && hasIncomeSplit && hasCashSplit) {
        return 'dividend';
    }

    // 8. Fallback: use simple classifier for anything else
    if (!hasShares) {
        // Zero shares with cash but no income → could be fees, etc.
        return hasCashSplit ? 'dividend' : 'other';
    }

    // Shares changed but doesn't match any known pattern
    return shares > 0 ? 'buy' : 'sell';
}

/**
 * Read a row's tri-state `cost_basis_uncovered_shares` into a coverage.
 *
 * The three API answers are three DIFFERENT statements and must not collapse:
 *   absent / null  -> unknown: the route could not determine coverage (an
 *                     oversell, or carry-over tracing switched off).
 *   '0'            -> complete: the basis describes every share on the row.
 *   > 0            -> partial: it describes `shareBalance - uncovered` of them.
 *
 * `Number(null) === 0` is exactly the coercion that would turn the first case
 * into the second, so the null check comes before any arithmetic.
 */
export function costBasisCoverageForRow(
    shareBalance: number,
    uncoveredShares: string | null | undefined,
): CostBasisCoverage {
    if (uncoveredShares == null) {
        return {
            status: 'unknown',
            reason: 'Cost-basis coverage for this row could not be determined.',
        };
    }
    const uncovered = parseFloat(uncoveredShares);
    if (!Number.isFinite(uncovered)) {
        return {
            status: 'unknown',
            reason: 'Cost-basis coverage for this row could not be determined.',
        };
    }
    // Clamp rather than trust: a covered count cannot be negative, and a row
    // whose uncovered count exceeds its balance has nothing covered.
    const covered = Math.max(0, shareBalance - uncovered);
    return uncovered > 0
        ? { status: 'partial', coveredShares: covered, uncoveredShares: uncovered, warnings: [] }
        : { status: 'complete', coveredShares: covered };
}

/**
 * Transform an AccountTransaction into an InvestmentRowData for display
 * in the investment ledger view.
 *
 * @param tx - The transaction row from the API (includes splits, share_balance, cost_basis)
 * @param accountGuid - The GUID of the investment account being viewed
 */
export function transformToInvestmentRow(
    tx: AccountTransaction & {
        share_balance?: string;
        cost_basis?: string;
        cost_basis_uncovered_shares?: string | null;
    },
    accountGuid: string,
): InvestmentRowData {
    const splits = tx.splits ?? [];

    // SUM the account's splits rather than reading only the first one: the
    // scrub engine sub-splits a multi-lot sell/transfer into several
    // same-account splits, and the row must show the whole trade (same
    // summation the transactions API uses for the running balance).
    const accountSplits = splits.filter((s) => s.account_guid === accountGuid);

    const shares = accountSplits.reduce(
        (sum, s) => sum + parseFloat(s.quantity_decimal ?? '0'),
        0,
    );

    const value = accountSplits.reduce(
        (sum, s) => sum + parseFloat(s.value_decimal ?? '0'),
        0,
    );

    const absValue = Math.abs(value);
    const absShares = Math.abs(shares);

    // Derive per-share price when there are shares
    const price = absShares !== 0 ? absValue / absShares : null;

    // Buy: shares > 0 (asset value positive in GnuCash, we show absolute)
    // Sell: shares < 0 (asset value negative in GnuCash, we show absolute)
    const buyAmount = shares > 0 ? absValue : null;
    const sellAmount = shares < 0 ? absValue : null;

    const transactionType = classifyInvestmentTransaction(shares, value, splits, accountGuid);

    // For realized gain/loss rows the account split's value IS the gain:
    // the lot-close gains split is valued +gain (loss = negative).
    const gainAmount = transactionType === 'realized_gain' ? value : null;

    // Transfer account info
    const transferSplit = findTransferSplit(splits, accountGuid);
    const transferAccount = transferSplit?.account_fullname
        ?? transferSplit?.account_name
        ?? '';
    const transferAccountGuid = transferSplit?.account_guid ?? '';

    // Server-provided running totals
    const shareBalance = parseFloat(tx.share_balance ?? '0');
    const costBasis = parseFloat(tx.cost_basis ?? '0');
    const costBasisCoverage = costBasisCoverageForRow(
        shareBalance,
        tx.cost_basis_uncovered_shares,
    );

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
        gainAmount,
        shareBalance,
        costBasis,
        costBasisCoverage,
        transactionType,
    };
}

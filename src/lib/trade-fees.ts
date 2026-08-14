/**
 * Trade Fees — brokerage commissions and fees attached to a trade
 *
 * GnuCash records a brokerage commission the conventional way: as a separate
 * EXPENSE split inside the SAME transaction as the trade. Nothing about the
 * fee is stored on the security split itself, so a lot's splits alone cannot
 * see it — which is why basis and proceeds computed purely from lot splits
 * silently omit every commission.
 *
 * IRS treatment (Pub. 550): a commission paid to ACQUIRE a security is
 * capitalized into its basis; a commission paid to DISPOSE of one reduces the
 * amount realized. Both push the reported gain DOWN.
 *
 * ── THE INVARIANT ─────────────────────────────────────────────────────────
 * A charge is treated EITHER as a deductible expense OR as capitalized into
 * basis — never both, never neither. Counting it twice understates taxable
 * income, which is worse than the overstatement this module exists to fix.
 * Two rules enforce it:
 *
 *   1. CLASSIFY, don't assume. "It posts to an EXPENSE account on a trade" is
 *      NOT enough to call something a commission. Accrued interest on a bond
 *      purchase is an offset to interest income, not basis. Margin interest,
 *      foreign tax withheld on a reinvested dividend and any other bundled
 *      charge are likewise not basis. Only accounts whose path positively
 *      reads as a commission/fee — and whose path does not read as interest,
 *      tax or another non-fee charge — are capitalized. Anything unrecognized
 *      is LEFT OUT and reported as a warning: omitting a fee is the smaller,
 *      already-shipped error; capitalizing accrued interest is a new one.
 *
 *   2. DEFER TO AN EXPLICIT DEDUCTION — but only to a REAL one. If the fee's
 *      account (or an ancestor) is mapped to a category that actually LOWERS
 *      taxable income, the estimator is already claiming that split as a
 *      deduction (aggregateBookTaxData in @/lib/tax/book-income sums every
 *      split of a mapped account), so capitalizing it too would let one dollar
 *      reduce taxable income twice. Those fees are NOT capitalized, and a
 *      warning says so rather than leaving the user to wonder why their basis
 *      did not move.
 *
 *      "Mapped to anything but 'exclude'" is NOT that test, and using it would
 *      re-open the very omission this module fixes: a commission mapped to a
 *      PAYMENT category (1040-ES vouchers, federal withholding) or an
 *      INFORMATIONAL one (529/ESA, FICA, education) buys no deduction, so
 *      refusing to capitalize it would leave the fee counted NOWHERE. The
 *      predicate is reducesTaxableIncome (@/lib/tax/deduction-categories),
 *      derived from what buildFederalInputsFromBookData actually consumes.
 *
 * ── MECHANICS ─────────────────────────────────────────────────────────────
 *  - MULTIPLE FEES: every eligible expense split of the ticket sums, so
 *    commission + SEC fee + exchange fee are handled naturally. No naming
 *    convention or app-written marker is required, so DESKTOP-IMPORTED books
 *    work the same as trades entered here.
 *  - CURRENCY: GnuCash `value` is ALWAYS denominated in the transaction's
 *    currency (only `quantity` is in the account's own commodity). Summing
 *    values therefore mixes nothing: a fee booked to a EUR expense account
 *    inside a USD trade contributes its USD value, the same currency the
 *    security split's value is in.
 *  - ALLOCATION: a scrubbed sell is split into one security split PER LOT
 *    inside a single transaction, so the fee is shared across them rather
 *    than charged in full to each. Shares are computed in whole CENTS by the
 *    largest-remainder method, so the allocated amounts sum to the ticket fee
 *    EXACTLY — no floating-point residue, and no share can go negative.
 *  - MIXED AND UNVALUED TICKETS: a transaction holding security splits in
 *    BOTH directions (an in-kind transfer, or a genuine same-ticket
 *    buy-and-sell) gives no way to infer how much of one fee belongs to the
 *    acquisition versus the disposal, and a ticket whose security splits
 *    carry no value gives no weights at all. Neither is allocated; both are
 *    reported. This is also what keeps an ACAT/transfer fee from leaking into
 *    the basis of the destination leg of an in-kind transfer.
 *
 * The classification and allocation core is PURE so it can be unit-tested;
 * the DB read lives in loadTradeFees at the bottom.
 */

import { toDecimalNumber } from './gnucash';
import { reducesTaxableIncome } from './tax/deduction-categories';

/** Fee amount allocated to a security split, keyed by that split's GUID. */
export type TradeFeeBySplit = ReadonlyMap<string, number>;

/** Shared empty lookup so callers can default without allocating. */
export const NO_TRADE_FEES: TradeFeeBySplit = new Map();

/** One split of a trade transaction, reduced to what fee allocation needs. */
export interface FeeAllocationSplit {
    guid: string;
    txGuid: string;
    accountGuid: string;
    /** GnuCash account_type of the split's account (e.g. STOCK, EXPENSE). */
    accountType: string;
    /** Full account path when known ("Expenses:Investments:Commissions"). */
    accountPath: string;
    /** value_decimal — always in the TRANSACTION's currency. */
    value: number;
    /** quantity_decimal — in the account's own commodity. */
    quantity: number;
    /** Transaction description, used only to make warnings actionable. */
    txDescription?: string;
    /** Transaction post date (any ISO-ish form), likewise for warnings. */
    txDate?: string;
}

export interface TradeFeeAllocation {
    /** Security-split GUID -> fee capitalized into / netted against it. */
    fees: Map<string, number>;
    /**
     * Charges deliberately NOT applied to basis or proceeds, each explaining
     * why. Surfaced on the capital-gains report so a skipped fee is visible
     * rather than silent.
     */
    warnings: string[];
}

/** Account types whose splits carry the security side of a trade. */
const SECURITY_ACCOUNT_TYPES = new Set(['STOCK', 'MUTUAL']);
const QTY_EPS = 1e-9;
const CENT_EPS = 0.005;
/** Cap on emitted warnings so one bad book cannot flood the report. */
const MAX_WARNINGS = 25;

/**
 * Account paths that are NEVER a capitalizable trade fee, checked FIRST so a
 * path like "Expenses:Investments:Accrued Interest" cannot be rescued by the
 * word "Investments". Deny always beats allow.
 *
 * Accrued interest paid on a bond purchase is an offset to interest income;
 * margin interest is investment interest expense; foreign tax withheld on a
 * reinvested dividend is a tax credit/deduction item. None of them are basis.
 */
const NOT_A_FEE = [
    /\binterest\b/,
    /\baccrued\b/,
    /\bmargin\b/,
    /\btaxe?s?\b/,
    /\bwithheld\b/,
    /\bwithholding\b/,
    /\bpenalt/,
    /\bdividends?\b/,
    /\bdistributions?\b/,
    /\bdonations?\b/,
    /\bcharit/,
    /\bpremiums?\b/,
    /\bloans?\b/,
];

/**
 * Account paths that positively read as a brokerage trade cost. Deliberately
 * narrow: an unrecognized account is reported, not guessed at.
 */
const IS_A_FEE = [
    /\bcommissions?\b/,
    /\bfees?\b/,
    /\bbrokerage\b/,
];

export type FeeClassification = 'fee' | 'not-fee' | 'ambiguous' | 'unrecognized';

/**
 * Classify an expense account by its path. PURE, and intentionally the ONLY
 * classifier — account_type alone is not evidence of a commission.
 *
 * A path matching BOTH lists ("Brokerage Premium", "Fees:Transaction Tax") is
 * 'ambiguous' rather than a silent deny: deny still wins the outcome, but the
 * caller reports it, because that is the one refusal where a genuine fee could
 * be dropped with no signal to the user at all.
 */
export function classifyFeeAccount(accountPath: string): FeeClassification {
    const path = accountPath.toLowerCase();
    const denied = NOT_A_FEE.some(rx => rx.test(path));
    const allowed = IS_A_FEE.some(rx => rx.test(path));
    if (denied && allowed) return 'ambiguous';
    if (denied) return 'not-fee';
    if (allowed) return 'fee';
    return 'unrecognized';
}

/**
 * Split the given cent total across `weights` so the parts sum to the total
 * EXACTLY (largest-remainder apportionment). Every part is non-negative for a
 * non-negative total, and the residual lands on the largest fractional
 * remainders rather than being dropped. PURE.
 */
export function apportionCents(totalCents: number, weights: number[]): number[] {
    if (weights.length === 0) return [];
    const sign = totalCents < 0 ? -1 : 1;
    const magnitude = Math.abs(totalCents);
    const weightSum = weights.reduce((sum, w) => sum + w, 0);

    if (weightSum <= 0) {
        // No usable weights — spread evenly, residual to the leading parts.
        const base = Math.floor(magnitude / weights.length);
        const parts = weights.map(() => base);
        for (let i = 0; i < magnitude - base * weights.length; i++) parts[i] += 1;
        return parts.map(p => p * sign);
    }

    const exact = weights.map(w => (magnitude * w) / weightSum);
    const parts = exact.map(e => Math.floor(e));
    let residual = magnitude - parts.reduce((sum, p) => sum + p, 0);
    const order = exact
        .map((e, i) => ({ i, frac: e - Math.floor(e) }))
        .sort((a, b) => (b.frac - a.frac) || (a.i - b.i));
    for (let k = 0; residual > 0; k = (k + 1) % order.length, residual--) {
        parts[order[k].i] += 1;
    }
    return parts.map(p => p * sign);
}

/** `2024-03-15 Buy 10 VTI` style label for a warning. */
function txLabel(splits: FeeAllocationSplit[]): string {
    const dated = splits.find(s => s.txDate)?.txDate;
    const described = splits.find(s => s.txDescription)?.txDescription;
    const day = dated ? dated.slice(0, 10) : '';
    return [day, described].filter(Boolean).join(' ') || splits[0].txGuid;
}

/**
 * Allocate each transaction's eligible fees across that transaction's
 * security splits. PURE.
 *
 * `deductibleAccounts` names accounts the tax estimator already deducts (see
 * the invariant at the top of this file); fees posting there are reported and
 * NOT capitalized.
 */
export function allocateTradeFees(
    splits: FeeAllocationSplit[],
    deductibleAccounts: ReadonlySet<string> = new Set(),
): TradeFeeAllocation {
    const byTx = new Map<string, FeeAllocationSplit[]>();
    for (const split of splits) {
        const list = byTx.get(split.txGuid);
        if (list) list.push(split);
        else byTx.set(split.txGuid, [split]);
    }

    const fees = new Map<string, number>();
    const warnings = new Set<string>();
    // Every refusal in this module relies on its warning to avoid being a
    // silent under-report, so the cap must not silently swallow the overflow
    // either — the suppressed count is reported alongside.
    let suppressed = 0;
    const warn = (message: string) => {
        if (warnings.has(message)) return;
        if (warnings.size >= MAX_WARNINGS) {
            suppressed += 1;
            return;
        }
        warnings.add(message);
    };

    for (const txSplits of byTx.values()) {
        const expenses = txSplits.filter(
            s => s.accountType === 'EXPENSE' && Math.abs(s.value) >= CENT_EPS,
        );
        if (expenses.length === 0) continue;

        // Rule 1 (classify) + rule 2 (defer to an explicit deduction).
        const eligible: FeeAllocationSplit[] = [];
        for (const expense of expenses) {
            const kind = classifyFeeAccount(expense.accountPath);
            if (kind === 'not-fee') continue; // confidently not basis; stay silent
            if (kind === 'ambiguous') {
                warn(
                    `${txLabel(txSplits)}: $${Math.abs(expense.value).toFixed(2)} posted to `
                    + `"${expense.accountPath}" was NOT added to cost basis — the account name `
                    + 'reads as BOTH a trade fee and a non-fee charge (interest, tax or '
                    + 'similar), so it cannot be classified safely. Split or rename the account '
                    + 'if part of it is a commission.',
                );
                continue;
            }
            if (kind === 'unrecognized') {
                warn(
                    `${txLabel(txSplits)}: $${Math.abs(expense.value).toFixed(2)} posted to `
                    + `"${expense.accountPath}" was NOT added to cost basis — the account is not `
                    + 'recognized as a commission or trading fee. Rename it if it is one.',
                );
                continue;
            }
            if (deductibleAccounts.has(expense.accountGuid)) {
                warn(
                    `${txLabel(txSplits)}: the $${Math.abs(expense.value).toFixed(2)} fee in `
                    + `"${expense.accountPath}" is mapped to a tax category that already deducts `
                    + 'it from taxable income, so it was NOT also added to cost basis. Remove the '
                    + 'tax mapping if you would rather capitalize it.',
                );
                continue;
            }
            eligible.push(expense);
        }

        const totalFee = eligible.reduce((sum, s) => sum + s.value, 0);
        if (Math.abs(totalFee) < CENT_EPS) continue;

        // Zero-quantity splits (scrub gains offsets, return-of-capital) are
        // not acquisitions or disposals and take no share of the fee.
        const securitySplits = txSplits.filter(
            s => SECURITY_ACCOUNT_TYPES.has(s.accountType) && Math.abs(s.quantity) > QTY_EPS,
        );
        if (securitySplits.length === 0) continue; // e.g. a dividend's fee — stays an expense

        // Mixed direction: an in-kind transfer (shares out of one account and
        // into another) or a same-ticket buy AND sell. Nothing in the book
        // says how the single fee divides between acquisition and disposal,
        // so it is reported instead of guessed at.
        const acquires = securitySplits.some(s => s.quantity > 0);
        const disposes = securitySplits.some(s => s.quantity < 0);
        if (acquires && disposes) {
            warn(
                `${txLabel(txSplits)}: $${Math.abs(totalFee).toFixed(2)} of fees could not be `
                + 'attributed — this transaction both adds and removes shares (an in-kind '
                + 'transfer, or a combined buy/sell), so there is no way to tell how much of '
                + 'the fee belongs to the purchase versus the sale. Split it into separate '
                + 'transactions to have it counted.',
            );
            continue;
        }

        const weights = securitySplits.map(s => Math.abs(s.value));
        if (weights.reduce((sum, w) => sum + w, 0) < CENT_EPS) {
            warn(
                `${txLabel(txSplits)}: $${Math.abs(totalFee).toFixed(2)} of fees could not be `
                + 'attributed — the security splits carry no value (an unpriced or in-kind '
                + 'movement), so there is nothing to apportion the fee against.',
            );
            continue;
        }

        // Whole cents, largest remainder: the parts sum to the ticket fee
        // exactly, so a fee is never partly lost or partly duplicated.
        const cents = apportionCents(Math.round(totalFee * 100), weights);
        securitySplits.forEach((split, i) => {
            if (cents[i] === 0) return;
            fees.set(split.guid, (fees.get(split.guid) ?? 0) + cents[i] / 100);
        });
    }

    const reported = [...warnings];
    if (suppressed > 0) {
        reported.push(
            `${suppressed} further trade-fee notice${suppressed === 1 ? ' was' : 's were'} `
            + `suppressed (only the first ${MAX_WARNINGS} are listed). Resolve these and re-run `
            + 'to see the rest.',
        );
    }
    return { fees, warnings: reported };
}

/** Chunk size for the tx_guid IN list; keeps the query planner and the
 *  Postgres parameter budget comfortable on large books. */
const TX_CHUNK = 500;

/**
 * Accounts whose mapping means the estimator ALREADY deducts their splits
 * from taxable income, so their fees must not also be capitalized. PURE.
 *
 * Payment, income, informational and 'exclude' mappings are deliberately NOT
 * here: none of them lower taxable income, so a fee posted to such an account
 * still needs its basis adjustment or it would be counted nowhere at all.
 */
export function deductibleFeeAccounts(
    effectiveTaxMappings: ReadonlyMap<string, string> | undefined,
): Set<string> {
    const deductible = new Set<string>();
    for (const [guid, category] of effectiveTaxMappings ?? []) {
        if (reducesTaxableIncome(category)) deductible.add(guid);
    }
    return deductible;
}

export interface LoadTradeFeesOptions {
    /**
     * Effective account -> tax-category map (already expanded to descendants,
     * exactly as the estimator resolves it). Only mappings that actually
     * reduce taxable income suppress capitalization — see
     * deductibleFeeAccounts and the invariant at the top of this file.
     */
    effectiveTaxMappings?: ReadonlyMap<string, string>;
    /** Account GUID -> full path, for classification and warning text. */
    accountPaths?: ReadonlyMap<string, string>;
}

/**
 * Load the commission/fee attributable to each security split of the given
 * transactions. Impure (DB); the arithmetic lives in allocateTradeFees.
 */
export async function loadTradeFees(
    txGuids: string[],
    options: LoadTradeFeesOptions = {},
): Promise<TradeFeeAllocation> {
    const unique = [...new Set(txGuids)].filter(Boolean);
    if (unique.length === 0) return { fees: new Map(), warnings: [] };

    const prisma = (await import('./prisma')).default;
    const { effectiveTaxMappings, accountPaths } = options;

    const deductibleAccounts = deductibleFeeAccounts(effectiveTaxMappings);

    const rows: FeeAllocationSplit[] = [];
    for (let offset = 0; offset < unique.length; offset += TX_CHUNK) {
        const chunk = unique.slice(offset, offset + TX_CHUNK);
        const splitRows = await prisma.splits.findMany({
            where: { tx_guid: { in: chunk } },
            select: {
                guid: true,
                tx_guid: true,
                account_guid: true,
                value_num: true,
                value_denom: true,
                quantity_num: true,
                quantity_denom: true,
                account: { select: { name: true, account_type: true } },
                transaction: { select: { post_date: true, description: true } },
            },
        });
        for (const row of splitRows) {
            rows.push({
                guid: row.guid,
                txGuid: row.tx_guid,
                accountGuid: row.account_guid,
                accountType: row.account?.account_type ?? '',
                accountPath: accountPaths?.get(row.account_guid)
                    ?? row.account?.name
                    ?? '',
                value: toDecimalNumber(row.value_num, row.value_denom),
                quantity: toDecimalNumber(row.quantity_num, row.quantity_denom),
                txDescription: row.transaction?.description ?? undefined,
                txDate: row.transaction?.post_date?.toISOString(),
            });
        }
    }

    return allocateTradeFees(rows, deductibleAccounts);
}

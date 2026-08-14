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
 * A securities trade fee is ALWAYS capitalized into basis and NEVER deducted.
 * Not a heuristic — that is the treatment: a commission is a cost of
 * acquiring or disposing of the security under the basis rules, and
 * investment expenses are not deductible as miscellaneous itemized deductions
 * in the years this app models.
 *
 * The rule is UNCONDITIONAL on purpose. An earlier design tried to defer to
 * an existing deduction whenever the fee's account was tax-mapped, but
 * deductibility is conditional in ways this module cannot see: SALT is
 * capped, medical has an AGI floor, charitable has a floor, itemized
 * deductions only apply when they beat the standard deduction, and the
 * contribution categories use the book total only as a fallback behind the
 * retirement classifier. A commission mapped to state_withholding for a filer
 * taking the standard deduction was therefore deducted NOWHERE and
 * capitalized nowhere either. The capital-gains path has no filing status, no
 * AGI, no itemization election and no classifier state, so it can never
 * decide that locally — and it no longer tries.
 *
 * Two rules give the invariant its teeth:
 *
 *   1. CLASSIFY, don't assume. "It posts to an EXPENSE account on a trade" is
 *      NOT enough to call something a commission. Accrued interest on a bond
 *      purchase is an offset to interest income, not basis. Margin interest,
 *      foreign tax withheld on a reinvested dividend and any other bundled
 *      charge are likewise not basis. Only accounts whose path positively
 *      reads as a commission/fee — and whose path does not read as interest,
 *      tax or another non-fee charge — are capitalized. Anything unrecognized
 *      or ambiguous is LEFT EXACTLY AS IT IS TODAY (neither capitalized nor
 *      withheld from any deduction) and reported as a warning.
 *
 *   2. WHAT IS CAPITALIZED IS EXCLUDED FROM THE DEDUCTION SIDE, and only
 *      that. capitalizedFeeSplitGuids reports precisely the expense splits
 *      whose value reached a security split's basis; aggregateBookTaxData
 *      (@/lib/tax/book-income) drops exactly those GUIDs from its category
 *      sums. Because the two sets are the SAME set by construction, a dollar
 *      cannot be counted twice (capitalized and deducted) or zero times
 *      (excluded from deductions but never capitalized) — including in books
 *      with no lot assignment, where nothing is capitalized and so nothing is
 *      excluded.
 *
 * A tax mapping on a classified fee account is now a user data error that
 * this module neutralizes rather than obeys, so it is reported.
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
     * GUIDs of the EXPENSE splits whose value actually reached a security
     * split's basis above. The tax aggregation excludes exactly these from
     * its deduction category sums — same set, so never both and never
     * neither. A fee that was classified but could not be attributed (mixed
     * ticket, unvalued ticket, no security leg) is NOT here: nothing was
     * capitalized, so nothing may be withheld from the deduction side.
     */
    capitalizedFeeSplitGuids: string[];
    /**
     * Charges deliberately NOT applied to basis or proceeds, plus tax
     * mappings that were neutralized, each explaining why. Surfaced on the
     * capital-gains report so a skipped fee is visible rather than silent.
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
 * Allocate each transaction's classified fees across that transaction's
 * security splits. PURE.
 *
 * `taxMappedAccounts` names fee accounts carrying a tax-category mapping. It
 * does NOT change the outcome — a classified trade fee is capitalized either
 * way — it only triggers the warning that the mapping is being neutralized.
 */
export function allocateTradeFees(
    splits: FeeAllocationSplit[],
    taxMappedAccounts: ReadonlySet<string> = new Set(),
): TradeFeeAllocation {
    const byTx = new Map<string, FeeAllocationSplit[]>();
    for (const split of splits) {
        const list = byTx.get(split.txGuid);
        if (list) list.push(split);
        else byTx.set(split.txGuid, [split]);
    }

    const fees = new Map<string, number>();
    const capitalizedFeeSplitGuids: string[] = [];
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

        // Rule 1: only confidently-classified fees are acted on at all.
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
            if (taxMappedAccounts.has(expense.accountGuid)) {
                // Capitalized anyway — a trade fee is a cost of the security,
                // never a deduction — but the mapping is a data error, and
                // the split is being held out of the tax categories it feeds.
                warn(
                    `${txLabel(txSplits)}: the $${Math.abs(expense.value).toFixed(2)} fee in `
                    + `"${expense.accountPath}" was added to cost basis, and this split is `
                    + 'therefore EXCLUDED from the tax category its account is mapped to — a '
                    + 'trade commission is part of the security\'s cost, not a deduction. Remap '
                    + 'the account, or split the non-fee charges out of it.',
                );
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
        // Recorded ONLY here, past every guard: these are the splits whose
        // value actually landed in basis, and therefore exactly the splits
        // the deduction side must drop.
        for (const expense of eligible) capitalizedFeeSplitGuids.push(expense.guid);
    }

    const reported = [...warnings];
    if (suppressed > 0) {
        reported.push(
            `${suppressed} further trade-fee notice${suppressed === 1 ? ' was' : 's were'} `
            + `suppressed (only the first ${MAX_WARNINGS} are listed). Resolve these and re-run `
            + 'to see the rest.',
        );
    }
    return { fees, capitalizedFeeSplitGuids, warnings: reported };
}

/** Chunk size for the tx_guid IN list; keeps the query planner and the
 *  Postgres parameter budget comfortable on large books. */
const TX_CHUNK = 500;

/**
 * Accounts carrying a tax-category mapping that the estimator would act on.
 * Used ONLY to warn that such a mapping is being neutralized on a trade fee —
 * never to decide whether to capitalize. PURE.
 *
 * 'exclude' is left out because it asks the estimator to ignore the account
 * anyway, so nothing is being overridden and there is nothing to report.
 */
export function taxMappedFeeAccounts(
    effectiveTaxMappings: ReadonlyMap<string, string> | undefined,
): Set<string> {
    const mapped = new Set<string>();
    for (const [guid, category] of effectiveTaxMappings ?? []) {
        if (category && category !== 'exclude') mapped.add(guid);
    }
    return mapped;
}

export interface LoadTradeFeesOptions {
    /**
     * Effective account -> tax-category map (already expanded to descendants,
     * exactly as the estimator resolves it). Purely advisory: it selects
     * which neutralized mappings get reported, not what gets capitalized.
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
    if (unique.length === 0) return { fees: new Map(), capitalizedFeeSplitGuids: [], warnings: [] };

    const prisma = (await import('./prisma')).default;
    const { effectiveTaxMappings, accountPaths } = options;

    const mappedFeeAccounts = taxMappedFeeAccounts(effectiveTaxMappings);

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

    return allocateTradeFees(rows, mappedFeeAccounts);
}

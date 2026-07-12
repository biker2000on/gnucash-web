/**
 * Net-Worth Attribution
 *
 * Decomposes the change in net worth over a period into four additive
 * components that sum EXACTLY to the total change (the core invariant):
 *
 *   endNetWorth − startNetWorth ===
 *       savings + marketGains + debtPaydown + other
 *
 * Component semantics (destination-based decomposition):
 *
 *  - savings (net cash flow): the net flow of value into cash-asset and
 *    investment accounts from income/expense activity AND from debt-service
 *    transfers. Per transaction this is −Σ(income + expense split values)
 *    − Σ(liability split values), which by double-entry balance equals the
 *    flow landing in asset/investment accounts from those counterparts.
 *    Interest expense is spending here; principal transferred to a loan
 *    shows as a negative "debt service" line (offset by debtPaydown below).
 *
 *  - marketGains: per priced holding (STOCK/MUTUAL with a non-currency
 *    commodity), endValue − startValue − netInvested — the valuation change
 *    not explained by flows. Values are shares × latest price ≤ date.
 *
 *  - debtPaydown: the liability balance change (Σ liability split values in
 *    the period). Positive = principal reduction. Interest expense never
 *    hits the liability split in GnuCash, so this is principal by structure.
 *
 *  - other: equity postings (opening balances), trading splits, splits in
 *    unclassified/non-book accounts, and rounding. Should be small; it is
 *    reported honestly rather than hidden.
 *
 * Why this is exact: for each balanced transaction, with G = splits landing
 * in cash/investment accounts, L = liability splits, C = income/expense
 * splits and E = everything else, G + L + C + E = 0. So attributing
 * savings = −(C + L) and other = G + C + L (= −E − any missing splits)
 * gives savings + other = G for every transaction. Summing over the period:
 *
 *   Δcash + investmentFlows = savings + other
 *   ΔinvestmentValue        = investmentFlows + marketGains
 *   Δliabilities            = debtPaydown
 *   ⇒ ΔNW = savings + marketGains + debtPaydown + other        (exact)
 *
 * The pure computation (computeNetWorthAttribution) takes pre-loaded data so
 * it is fully unit-testable; DB loading lives in generateNetWorthAttribution.
 *
 * Assumptions / caveats:
 *  - Split values are in the transaction currency, assumed to be the book
 *    base currency. Foreign-currency cash balances are carried at their
 *    accumulated base-currency value (no FX revaluation); any transaction
 *    imbalance from multi-currency entry lands in `other`.
 *  - Hidden accounts are INCLUDED (excluding them would break the invariant
 *    when money moves through them).
 */

import prisma from '@/lib/prisma';
import { toDecimalNumber } from '@/lib/gnucash';
import { getBaseCurrency } from '@/lib/currency';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

const CASH_ASSET_TYPES = ['ASSET', 'BANK', 'CASH', 'RECEIVABLE'];
const LIABILITY_TYPES = ['LIABILITY', 'CREDIT', 'PAYABLE'];
const INVESTMENT_TYPES = ['STOCK', 'MUTUAL'];

export type AttributionGroup =
    | 'cash'
    | 'investment'
    | 'liability'
    | 'income'
    | 'expense'
    | 'other';

export interface AttributionAccountInput {
    guid: string;
    /** Display name — full path when available */
    name: string;
    accountType: string;
    commodityGuid: string | null;
    commodityNamespace: string | null;
}

export interface AttributionSplitInput {
    txGuid: string;
    accountGuid: string;
    postDate: Date;
    /** Split value in transaction (book) currency */
    value: number;
    /** Split quantity in the account commodity (shares for holdings) */
    quantity: number;
}

export interface PricePoint {
    date: Date;
    value: number;
}

export interface AttributionInput {
    accounts: AttributionAccountInput[];
    /** Cumulative value balance strictly before periodStart (cash + liability accounts) */
    startingCashValues: Map<string, number>;
    /** Cumulative share quantity strictly before periodStart (investment accounts) */
    startingInvestmentQty: Map<string, number>;
    /** All splits on book accounts posted within [periodStart, periodEnd] */
    periodSplits: AttributionSplitInput[];
    /** Prices per commodity guid, sorted by date DESCENDING */
    prices: Map<string, PricePoint[]>;
    periodStart: Date;
    periodEnd: Date;
}

export interface AttributionComponents {
    savings: number;
    marketGains: number;
    debtPaydown: number;
    other: number;
}

export type SavingsRowKind = 'income' | 'expense' | 'debt_service';

export interface SavingsDrillRow {
    /** Counterpart account guid; null for the synthetic debt-service row */
    guid: string | null;
    name: string;
    kind: SavingsRowKind;
    amount: number;
}

export interface MarketDrillRow {
    accountGuid: string;
    name: string;
    startValue: number;
    endValue: number;
    netInvested: number;
    gain: number;
}

export interface DebtDrillRow {
    accountGuid: string;
    name: string;
    startBalance: number;
    endBalance: number;
    /** endBalance − startBalance; positive = paydown */
    change: number;
}

export interface OtherDrillRow {
    /** Counterpart account guid; null for the synthetic unbalanced/external row */
    guid: string | null;
    name: string;
    amount: number;
}

export interface AttributionMonth {
    /** YYYY-MM */
    month: string;
    /** e.g. "Jan 2026" */
    label: string;
    savings: number;
    marketGains: number;
    debtPaydown: number;
    other: number;
    /** Sum of the four components (net-worth change in the month) */
    netChange: number;
}

export interface NetWorthAttributionResult {
    /** YYYY-MM-DD */
    startDate: string;
    endDate: string;
    startNetWorth: number;
    endNetWorth: number;
    /** endNetWorth − startNetWorth (in cents-exact display terms) */
    totalChange: number;
    components: AttributionComponents;
    monthly: AttributionMonth[];
    drilldown: {
        savings: SavingsDrillRow[];
        market: MarketDrillRow[];
        debt: DebtDrillRow[];
        other: OtherDrillRow[];
    };
}

export interface NetWorthAttributionData extends NetWorthAttributionResult {
    title: string;
    generatedAt: string;
    currency: string;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function round2(value: number): number {
    const r = Math.round(value * 100) / 100;
    return r === 0 ? 0 : r; // normalize -0
}

export function classifyAccount(a: AttributionAccountInput): AttributionGroup {
    if (
        INVESTMENT_TYPES.includes(a.accountType) &&
        a.commodityGuid &&
        a.commodityNamespace !== 'CURRENCY'
    ) {
        return 'investment';
    }
    if (CASH_ASSET_TYPES.includes(a.accountType) || INVESTMENT_TYPES.includes(a.accountType)) {
        // STOCK/MUTUAL denominated in a currency behaves like cash
        return 'cash';
    }
    if (LIABILITY_TYPES.includes(a.accountType)) return 'liability';
    if (a.accountType === 'INCOME') return 'income';
    if (a.accountType === 'EXPENSE') return 'expense';
    return 'other';
}

/**
 * Latest price at or before `asOf`; falls back to the earliest known price
 * (so a holding whose price history starts mid-period is not valued at 0,
 * which would misattribute its whole value to market gains), else 0.
 * `prices` must be sorted by date DESCENDING.
 */
export function priceAsOf(prices: PricePoint[] | undefined, asOf: Date): number {
    if (!prices || prices.length === 0) return 0;
    for (const p of prices) {
        if (p.date <= asOf) return p.value;
    }
    return prices[prices.length - 1].value;
}

interface MonthBucket {
    month: string; // YYYY-MM
    label: string;
    /** Inclusive end boundary of the bucket (clamped to periodEnd) */
    end: Date;
}

function monthKeyOf(d: Date): string {
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Build the month buckets spanned by [start, end] (UTC). */
export function buildMonthBuckets(start: Date, end: Date): MonthBucket[] {
    const buckets: MonthBucket[] = [];
    let y = start.getUTCFullYear();
    let m = start.getUTCMonth();
    const fmt = new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });

    for (;;) {
        const monthStart = new Date(Date.UTC(y, m, 1));
        const monthEnd = new Date(Date.UTC(y, m + 1, 0, 23, 59, 59, 999));
        buckets.push({
            month: monthKeyOf(monthStart),
            label: fmt.format(monthStart),
            end: monthEnd > end ? end : monthEnd,
        });
        if (monthEnd >= end) break;
        m += 1;
        if (m > 11) { m = 0; y += 1; }
        if (buckets.length > 1200) break; // safety valve
    }
    return buckets;
}

/* ------------------------------------------------------------------ */
/* Pure computation                                                    */
/* ------------------------------------------------------------------ */

const DEBT_SERVICE_LABEL = 'Net debt service (principal & borrowings)';
const UNBALANCED_LABEL = 'Unbalanced / external splits';

export function computeNetWorthAttribution(input: AttributionInput): NetWorthAttributionResult {
    const { accounts, periodStart, periodEnd, prices } = input;

    const groupByGuid = new Map<string, AttributionGroup>();
    const nameByGuid = new Map<string, string>();
    const commodityByGuid = new Map<string, string>();
    for (const a of accounts) {
        groupByGuid.set(a.guid, classifyAccount(a));
        nameByGuid.set(a.guid, a.name);
        if (a.commodityGuid) commodityByGuid.set(a.guid, a.commodityGuid);
    }

    const buckets = buildMonthBuckets(periodStart, periodEnd);
    const bucketIndexByMonth = new Map<string, number>();
    buckets.forEach((b, i) => bucketIndexByMonth.set(b.month, i));

    /* ---- group period splits by transaction ---- */
    const txSplits = new Map<string, AttributionSplitInput[]>();
    for (const s of input.periodSplits) {
        const arr = txSplits.get(s.txGuid);
        if (arr) arr.push(s);
        else txSplits.set(s.txGuid, [s]);
    }

    /* ---- per-bucket raw component accumulators ---- */
    const perBucket = buckets.map(() => ({
        savings: 0,
        debt: 0,
        other: 0,
        market: 0,
    }));

    /* ---- period-level drill-down accumulators ---- */
    const savingsByCounterpart = new Map<string, number>(); // income/expense account guid -> amount
    let debtServiceInSavings = 0;
    const otherByCounterpart = new Map<string, number>();
    let otherUnbalanced = 0;

    /* ---- per-account flow accumulators ---- */
    const cashFlowByAccount = new Map<string, number>();
    const liabFlowByAccount = new Map<string, number>();
    /** investment flows per account per bucket (value terms) */
    const investedByAccountBucket = new Map<string, number[]>();
    /** investment quantity change per account per bucket */
    const qtyDeltaByAccountBucket = new Map<string, number[]>();

    const ensureBuckets = (map: Map<string, number[]>, guid: string): number[] => {
        let arr = map.get(guid);
        if (!arr) {
            arr = new Array(buckets.length).fill(0);
            map.set(guid, arr);
        }
        return arr;
    };

    for (const [, splits] of txSplits) {
        const postDate = splits[0].postDate;
        const bucketIdx = bucketIndexByMonth.get(monthKeyOf(postDate)) ?? -1;
        if (bucketIdx < 0) continue; // outside period (defensive)

        let sumG = 0; // cash + investment
        let sumL = 0; // liability
        let sumC = 0; // income + expense
        let sumE = 0; // fetched "other" group splits

        for (const s of splits) {
            const group = groupByGuid.get(s.accountGuid) ?? 'other';
            switch (group) {
                case 'cash':
                    sumG += s.value;
                    cashFlowByAccount.set(
                        s.accountGuid,
                        (cashFlowByAccount.get(s.accountGuid) ?? 0) + s.value
                    );
                    break;
                case 'investment': {
                    sumG += s.value;
                    ensureBuckets(investedByAccountBucket, s.accountGuid)[bucketIdx] += s.value;
                    ensureBuckets(qtyDeltaByAccountBucket, s.accountGuid)[bucketIdx] += s.quantity;
                    break;
                }
                case 'liability':
                    sumL += s.value;
                    liabFlowByAccount.set(
                        s.accountGuid,
                        (liabFlowByAccount.get(s.accountGuid) ?? 0) + s.value
                    );
                    break;
                case 'income':
                case 'expense':
                    sumC += s.value;
                    savingsByCounterpart.set(
                        s.accountGuid,
                        (savingsByCounterpart.get(s.accountGuid) ?? 0) - s.value
                    );
                    break;
                case 'other':
                    sumE += s.value;
                    otherByCounterpart.set(
                        s.accountGuid,
                        (otherByCounterpart.get(s.accountGuid) ?? 0) - s.value
                    );
                    break;
            }
        }

        // savings = -(C + L); other = G + C + L  (= -E - missing splits)
        const savingsContrib = -(sumC + sumL);
        const otherContrib = sumG + sumC + sumL;

        perBucket[bucketIdx].savings += savingsContrib;
        perBucket[bucketIdx].debt += sumL;
        perBucket[bucketIdx].other += otherContrib;

        debtServiceInSavings += -sumL;
        // Whatever `other` holds beyond the fetched other-group counterparts
        // is transaction imbalance (missing/non-book splits, FX residue).
        otherUnbalanced += otherContrib - (-sumE);
    }

    /* ---- investment valuation per bucket boundary ---- */
    const investmentGuids = accounts
        .filter(a => groupByGuid.get(a.guid) === 'investment')
        .map(a => a.guid);

    const marketRows: MarketDrillRow[] = [];
    let startInvestmentValue = 0;
    let endInvestmentValue = 0;

    for (const guid of investmentGuids) {
        const commodity = commodityByGuid.get(guid);
        const priceHistory = commodity ? prices.get(commodity) : undefined;
        const qtyDeltas = qtyDeltaByAccountBucket.get(guid) ?? new Array(buckets.length).fill(0);
        const invested = investedByAccountBucket.get(guid) ?? new Array(buckets.length).fill(0);

        const startQty = input.startingInvestmentQty.get(guid) ?? 0;
        const startValue = startQty * priceAsOf(priceHistory, periodStart);

        let qty = startQty;
        let prevValue = startValue;
        let totalInvested = 0;
        let totalGain = 0;

        for (let i = 0; i < buckets.length; i++) {
            qty += qtyDeltas[i];
            const boundaryValue = qty * priceAsOf(priceHistory, buckets[i].end);
            const gain = boundaryValue - prevValue - invested[i];
            perBucket[i].market += gain;
            totalGain += gain;
            totalInvested += invested[i];
            prevValue = boundaryValue;
        }

        const endValue = prevValue;
        startInvestmentValue += startValue;
        endInvestmentValue += endValue;

        // Skip holdings with no activity and no value at either boundary
        if (
            Math.abs(startValue) < 0.005 &&
            Math.abs(endValue) < 0.005 &&
            Math.abs(totalInvested) < 0.005
        ) {
            continue;
        }

        marketRows.push({
            accountGuid: guid,
            name: nameByGuid.get(guid) ?? guid,
            startValue: round2(startValue),
            endValue: round2(endValue),
            netInvested: round2(totalInvested),
            gain: round2(totalGain),
        });
    }

    /* ---- start / end net worth ---- */
    let startCashLiab = 0;
    let endCashLiab = 0;
    const debtRows: DebtDrillRow[] = [];

    for (const a of accounts) {
        const group = groupByGuid.get(a.guid);
        if (group !== 'cash' && group !== 'liability') continue;
        const startBal = input.startingCashValues.get(a.guid) ?? 0;
        const flow =
            (group === 'cash'
                ? cashFlowByAccount.get(a.guid)
                : liabFlowByAccount.get(a.guid)) ?? 0;
        const endBal = startBal + flow;
        startCashLiab += startBal;
        endCashLiab += endBal;

        if (group === 'liability' && (Math.abs(startBal) >= 0.005 || Math.abs(flow) >= 0.005)) {
            debtRows.push({
                accountGuid: a.guid,
                name: a.name,
                startBalance: round2(startBal),
                endBalance: round2(endBal),
                change: round2(flow),
            });
        }
    }

    const rawStartNW = startCashLiab + startInvestmentValue;
    const rawEndNW = endCashLiab + endInvestmentValue;

    /* ---- assemble display values (cents-exact invariant) ----
     * Each of startNW, endNW, savings, marketGains, debtPaydown is rounded
     * to cents; `other` is then DEFINED as the remainder so the displayed
     * figures satisfy the invariant exactly. Rounding residue therefore
     * lands in `other`, which is where the spec wants it.
     */
    const startNetWorth = round2(rawStartNW);
    const endNetWorth = round2(rawEndNW);
    const totalChange = round2(endNetWorth - startNetWorth);

    const savings = round2(perBucket.reduce((s, b) => s + b.savings, 0));
    const marketGains = round2(perBucket.reduce((s, b) => s + b.market, 0));
    const debtPaydown = round2(perBucket.reduce((s, b) => s + b.debt, 0));
    const other = round2(totalChange - savings - marketGains - debtPaydown);

    const monthly: AttributionMonth[] = buckets.map((b, i) => {
        const s = round2(perBucket[i].savings);
        const m = round2(perBucket[i].market);
        const d = round2(perBucket[i].debt);
        const o = round2(perBucket[i].other);
        return {
            month: b.month,
            label: b.label,
            savings: s,
            marketGains: m,
            debtPaydown: d,
            other: o,
            netChange: round2(s + m + d + o),
        };
    });

    /* ---- drill-down rows ---- */
    const savingsRows: SavingsDrillRow[] = [];
    for (const [guid, amount] of savingsByCounterpart) {
        if (Math.abs(amount) < 0.005) continue;
        const group = groupByGuid.get(guid);
        savingsRows.push({
            guid,
            name: nameByGuid.get(guid) ?? guid,
            kind: group === 'income' ? 'income' : 'expense',
            amount: round2(amount),
        });
    }
    if (Math.abs(debtServiceInSavings) >= 0.005) {
        savingsRows.push({
            guid: null,
            name: DEBT_SERVICE_LABEL,
            kind: 'debt_service',
            amount: round2(debtServiceInSavings),
        });
    }
    savingsRows.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount) || a.name.localeCompare(b.name));

    const otherRows: OtherDrillRow[] = [];
    for (const [guid, amount] of otherByCounterpart) {
        if (Math.abs(amount) < 0.005) continue;
        otherRows.push({ guid, name: nameByGuid.get(guid) ?? guid, amount: round2(amount) });
    }
    if (Math.abs(otherUnbalanced) >= 0.005) {
        otherRows.push({ guid: null, name: UNBALANCED_LABEL, amount: round2(otherUnbalanced) });
    }
    otherRows.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount) || a.name.localeCompare(b.name));

    marketRows.sort((a, b) => Math.abs(b.gain) - Math.abs(a.gain) || a.name.localeCompare(b.name));
    debtRows.sort((a, b) => Math.abs(b.change) - Math.abs(a.change) || a.name.localeCompare(b.name));

    return {
        startDate: periodStart.toISOString().slice(0, 10),
        endDate: periodEnd.toISOString().slice(0, 10),
        startNetWorth,
        endNetWorth,
        totalChange,
        components: { savings, marketGains, debtPaydown, other },
        monthly,
        drilldown: {
            savings: savingsRows,
            market: marketRows,
            debt: debtRows,
            other: otherRows,
        },
    };
}

/* ------------------------------------------------------------------ */
/* DB loading                                                          */
/* ------------------------------------------------------------------ */

interface AccountRow {
    guid: string;
    account_type: string;
    commodity_guid: string | null;
    namespace: string | null;
    display_name: string;
}

interface BalanceRow {
    account_guid: string;
    value_sum: unknown;
    qty_sum: unknown;
}

interface PeriodSplitRow {
    tx_guid: string;
    account_guid: string;
    post_date: Date;
    value_num: bigint;
    value_denom: bigint;
    quantity_num: bigint;
    quantity_denom: bigint;
}

function toNum(v: unknown): number {
    if (v === null || v === undefined) return 0;
    const n = parseFloat(String(v));
    return Number.isFinite(n) ? n : 0;
}

export interface LoadAttributionOptions {
    bookAccountGuids: string[];
    /** YYYY-MM-DD, inclusive */
    startDate: string;
    /** YYYY-MM-DD, inclusive */
    endDate: string;
}

/** Load everything computeNetWorthAttribution needs from the database. */
export async function loadAttributionInput(
    options: LoadAttributionOptions
): Promise<AttributionInput> {
    const { bookAccountGuids, startDate, endDate } = options;

    const [sy, sm, sd] = startDate.split('-').map(n => parseInt(n, 10));
    const [ey, em, ed] = endDate.split('-').map(n => parseInt(n, 10));
    const periodStart = new Date(Date.UTC(sy, sm - 1, sd, 0, 0, 0, 0));
    const periodEnd = new Date(Date.UTC(ey, em - 1, ed, 23, 59, 59, 999));

    if (bookAccountGuids.length === 0) {
        return {
            accounts: [],
            startingCashValues: new Map(),
            startingInvestmentQty: new Map(),
            periodSplits: [],
            prices: new Map(),
            periodStart,
            periodEnd,
        };
    }

    const accountRows = await prisma.$queryRaw<AccountRow[]>`
        SELECT
            a.guid,
            a.account_type,
            a.commodity_guid,
            c.namespace,
            COALESCE(ah.fullname, a.name) AS display_name
        FROM accounts a
        LEFT JOIN commodities c ON c.guid = a.commodity_guid
        LEFT JOIN account_hierarchy ah ON ah.guid = a.guid
        WHERE a.guid = ANY(${bookAccountGuids})
    `;

    const accounts: AttributionAccountInput[] = accountRows.map(r => ({
        guid: r.guid,
        name: r.display_name,
        accountType: r.account_type,
        commodityGuid: r.commodity_guid,
        commodityNamespace: r.namespace,
    }));

    // Opening balances (value for cash/liability, quantity for holdings)
    const balanceRows = await prisma.$queryRaw<BalanceRow[]>`
        SELECT
            s.account_guid,
            SUM(s.value_num::numeric / NULLIF(s.value_denom, 0))       AS value_sum,
            SUM(s.quantity_num::numeric / NULLIF(s.quantity_denom, 0)) AS qty_sum
        FROM splits s
        JOIN transactions t ON t.guid = s.tx_guid
        WHERE s.account_guid = ANY(${bookAccountGuids})
          AND t.post_date IS NOT NULL
          AND t.post_date < ${periodStart}
        GROUP BY s.account_guid
    `;

    const startingCashValues = new Map<string, number>();
    const startingInvestmentQty = new Map<string, number>();
    for (const row of balanceRows) {
        startingCashValues.set(row.account_guid, toNum(row.value_sum));
        startingInvestmentQty.set(row.account_guid, toNum(row.qty_sum));
    }

    // Period splits
    const splitRows = await prisma.$queryRaw<PeriodSplitRow[]>`
        SELECT
            s.tx_guid,
            s.account_guid,
            t.post_date,
            s.value_num, s.value_denom,
            s.quantity_num, s.quantity_denom
        FROM splits s
        JOIN transactions t ON t.guid = s.tx_guid
        WHERE s.account_guid = ANY(${bookAccountGuids})
          AND t.post_date >= ${periodStart}
          AND t.post_date <= ${periodEnd}
    `;

    const periodSplits: AttributionSplitInput[] = splitRows.map(r => ({
        txGuid: r.tx_guid,
        accountGuid: r.account_guid,
        postDate: r.post_date,
        value: toDecimalNumber(r.value_num, r.value_denom),
        quantity: toDecimalNumber(r.quantity_num, r.quantity_denom),
    }));

    // Prices for the priced holdings
    const investmentCommodityGuids = [
        ...new Set(
            accounts
                .filter(a => classifyAccount(a) === 'investment')
                .map(a => a.commodityGuid)
                .filter((g): g is string => g !== null)
        ),
    ];

    const prices = new Map<string, PricePoint[]>();
    if (investmentCommodityGuids.length > 0) {
        const priceRows = await prisma.prices.findMany({
            where: {
                commodity_guid: { in: investmentCommodityGuids },
                // Skip implied $0 prices from zero-value transfer transactions
                value_num: { gt: 0 },
            },
            select: {
                commodity_guid: true,
                date: true,
                value_num: true,
                value_denom: true,
            },
            orderBy: { date: 'desc' },
        });
        for (const p of priceRows) {
            const arr = prices.get(p.commodity_guid) ?? [];
            arr.push({ date: p.date, value: toDecimalNumber(p.value_num, p.value_denom) });
            prices.set(p.commodity_guid, arr);
        }
    }

    return {
        accounts,
        startingCashValues,
        startingInvestmentQty,
        periodSplits,
        prices,
        periodStart,
        periodEnd,
    };
}

/** Full DB-bound report generation, book-scoped. */
export async function generateNetWorthAttribution(
    options: LoadAttributionOptions
): Promise<NetWorthAttributionData> {
    const input = await loadAttributionInput(options);
    const result = computeNetWorthAttribution(input);
    const baseCurrency = await getBaseCurrency();

    return {
        title: 'Net-Worth Attribution',
        generatedAt: new Date().toISOString(),
        currency: baseCurrency?.mnemonic ?? 'USD',
        ...result,
    };
}

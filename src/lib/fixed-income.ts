/**
 * Fixed Income (Bond / CD / Treasury / I-Bond) Ladder Engine
 *
 * A fixed-income position is an account the user tags with metadata
 * (kind, face value, coupon rate, purchase/maturity dates, callable flag)
 * stored in a lazily-created table `gnucash_web_fixed_income` keyed by
 * account_guid (the GnuCash schema itself is never modified — same
 * advisory-lock pattern as notifications.ts). The position's current book
 * value comes from the account balance.
 *
 * All bond math (YTM via Newton's method, current yield, ladder buckets,
 * weighted averages, maturity calendar, coupon estimates) is pure and unit
 * tested; database access lives only in the CRUD/loader functions.
 */

import prisma from '@/lib/prisma';
import { fetchAccountCurrentValues } from '@/lib/account-current-value';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export const FIXED_INCOME_KINDS = ['bond', 'cd', 'treasury', 'ibond'] as const;
export type FixedIncomeKind = (typeof FIXED_INCOME_KINDS)[number];

export interface FixedIncomeMetadata {
    accountGuid: string;
    kind: FixedIncomeKind;
    /** Face (par) value at maturity. */
    faceValue: number;
    /** Annual coupon rate in percent (e.g. 4.25 for 4.25%). 0 = zero-coupon. */
    couponRate: number;
    /** ISO date YYYY-MM-DD, optional. */
    purchaseDate: string | null;
    /** ISO date YYYY-MM-DD. */
    maturityDate: string;
    callable: boolean;
}

export interface FixedIncomePosition extends FixedIncomeMetadata {
    accountName: string;
    /** Colon-joined account path below root (best effort). */
    accountPath: string;
    /** Current book value from the account balance. */
    currentValue: number;
}

export interface ComputedFixedIncomePosition extends FixedIncomePosition {
    yearsToMaturity: number;
    matured: boolean;
    /** Annual coupon amount in currency units (face x rate). */
    annualCoupon: number;
    /** Yield to maturity, annual percent (semiannual compounding). Null when unsolvable. */
    ytm: number | null;
    /** Current yield = annual coupon / current value, percent. */
    currentYield: number | null;
}

export interface LadderBucket {
    year: number;
    faceValue: number;
    currentValue: number;
    count: number;
}

export interface UpcomingMaturity {
    accountGuid: string;
    accountName: string;
    kind: FixedIncomeKind;
    maturityDate: string;
    faceValue: number;
    currentValue: number;
    daysUntil: number;
}

export interface CouponPaymentEstimate {
    date: string;
    accountGuid: string;
    accountName: string;
    kind: FixedIncomeKind;
    amount: number;
}

export interface FixedIncomeStats {
    totalFace: number;
    totalCurrentValue: number;
    /** Weighted by current value (face fallback), active positions only. */
    weightedAvgMaturityYears: number | null;
    /** Value-weighted average YTM (percent), active positions with a YTM. */
    weightedAvgYtm: number | null;
    activeCount: number;
    maturedCount: number;
    /** Total face value maturing in the next 12 months. */
    maturingNext12moFace: number;
    /** Estimated coupon income over the next 12 months. */
    couponIncomeNext12mo: number;
}

export interface FixedIncomeSummary {
    asOf: string;
    positions: ComputedFixedIncomePosition[];
    ladder: LadderBucket[];
    stats: FixedIncomeStats;
    upcomingMaturities: UpcomingMaturity[];
    couponPayments: CouponPaymentEstimate[];
}

/* ------------------------------------------------------------------ */
/* Date helpers                                                        */
/* ------------------------------------------------------------------ */

const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Parse YYYY-MM-DD as a local date (midnight). */
export function parseIsoDate(value: string): Date {
    const [y, m, d] = value.split('-').map(n => parseInt(n, 10));
    return new Date(y, m - 1, d);
}

function toIsoDate(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

/** Add whole months, clamping the day to the end of the target month. */
function addMonthsClamped(date: Date, months: number): Date {
    const target = new Date(date.getFullYear(), date.getMonth() + months, 1);
    const daysInTarget = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
    target.setDate(Math.min(date.getDate(), daysInTarget));
    return target;
}

/** Fractional years between two dates (365.25-day years). */
export function yearsToMaturity(maturityDate: string, asOf: Date): number {
    const maturity = parseIsoDate(maturityDate);
    return (maturity.getTime() - asOf.getTime()) / (DAY_MS * 365.25);
}

/* ------------------------------------------------------------------ */
/* Bond math                                                           */
/* ------------------------------------------------------------------ */

export interface BondPriceParams {
    faceValue: number;
    /** Annual coupon rate, percent. */
    couponRatePct: number;
    /** Annual yield, percent, compounded `frequency` times a year. */
    annualYieldPct: number;
    /** Years to maturity (may be fractional). */
    years: number;
    /** Coupon/compounding frequency per year (default semiannual). */
    frequency?: number;
}

/**
 * Standard bond price for a given yield:
 *   P = c * (1 - (1+i)^-n) / i + F * (1+i)^-n
 * with i = y/m per period, n = years*m periods, c = F*rate/m per period.
 * Fractional n is allowed (continuous form of the annuity factor).
 */
export function bondPriceFromYield(params: BondPriceParams): number {
    const m = params.frequency ?? 2;
    const years = params.years;
    const face = params.faceValue;
    const c = (face * params.couponRatePct) / 100 / m;
    const i = params.annualYieldPct / 100 / m;
    const n = years * m;

    if (n <= 0) return face;
    if (i <= -1) return Number.POSITIVE_INFINITY;
    if (Math.abs(i) < 1e-12) return c * n + face;

    const disc = Math.pow(1 + i, -n);
    return c * ((1 - disc) / i) + face * disc;
}

export interface YtmParams {
    /** Current market/book price of the position. */
    price: number;
    faceValue: number;
    /** Annual coupon rate, percent. */
    couponRatePct: number;
    yearsToMaturity: number;
    /** Compounding periods per year (default semiannual). */
    frequency?: number;
}

/**
 * Solve yield-to-maturity (annual percent, semiannual compounding by
 * default) from the standard bond price equation using Newton's method with
 * a numeric derivative, falling back to bisection if Newton fails to
 * converge. Returns null for matured or degenerate positions.
 */
export function computeYTM(params: YtmParams): number | null {
    const { price, faceValue, couponRatePct } = params;
    const years = params.yearsToMaturity;
    const m = params.frequency ?? 2;

    if (!(price > 0) || !(faceValue > 0) || !(years > 0) || !(m > 0)) return null;

    const annualCoupon = (faceValue * couponRatePct) / 100;
    const priceAt = (yieldPct: number) =>
        bondPriceFromYield({ faceValue, couponRatePct, annualYieldPct: yieldPct, years, frequency: m });

    // Textbook approximation as the starting guess.
    let y = ((annualCoupon + (faceValue - price) / years) / ((faceValue + price) / 2)) * 100;
    if (!Number.isFinite(y)) y = couponRatePct;
    y = Math.min(100, Math.max(-50, y));

    const tolerance = Math.max(1e-7 * price, 1e-9);
    const yieldFloor = -m * 100 * 0.99; // keep 1 + i > 0
    let converged = false;

    for (let iter = 0; iter < 100; iter++) {
        const f = priceAt(y) - price;
        if (Math.abs(f) < tolerance) {
            converged = true;
            break;
        }
        const h = 1e-4;
        const derivative = (priceAt(y + h) - priceAt(y - h)) / (2 * h);
        if (!Number.isFinite(derivative) || Math.abs(derivative) < 1e-12) break;
        let next = y - f / derivative;
        if (!Number.isFinite(next)) break;
        next = Math.min(100000, Math.max(yieldFloor, next));
        if (Math.abs(next - y) < 1e-10) {
            y = next;
            converged = Math.abs(priceAt(y) - price) < Math.max(tolerance, 1e-4 * price);
            break;
        }
        y = next;
    }

    if (!converged) {
        // Bisection fallback: price is monotone decreasing in yield.
        let lo = yieldFloor;
        let hi = 100000;
        if (priceAt(lo) < price || priceAt(hi) > price) return null;
        for (let iter = 0; iter < 200; iter++) {
            const mid = (lo + hi) / 2;
            const f = priceAt(mid) - price;
            if (Math.abs(f) < tolerance || (hi - lo) < 1e-10) {
                y = mid;
                converged = true;
                break;
            }
            if (f > 0) lo = mid; else hi = mid;
        }
        if (!converged) return null;
    }

    return Math.round(y * 1e6) / 1e6;
}

/** Current yield = annual coupon / current price, percent. */
export function currentYield(faceValue: number, couponRatePct: number, price: number): number | null {
    if (!(price > 0)) return null;
    return ((faceValue * couponRatePct) / 100 / price) * 100;
}

/* ------------------------------------------------------------------ */
/* Portfolio computations                                              */
/* ------------------------------------------------------------------ */

function round2(value: number): number {
    const r = Math.round(value * 100) / 100;
    return r === 0 ? 0 : r;
}

export function computePosition(
    position: FixedIncomePosition,
    asOf: Date,
): ComputedFixedIncomePosition {
    const years = yearsToMaturity(position.maturityDate, asOf);
    const matured = years <= 0;
    const annualCoupon = (position.faceValue * position.couponRate) / 100;

    const ytm = matured
        ? null
        : computeYTM({
            price: position.currentValue,
            faceValue: position.faceValue,
            couponRatePct: position.couponRate,
            yearsToMaturity: years,
        });

    return {
        ...position,
        yearsToMaturity: Math.max(0, Math.round(years * 100) / 100),
        matured,
        annualCoupon: round2(annualCoupon),
        ytm,
        currentYield: matured ? null : currentYield(position.faceValue, position.couponRate, position.currentValue),
    };
}

/**
 * Ladder buckets: face/current value maturing per calendar year, for active
 * (non-matured) positions. Years between the first and last maturity are
 * filled so the chart shows gaps in the ladder.
 */
export function buildLadder(
    positions: ComputedFixedIncomePosition[],
    asOf: Date,
): LadderBucket[] {
    const active = positions.filter(p => !p.matured);
    if (active.length === 0) return [];

    const byYear = new Map<number, LadderBucket>();
    for (const p of active) {
        const year = parseIsoDate(p.maturityDate).getFullYear();
        let bucket = byYear.get(year);
        if (!bucket) {
            bucket = { year, faceValue: 0, currentValue: 0, count: 0 };
            byYear.set(year, bucket);
        }
        bucket.faceValue = round2(bucket.faceValue + p.faceValue);
        bucket.currentValue = round2(bucket.currentValue + p.currentValue);
        bucket.count += 1;
    }

    const years = [...byYear.keys()];
    const first = Math.min(asOf.getFullYear(), ...years);
    const last = Math.max(...years);

    const ladder: LadderBucket[] = [];
    for (let year = first; year <= last; year++) {
        ladder.push(byYear.get(year) ?? { year, faceValue: 0, currentValue: 0, count: 0 });
    }
    return ladder;
}

/** Weighted average maturity in years (weights: current value, face fallback). */
export function weightedAverageMaturity(positions: ComputedFixedIncomePosition[]): number | null {
    let weightSum = 0;
    let acc = 0;
    for (const p of positions) {
        if (p.matured) continue;
        const w = p.currentValue > 0 ? p.currentValue : p.faceValue;
        if (!(w > 0)) continue;
        weightSum += w;
        acc += p.yearsToMaturity * w;
    }
    if (weightSum <= 0) return null;
    return Math.round((acc / weightSum) * 100) / 100;
}

/** Value-weighted average YTM (percent) across active positions with a YTM. */
export function weightedAverageYield(positions: ComputedFixedIncomePosition[]): number | null {
    let weightSum = 0;
    let acc = 0;
    for (const p of positions) {
        if (p.matured || p.ytm == null) continue;
        const w = p.currentValue > 0 ? p.currentValue : p.faceValue;
        if (!(w > 0)) continue;
        weightSum += w;
        acc += p.ytm * w;
    }
    if (weightSum <= 0) return null;
    return Math.round((acc / weightSum) * 100) / 100;
}

/** Positions maturing within the next `horizonMonths` months, soonest first. */
export function upcomingMaturities(
    positions: ComputedFixedIncomePosition[],
    asOf: Date,
    horizonMonths = 12,
): UpcomingMaturity[] {
    const horizon = addMonthsClamped(asOf, horizonMonths);
    const result: UpcomingMaturity[] = [];
    for (const p of positions) {
        const maturity = parseIsoDate(p.maturityDate);
        if (maturity.getTime() < asOf.getTime() || maturity.getTime() > horizon.getTime()) continue;
        result.push({
            accountGuid: p.accountGuid,
            accountName: p.accountName,
            kind: p.kind,
            maturityDate: p.maturityDate,
            faceValue: p.faceValue,
            currentValue: p.currentValue,
            daysUntil: Math.max(0, Math.round((maturity.getTime() - asOf.getTime()) / DAY_MS)),
        });
    }
    return result.sort((a, b) => a.maturityDate.localeCompare(b.maturityDate));
}

/**
 * Estimated coupon payments over the next `horizonMonths` months. Payment
 * dates are derived by stepping back semiannually from the maturity date;
 * each payment is face x rate / 2. Zero-coupon positions and I-Bonds (whose
 * interest compounds instead of paying out) are skipped.
 */
export function estimateCouponPayments(
    positions: ComputedFixedIncomePosition[],
    asOf: Date,
    horizonMonths = 12,
): CouponPaymentEstimate[] {
    const horizon = addMonthsClamped(asOf, horizonMonths);
    const result: CouponPaymentEstimate[] = [];

    for (const p of positions) {
        if (p.matured || p.couponRate <= 0 || p.kind === 'ibond') continue;

        const maturity = parseIsoDate(p.maturityDate);
        const paymentAmount = round2((p.faceValue * p.couponRate) / 100 / 2);
        if (paymentAmount <= 0) continue;

        const floor = p.purchaseDate ? parseIsoDate(p.purchaseDate) : null;

        // Walk back from maturity in 6-month steps; collect dates in the
        // window (asOf, horizon] — a payment on the as-of date is already paid.
        for (let k = 0; k < 200; k++) {
            const paymentDate = addMonthsClamped(maturity, -6 * k);
            if (paymentDate.getTime() <= asOf.getTime()) break;
            if (floor && paymentDate.getTime() < floor.getTime()) break;
            if (paymentDate.getTime() <= horizon.getTime()) {
                result.push({
                    date: toIsoDate(paymentDate),
                    accountGuid: p.accountGuid,
                    accountName: p.accountName,
                    kind: p.kind,
                    amount: paymentAmount,
                });
            }
        }
    }

    return result.sort((a, b) => a.date.localeCompare(b.date));
}

/** Assemble the full report from raw positions (pure). */
export function summarizeFixedIncome(
    positions: FixedIncomePosition[],
    asOf: Date = new Date(),
): FixedIncomeSummary {
    const computed = positions
        .map(p => computePosition(p, asOf))
        .sort((a, b) => a.maturityDate.localeCompare(b.maturityDate));

    const active = computed.filter(p => !p.matured);
    const ladder = buildLadder(computed, asOf);
    const maturities = upcomingMaturities(computed, asOf);
    const coupons = estimateCouponPayments(computed, asOf);

    const stats: FixedIncomeStats = {
        totalFace: round2(active.reduce((s, p) => s + p.faceValue, 0)),
        totalCurrentValue: round2(active.reduce((s, p) => s + p.currentValue, 0)),
        weightedAvgMaturityYears: weightedAverageMaturity(computed),
        weightedAvgYtm: weightedAverageYield(computed),
        activeCount: active.length,
        maturedCount: computed.length - active.length,
        maturingNext12moFace: round2(maturities.reduce((s, m) => s + m.faceValue, 0)),
        couponIncomeNext12mo: round2(coupons.reduce((s, c) => s + c.amount, 0)),
    };

    return {
        asOf: asOf.toISOString(),
        positions: computed,
        ladder,
        stats,
        upcomingMaturities: maturities,
        couponPayments: coupons,
    };
}

/* ------------------------------------------------------------------ */
/* Lazy table + CRUD                                                   */
/* ------------------------------------------------------------------ */

let ensurePromise: Promise<void> | null = null;

export function ensureFixedIncomeTable(): Promise<void> {
    if (!ensurePromise) {
        ensurePromise = (async () => {
            await prisma.$executeRawUnsafe(`
                DO $$
                BEGIN
                  PERFORM pg_advisory_xact_lock(hashtext('gnucash_web_fixed_income_schema'));

                  CREATE TABLE IF NOT EXISTS gnucash_web_fixed_income (
                    account_guid VARCHAR(32) PRIMARY KEY,
                    kind VARCHAR(16) NOT NULL,
                    face_value DOUBLE PRECISION NOT NULL,
                    coupon_rate DOUBLE PRECISION NOT NULL DEFAULT 0,
                    purchase_date DATE,
                    maturity_date DATE NOT NULL,
                    callable BOOLEAN NOT NULL DEFAULT FALSE,
                    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                  );
                END $$;
            `);
        })();
    }
    return ensurePromise;
}

export class FixedIncomeValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'FixedIncomeValidationError';
    }
}

export interface FixedIncomeMetadataInput {
    kind: string;
    faceValue: number;
    couponRate?: number;
    purchaseDate?: string | null;
    maturityDate: string;
    callable?: boolean;
}

/** Validate a metadata payload; throws FixedIncomeValidationError. */
export function validateFixedIncomeInput(input: FixedIncomeMetadataInput): FixedIncomeMetadata & { accountGuid: '' } {
    if (!FIXED_INCOME_KINDS.includes(input.kind as FixedIncomeKind)) {
        throw new FixedIncomeValidationError(
            `kind must be one of: ${FIXED_INCOME_KINDS.join(', ')}`);
    }
    const faceValue = Number(input.faceValue);
    if (!Number.isFinite(faceValue) || faceValue <= 0) {
        throw new FixedIncomeValidationError('faceValue must be a positive number');
    }
    const couponRate = Number(input.couponRate ?? 0);
    if (!Number.isFinite(couponRate) || couponRate < 0 || couponRate > 100) {
        throw new FixedIncomeValidationError('couponRate must be between 0 and 100 (percent)');
    }
    if (typeof input.maturityDate !== 'string' || !ISO_DATE_RE.test(input.maturityDate)) {
        throw new FixedIncomeValidationError('maturityDate must be an ISO date (YYYY-MM-DD)');
    }
    let purchaseDate: string | null = null;
    if (input.purchaseDate) {
        if (typeof input.purchaseDate !== 'string' || !ISO_DATE_RE.test(input.purchaseDate)) {
            throw new FixedIncomeValidationError('purchaseDate must be an ISO date (YYYY-MM-DD)');
        }
        if (input.purchaseDate > input.maturityDate) {
            throw new FixedIncomeValidationError('purchaseDate must be on or before maturityDate');
        }
        purchaseDate = input.purchaseDate;
    }

    return {
        accountGuid: '',
        kind: input.kind as FixedIncomeKind,
        faceValue,
        couponRate,
        purchaseDate,
        maturityDate: input.maturityDate,
        callable: !!input.callable,
    };
}

interface FixedIncomeRow {
    account_guid: string;
    kind: string;
    face_value: number;
    coupon_rate: number;
    purchase_date: Date | null;
    maturity_date: Date;
    callable: boolean;
}

function rowToMetadata(row: FixedIncomeRow): FixedIncomeMetadata {
    return {
        accountGuid: row.account_guid,
        kind: row.kind as FixedIncomeKind,
        faceValue: Number(row.face_value),
        couponRate: Number(row.coupon_rate),
        purchaseDate: row.purchase_date ? toIsoDate(row.purchase_date) : null,
        maturityDate: toIsoDate(row.maturity_date),
        callable: row.callable,
    };
}

/** List fixed-income metadata rows for accounts within the given set. */
export async function listFixedIncomeMetadata(accountGuids: string[]): Promise<FixedIncomeMetadata[]> {
    await ensureFixedIncomeTable();
    if (accountGuids.length === 0) return [];
    const rows = await prisma.$queryRaw<FixedIncomeRow[]>`
        SELECT account_guid, kind, face_value, coupon_rate, purchase_date, maturity_date, callable
        FROM gnucash_web_fixed_income
        WHERE account_guid = ANY(${accountGuids}::text[])
    `;
    return rows.map(rowToMetadata);
}

export async function upsertFixedIncomeMetadata(
    accountGuid: string,
    input: FixedIncomeMetadataInput,
): Promise<FixedIncomeMetadata> {
    await ensureFixedIncomeTable();
    const validated = validateFixedIncomeInput(input);

    await prisma.$executeRaw`
        INSERT INTO gnucash_web_fixed_income
            (account_guid, kind, face_value, coupon_rate, purchase_date, maturity_date, callable, updated_at)
        VALUES
            (
                ${accountGuid},
                ${validated.kind},
                ${validated.faceValue},
                ${validated.couponRate},
                ${validated.purchaseDate}::date,
                ${validated.maturityDate}::date,
                ${validated.callable},
                CURRENT_TIMESTAMP
            )
        ON CONFLICT (account_guid) DO UPDATE SET
            kind = EXCLUDED.kind,
            face_value = EXCLUDED.face_value,
            coupon_rate = EXCLUDED.coupon_rate,
            purchase_date = EXCLUDED.purchase_date,
            maturity_date = EXCLUDED.maturity_date,
            callable = EXCLUDED.callable,
            updated_at = CURRENT_TIMESTAMP
    `;

    return { ...validated, accountGuid };
}

export async function deleteFixedIncomeMetadata(accountGuid: string): Promise<void> {
    await ensureFixedIncomeTable();
    await prisma.$executeRaw`
        DELETE FROM gnucash_web_fixed_income WHERE account_guid = ${accountGuid}
    `;
}

/* ------------------------------------------------------------------ */
/* Position loader                                                     */
/* ------------------------------------------------------------------ */

/**
 * Load fixed-income positions for the active book: metadata rows joined
 * with account names/paths and current balances.
 */
export async function loadFixedIncomePositions(
    bookAccountGuids: string[],
    asOf: Date = new Date(),
): Promise<FixedIncomePosition[]> {
    const metadata = await listFixedIncomeMetadata(bookAccountGuids);
    if (metadata.length === 0) return [];

    const guids = metadata.map(m => m.accountGuid);

    // Names + parent chain for paths.
    const allAccounts = await prisma.accounts.findMany({
        where: { guid: { in: bookAccountGuids } },
        select: { guid: true, name: true, parent_guid: true, account_type: true },
    });
    const byGuid = new Map(allAccounts.map(a => [a.guid, a]));

    function accountPath(guid: string): string {
        const parts: string[] = [];
        const seen = new Set<string>();
        let current = byGuid.get(guid);
        while (current && current.account_type !== 'ROOT' && !seen.has(current.guid)) {
            seen.add(current.guid);
            parts.unshift(current.name);
            current = current.parent_guid ? byGuid.get(current.parent_guid) : undefined;
        }
        return parts.join(':');
    }

    const values = await fetchAccountCurrentValues(guids, asOf);

    return metadata.map(m => {
        const account = byGuid.get(m.accountGuid);
        return {
            ...m,
            accountName: account?.name ?? m.accountGuid,
            accountPath: account ? accountPath(m.accountGuid) : '',
            currentValue: Math.round((values.get(m.accountGuid)?.value ?? 0) * 100) / 100,
        };
    });
}

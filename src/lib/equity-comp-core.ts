/**
 * Equity Compensation — Pure Computation Core
 *
 * Split-spec computation for RSU vest events and ESPP purchases.
 * This module is intentionally free of database (prisma) imports so it can be:
 *   - unit tested without a DB
 *   - imported by client components for live split previews
 *
 * The DB-facing posting functions live in `equity-comp.ts`, which re-exports
 * everything here.
 *
 * Accounting model (all amounts in the transaction currency, typically USD):
 *
 * RSU vest with sell-to-cover:
 *   - Stock account:   +netShares quantity, +netShares × FMV value
 *                      → cost basis = FMV at vest (anti-double-taxation:
 *                        the vest value is already taxed as W-2 income, so
 *                        the shares must NOT enter at $0 basis)
 *   - Withholding/tax: +withheldShares × FMV (debit — the withheld shares'
 *                      value goes straight to tax withholding)
 *   - Comp income:     −grossShares × FMV (credit — income splits are
 *                      negative per GnuCash sign conventions)
 *
 * ESPP purchase:
 *   - Stock account:   +shares quantity, +shares × FMV value
 *                      → basis = FMV, NOT the discounted purchase price
 *   - Cash account:    −shares × purchasePrice (only actual cash spent)
 *   - Comp income:     −(FMV − purchasePrice) × shares (the discount is
 *                      compensation income, credited)
 *
 * Both transactions balance to zero by construction: the income split is
 * computed as the negated sum of the debit splits, so integer rounding can
 * never produce an unbalanced transaction.
 */

export const DEFAULT_SHARE_FRACTION = 10000;
export const DEFAULT_CURRENCY_FRACTION = 100;

export type EquityCompRole = 'stock' | 'income' | 'tax' | 'cash';

/** A single split spec, in GnuCash integer fraction form. */
export interface EquityCompSplitSpec {
    /** Which input account this split posts to. */
    role: EquityCompRole;
    /** Value in transaction currency (num/denom). */
    valueNum: number;
    valueDenom: number;
    /** Quantity in the account's native commodity (shares for stock). */
    quantityNum: number;
    quantityDenom: number;
    memo: string;
    action: string;
}

export class EquityCompValidationError extends Error {
    readonly errors: string[];
    constructor(errors: string[]) {
        super(errors.join('; '));
        this.name = 'EquityCompValidationError';
        this.errors = errors;
    }
}

export interface VestComputeInput {
    /** Gross shares vesting (before sell-to-cover withholding). */
    sharesVested: number;
    /** Fair market value per share at vest. */
    fmvPerShare: number;
    /** Shares withheld (sold) to cover taxes. Default 0. */
    sharesWithheldForTax?: number;
    /** Stock commodity fraction (e.g. 10000). Default 10000. */
    shareFraction?: number;
    /** Transaction currency fraction (e.g. 100 for USD). Default 100. */
    currencyFraction?: number;
    /** Ticker symbol, used only for memos. */
    symbol?: string;
}

export interface EsppComputeInput {
    /** Shares purchased. */
    shares: number;
    /** Fair market value per share on the purchase date. */
    fmvPerShare: number;
    /** Actual (discounted) price paid per share. Must be ≤ FMV. */
    purchasePricePerShare: number;
    /** Informational only — purchase price is authoritative. */
    discountPercent?: number;
    shareFraction?: number;
    currencyFraction?: number;
    symbol?: string;
}

/** Round a decimal amount onto an integer numerator for the given denominator. */
function scaleToFraction(value: number, denom: number): number {
    return Math.round(value * denom);
}

function isPositiveFinite(n: unknown): n is number {
    return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

function isNonNegativeFinite(n: unknown): n is number {
    return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

function validateFractions(shareFraction: number, currencyFraction: number, errors: string[]): void {
    if (!Number.isInteger(shareFraction) || shareFraction <= 0) {
        errors.push('shareFraction must be a positive integer');
    }
    if (!Number.isInteger(currencyFraction) || currencyFraction <= 0) {
        errors.push('currencyFraction must be a positive integer');
    }
}

/** Validate a vest computation input. Returns a list of problems (empty = valid). */
export function validateVestInput(input: VestComputeInput): string[] {
    const errors: string[] = [];
    const withheld = input.sharesWithheldForTax ?? 0;

    if (!isPositiveFinite(input.sharesVested)) {
        errors.push('sharesVested must be a positive number');
    }
    if (!isPositiveFinite(input.fmvPerShare)) {
        errors.push('fmvPerShare must be a positive number');
    }
    if (!isNonNegativeFinite(withheld)) {
        errors.push('sharesWithheldForTax must be zero or a positive number');
    } else if (isPositiveFinite(input.sharesVested) && withheld >= input.sharesVested) {
        errors.push('sharesWithheldForTax must be less than sharesVested');
    }
    validateFractions(
        input.shareFraction ?? DEFAULT_SHARE_FRACTION,
        input.currencyFraction ?? DEFAULT_CURRENCY_FRACTION,
        errors,
    );
    return errors;
}

/** Validate an ESPP computation input. Returns a list of problems (empty = valid). */
export function validateEsppInput(input: EsppComputeInput): string[] {
    const errors: string[] = [];

    if (!isPositiveFinite(input.shares)) {
        errors.push('shares must be a positive number');
    }
    if (!isPositiveFinite(input.fmvPerShare)) {
        errors.push('fmvPerShare must be a positive number');
    }
    if (!isPositiveFinite(input.purchasePricePerShare)) {
        errors.push('purchasePricePerShare must be a positive number');
    } else if (
        isPositiveFinite(input.fmvPerShare) &&
        input.purchasePricePerShare > input.fmvPerShare
    ) {
        errors.push('purchasePricePerShare cannot exceed fmvPerShare (negative discount)');
    }
    if (input.discountPercent !== undefined &&
        (!Number.isFinite(input.discountPercent) || input.discountPercent < 0 || input.discountPercent >= 100)) {
        errors.push('discountPercent must be between 0 and 100');
    }
    validateFractions(
        input.shareFraction ?? DEFAULT_SHARE_FRACTION,
        input.currencyFraction ?? DEFAULT_CURRENCY_FRACTION,
        errors,
    );
    return errors;
}

/** Convenience: derive the ESPP purchase price from FMV and a discount percent. */
export function esppPurchasePriceFromDiscount(fmvPerShare: number, discountPercent: number): number {
    return fmvPerShare * (1 - discountPercent / 100);
}

/**
 * Compute the splits for an RSU vest event (optionally with sell-to-cover).
 *
 * Returns splits that sum to exactly zero value:
 *   stock  +net×FMV   | income −gross×FMV | tax +withheld×FMV
 *
 * The income split is derived as the negated sum of the debits, so integer
 * rounding of net and withheld values can never unbalance the transaction.
 */
export function computeVestSplits(input: VestComputeInput): EquityCompSplitSpec[] {
    const errors = validateVestInput(input);
    if (errors.length > 0) throw new EquityCompValidationError(errors);

    const shareFraction = input.shareFraction ?? DEFAULT_SHARE_FRACTION;
    const currencyFraction = input.currencyFraction ?? DEFAULT_CURRENCY_FRACTION;
    const withheld = input.sharesWithheldForTax ?? 0;
    const netShares = input.sharesVested - withheld;
    const sym = input.symbol ? ` ${input.symbol}` : '';

    // Debits, rounded independently onto the currency fraction.
    const stockValueNum = scaleToFraction(netShares * input.fmvPerShare, currencyFraction);
    const withheldValueNum = scaleToFraction(withheld * input.fmvPerShare, currencyFraction);
    // Credit = residual → guaranteed balance; equals gross vest value.
    const incomeValueNum = -(stockValueNum + withheldValueNum);

    const splits: EquityCompSplitSpec[] = [
        {
            role: 'stock',
            valueNum: stockValueNum,
            valueDenom: currencyFraction,
            quantityNum: scaleToFraction(netShares, shareFraction),
            quantityDenom: shareFraction,
            memo: `RSU vest: ${netShares}${sym} net shares @ FMV ${input.fmvPerShare} (basis = FMV)`,
            action: 'Buy',
        },
        {
            role: 'income',
            valueNum: incomeValueNum,
            valueDenom: currencyFraction,
            quantityNum: incomeValueNum,
            quantityDenom: currencyFraction,
            memo: `RSU compensation income: ${input.sharesVested}${sym} gross shares @ ${input.fmvPerShare}`,
            action: '',
        },
    ];

    if (withheld > 0) {
        splits.push({
            role: 'tax',
            valueNum: withheldValueNum,
            valueDenom: currencyFraction,
            quantityNum: withheldValueNum,
            quantityDenom: currencyFraction,
            memo: `Sell-to-cover: ${withheld}${sym} shares withheld for tax @ ${input.fmvPerShare}`,
            action: '',
        });
    }

    return splits;
}

/**
 * Compute the splits for an ESPP purchase.
 *
 * Shares enter at basis = FMV (not the discounted price); the discount is
 * credited as compensation income and cash is reduced only by actual cost.
 * The income split is derived as −(fmvValue − cost) from the already-rounded
 * integer numerators, so the transaction always balances exactly.
 */
export function computeEsppSplits(input: EsppComputeInput): EquityCompSplitSpec[] {
    const errors = validateEsppInput(input);
    if (errors.length > 0) throw new EquityCompValidationError(errors);

    const shareFraction = input.shareFraction ?? DEFAULT_SHARE_FRACTION;
    const currencyFraction = input.currencyFraction ?? DEFAULT_CURRENCY_FRACTION;
    const sym = input.symbol ? ` ${input.symbol}` : '';

    const fmvValueNum = scaleToFraction(input.shares * input.fmvPerShare, currencyFraction);
    const costNum = scaleToFraction(input.shares * input.purchasePricePerShare, currencyFraction);
    // Discount income as residual of the rounded numerators → exact balance.
    const discountNum = fmvValueNum - costNum;

    const splits: EquityCompSplitSpec[] = [
        {
            role: 'stock',
            valueNum: fmvValueNum,
            valueDenom: currencyFraction,
            quantityNum: scaleToFraction(input.shares, shareFraction),
            quantityDenom: shareFraction,
            memo: `ESPP purchase: ${input.shares}${sym} shares, basis = FMV ${input.fmvPerShare}`,
            action: 'Buy',
        },
        {
            role: 'cash',
            valueNum: -costNum,
            valueDenom: currencyFraction,
            quantityNum: -costNum,
            quantityDenom: currencyFraction,
            memo: `ESPP cost: ${input.shares}${sym} shares @ ${input.purchasePricePerShare}`,
            action: '',
        },
    ];

    if (discountNum !== 0) {
        splits.push({
            role: 'income',
            valueNum: -discountNum,
            valueDenom: currencyFraction,
            quantityNum: -discountNum,
            quantityDenom: currencyFraction,
            memo: `ESPP discount (compensation income)${sym}`,
            action: '',
        });
    }

    return splits;
}

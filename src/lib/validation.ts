/**
 * Transaction validation utilities for GnuCash data
 */

import { isValidGuid } from './guid';

export interface SplitInput {
    account_guid: string;
    value_num: number;
    value_denom: number;
    quantity_num?: number;
    quantity_denom?: number;
    memo?: string;
    action?: string;
    reconcile_state?: 'n' | 'c' | 'y';
}

export interface TransactionInput {
    currency_guid: string;
    num?: string;
    post_date: string;
    description: string;
    splits: SplitInput[];
}

export interface ValidationError {
    field: string;
    message: string;
}

export interface BalanceSplit {
    value_num: number | bigint;
    value_denom: number | bigint;
}

function gcd(a: bigint, b: bigint): bigint {
    while (b !== 0n) [a, b] = [b, a % b];
    return a < 0n ? -a : a;
}

function toBigInt(value: number | bigint, field: 'numerator' | 'denominator'): bigint {
    if (typeof value === 'bigint') return value;
    if (!Number.isSafeInteger(value)) {
        throw new Error(`Split value ${field} must be a safe integer`);
    }
    return BigInt(value);
}

/**
 * Assert that rational split values sum to exactly zero.
 *
 * GnuCash denominators are arbitrary integers, not decimal precision markers,
 * so values are brought to their least common denominator with BigInt rather
 * than converted to IEEE-754 numbers. This is the shared ledger-balance gate
 * for both transaction write paths.
 */
export function assertBalanced(splits: readonly BalanceSplit[]): void {
    let commonDenominator = 1n;
    for (const split of splits) {
        const denominator = toBigInt(split.value_denom, 'denominator');
        if (denominator === 0n) throw new Error('Split value denominator must be non-zero');
        const absoluteDenominator = denominator < 0n ? -denominator : denominator;
        commonDenominator = (commonDenominator / gcd(commonDenominator, absoluteDenominator)) * absoluteDenominator;
    }

    let total = 0n;
    for (const split of splits) {
        const numerator = toBigInt(split.value_num, 'numerator');
        const denominator = toBigInt(split.value_denom, 'denominator');
        total += numerator * (commonDenominator / denominator);
    }

    if (total !== 0n) {
        const divisor = gcd(total, commonDenominator);
        throw new Error(
            `Splits must sum to zero exactly (current sum: ${total / divisor}/${commonDenominator / divisor})`,
        );
    }
}

/**
 * Separator between messages in a multi-error summary. Messages do not end in
 * punctuation, so joining with a space produced run-on text
 * ("Currency is required Post date is required"). Semicolon-space keeps the
 * boundaries readable in a single-line toast.
 */
const ERROR_SUMMARY_SEPARATOR = '; ';

/**
 * Flatten validation errors into the single human-readable string API routes
 * return as `error`. Both transaction write paths use this so the create and
 * update responses read identically.
 */
export function summarizeValidationErrors(errors: ValidationError[]): string {
    return errors.map(item => item.message).join(ERROR_SUMMARY_SEPARATOR);
}

export interface ValidationResult {
    valid: boolean;
    errors: ValidationError[];
}

/**
 * Validate a transaction for creation or update
 */
export function validateTransaction(tx: TransactionInput): ValidationResult {
    const errors: ValidationError[] = [];

    // Required fields
    if (!tx.currency_guid) {
        errors.push({ field: 'currency_guid', message: 'Currency is required' });
    } else if (!isValidGuid(tx.currency_guid)) {
        errors.push({ field: 'currency_guid', message: 'Invalid currency GUID format' });
    }

    if (!tx.post_date) {
        errors.push({ field: 'post_date', message: 'Post date is required' });
    } else if (!isValidDate(tx.post_date)) {
        errors.push({ field: 'post_date', message: 'Invalid post date format' });
    }

    if (!tx.description || tx.description.trim() === '') {
        errors.push({ field: 'description', message: 'Description is required' });
    }

    // Splits validation
    if (!tx.splits || !Array.isArray(tx.splits)) {
        errors.push({ field: 'splits', message: 'Splits are required' });
    } else {
        if (tx.splits.length < 2) {
            errors.push({ field: 'splits', message: 'At least 2 splits are required (double-entry)' });
        }

        // Validate each split
        tx.splits.forEach((split, index) => {
            if (!split.account_guid) {
                errors.push({ field: `splits[${index}].account_guid`, message: `Split ${index + 1}: Account is required` });
            } else if (!isValidGuid(split.account_guid)) {
                errors.push({ field: `splits[${index}].account_guid`, message: `Split ${index + 1}: Invalid account GUID format` });
            }

            if (split.value_num === undefined || split.value_num === null) {
                errors.push({ field: `splits[${index}].value_num`, message: `Split ${index + 1}: Value is required` });
            }

            if (!split.value_denom || split.value_denom === 0) {
                errors.push({ field: `splits[${index}].value_denom`, message: `Split ${index + 1}: Value denominator must be non-zero` });
            }

            // Default quantity to value if not specified
            if (split.quantity_denom && split.quantity_denom === 0) {
                errors.push({ field: `splits[${index}].quantity_denom`, message: `Split ${index + 1}: Quantity denominator must be non-zero` });
            }

            // Validate reconcile state if provided
            if (split.reconcile_state && !['n', 'c', 'y'].includes(split.reconcile_state)) {
                errors.push({ field: `splits[${index}].reconcile_state`, message: `Split ${index + 1}: Invalid reconcile state` });
            }
        });

        // Check that splits sum to zero (double-entry accounting).
        if (tx.splits.length >= 2) {
            try {
                assertBalanced(tx.splits);
            } catch (error) {
                errors.push({
                    field: 'splits',
                    message: error instanceof Error ? error.message : 'Splits must sum to zero exactly',
                });
            }
        }
    }

    return {
        valid: errors.length === 0,
        errors,
    };
}

/**
 * Validate a date string (ISO 8601 format)
 */
function isValidDate(dateStr: string): boolean {
    const date = new Date(dateStr);
    return !isNaN(date.getTime());
}

/**
 * Convert a decimal amount to num/denom format
 * @param amount The decimal amount (e.g., 100.50)
 * @param precision The number of decimal places (default 2 for currency)
 */
export function toNumDenom(amount: number, precision: number = 2): { num: number; denom: number } {
    const denom = Math.pow(10, precision);
    const num = Math.round(amount * denom);
    return { num, denom };
}

/**
 * Convert num/denom to decimal
 */
export function fromNumDenom(num: number, denom: number): number {
    return num / denom;
}

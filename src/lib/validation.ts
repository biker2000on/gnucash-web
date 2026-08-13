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

/**
 * Tolerance, in currency units, for the double-entry "splits sum to zero" check.
 *
 * The check divides each split's `value_num / value_denom` in IEEE-754 double
 * precision, so an exactly-balanced transaction can still sum to a tiny
 * non-zero residue (e.g. 1/3 + 1/3 + 1/3 - 1 !== 0). The tolerance only exists
 * to absorb that representation error.
 *
 * 0.001 is a tenth of a cent: far above the ~1e-13 residue that accumulates
 * over a realistic split count, and still an order of magnitude below the
 * smallest imbalance a user could enter in a currency field (0.01). So it
 * cannot mask a real one-cent error.
 *
 * Used by `validateTransaction` (API routes) and `validateSplitsBalance`
 * (TransactionService) so both server-side create paths agree. Callers that
 * work in a different unit or precision (import parsers, the lot scrub engine)
 * deliberately keep their own thresholds and are not covered by this constant.
 */
export const BALANCE_TOLERANCE = 0.001;

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

        // Check that splits sum to zero (double-entry accounting)
        if (tx.splits.length >= 2) {
            const sum = tx.splits.reduce((acc, split) => {
                // Normalize to common denominator calculation
                const value = (split.value_num || 0) / (split.value_denom || 1);
                return acc + value;
            }, 0);

            // Allow only for floating-point representation error — see BALANCE_TOLERANCE.
            if (Math.abs(sum) > BALANCE_TOLERANCE) {
                errors.push({ field: 'splits', message: `Splits must sum to zero (current sum: ${sum.toFixed(2)})` });
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

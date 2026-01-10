/**
 * Transaction validation utilities for GnuCash web
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

            // Allow for small floating point errors (1 cent / 100 = 0.01)
            if (Math.abs(sum) > 0.001) {
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

export function formatCurrency(amount: number | string, currencyMnemonic: string = 'USD') {
    let val = typeof amount === 'string' ? parseFloat(amount) : amount;
    if (!Number.isFinite(val)) val = 0;

    // Normalize negative zero and sub-cent values that round to "0.00" so the
    // formatter never renders "-$0.00". Uses the same 0.005 threshold the
    // formatter rounds at.
    if (Math.abs(val) < 0.005) val = 0;

    // GnuCash mnemonics usually match ISO 4217, but sometimes have custom ones.
    // Intl.NumberFormat is robust for standard ones.
    try {
        return new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: currencyMnemonic,
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
        }).format(val);
    } catch {
        // Fallback for non-standard mnemonics
        const formattedNumber = new Intl.NumberFormat('en-US', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
        }).format(val);
        return `${currencyMnemonic} ${formattedNumber}`;
    }
}

/**
 * Balance reversal modes for displaying account balances
 */
export type BalanceReversal = 'none' | 'credit' | 'income_expense';

/**
 * Account types that are naturally credit-balance accounts
 * These show negative values in GnuCash but represent positive balances
 */
const CREDIT_ACCOUNT_TYPES = ['INCOME', 'LIABILITY', 'EQUITY', 'CREDIT'];

/**
 * Account types for P&L (profit & loss) display reversal
 */
const INCOME_EXPENSE_TYPES = ['INCOME', 'EXPENSE'];

/**
 * Apply balance reversal based on user preference and account type
 *
 * @param balance - The raw balance value from GnuCash
 * @param accountType - The GnuCash account type (e.g., 'INCOME', 'ASSET')
 * @param reversalMode - The user's balance reversal preference
 * @returns The balance with reversal applied if applicable
 */
export function applyBalanceReversal(
    balance: number,
    accountType: string,
    reversalMode: BalanceReversal
): number {
    if (reversalMode === 'none') return balance;

    if (reversalMode === 'credit' && CREDIT_ACCOUNT_TYPES.includes(accountType)) {
        return -balance;
    }

    if (reversalMode === 'income_expense' && INCOME_EXPENSE_TYPES.includes(accountType)) {
        return -balance;
    }

    return balance;
}

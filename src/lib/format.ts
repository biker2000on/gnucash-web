export function formatCurrency(amount: number | string, currencyMnemonic: string = 'USD') {
    const val = typeof amount === 'string' ? parseFloat(amount) : amount;

    // GnuCash mnemonics usually match ISO 4217, but sometimes have custom ones.
    // Intl.NumberFormat is robust for standard ones.
    try {
        return new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: currencyMnemonic,
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
        }).format(val);
    } catch (e) {
        // Fallback for non-standard mnemonics
        const formattedNumber = new Intl.NumberFormat('en-US', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
        }).format(val);
        return `${currencyMnemonic} ${formattedNumber}`;
    }
}

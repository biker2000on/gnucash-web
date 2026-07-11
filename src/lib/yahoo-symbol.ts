/**
 * Map a commodity to its Yahoo Finance symbol. Crypto commodities (namespace
 * CRYPTO) trade as {MNEMONIC}-USD pairs on Yahoo (BTC -> BTC-USD); everything
 * else uses the mnemonic as-is. Pure/dependency-free so both client and server
 * can import it.
 */
export function yahooSymbolFor(c: { mnemonic: string; namespace?: string | null }): string {
  return (c.namespace ?? '').toUpperCase() === 'CRYPTO'
    ? `${c.mnemonic.toUpperCase()}-USD`
    : c.mnemonic;
}

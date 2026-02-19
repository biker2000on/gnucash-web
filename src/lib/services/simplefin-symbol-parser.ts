/**
 * SimpleFin Symbol Parser
 *
 * Extracts stock ticker symbols from SimpleFin transaction descriptions
 * by matching against a known set of holdings symbols.
 */

import type { SimpleFinHolding } from './simplefin.service';

export interface SymbolMatch {
  symbol: string;
  confidence: 'high' | 'medium' | 'low';
}

/**
 * Build a lookup map from holdings: symbol -> holding description.
 */
export function buildSymbolSet(holdings: SimpleFinHolding[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const h of holdings) {
    if (h.symbol) {
      map.set(h.symbol.toUpperCase(), h.description || h.symbol);
    }
  }
  return map;
}

/**
 * Parse a transaction description to extract a ticker symbol.
 * Validates candidates against the known holdings symbol set.
 *
 * Strategy (in priority order):
 * 1. Parenthesized ticker: "BOUGHT ... (VOO) ..."
 * 2. Bracketed ticker: "DIVIDEND [AAPL]"
 * 3. Known symbol as standalone word in text: "SOLD MSFT 10 SHARES"
 * 4. Holdings description substring match: "VANGUARD S&P 500 ETF" -> VOO
 */
export function parseSymbol(
  description: string,
  symbolSet: Map<string, string>
): SymbolMatch | null {
  if (!description || symbolSet.size === 0) return null;

  const upper = description.toUpperCase();

  // 1. Parenthesized ticker: (VOO), (AAPL)
  const parenMatches = upper.matchAll(/\(([A-Z]{1,5})\)/g);
  for (const m of parenMatches) {
    if (symbolSet.has(m[1])) {
      return { symbol: m[1], confidence: 'high' };
    }
  }

  // 2. Bracketed ticker: [AAPL], [VOO]
  const bracketMatches = upper.matchAll(/\[([A-Z]{1,5})\]/g);
  for (const m of bracketMatches) {
    if (symbolSet.has(m[1])) {
      return { symbol: m[1], confidence: 'high' };
    }
  }

  // 3. Standalone word matching a known symbol
  const words = upper.match(/\b([A-Z]{1,5})\b/g) || [];
  const NOISE = new Set([
    'USD', 'ETF', 'THE', 'AND', 'FOR', 'YOU', 'BUY', 'SELL',
    'CASH', 'FUND', 'SOLD', 'AUTO', 'FEE', 'TAX', 'DIV',
    'INC', 'LTD', 'LLC', 'CORP', 'CO', 'INT', 'NEW', 'NET',
  ]);
  for (const word of words) {
    if (!NOISE.has(word) && symbolSet.has(word)) {
      return { symbol: word, confidence: 'medium' };
    }
  }

  // 4. Holdings description substring match
  for (const [symbol, holdingDesc] of symbolSet) {
    if (holdingDesc && upper.includes(holdingDesc.toUpperCase())) {
      return { symbol, confidence: 'low' };
    }
  }

  return null;
}

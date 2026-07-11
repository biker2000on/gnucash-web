import { NextRequest, NextResponse } from 'next/server';
import YahooFinance from 'yahoo-finance2';
import { requireRole } from '@/lib/auth';
import { yahooSymbolFor } from '@/lib/yahoo-symbol';
import { z } from 'zod';

/**
 * @openapi
 * /api/commodities/verify-symbol:
 *   get:
 *     description: Verify that a ticker symbol resolves on Yahoo Finance.
 *     parameters:
 *       - name: symbol
 *         in: query
 *         required: true
 *         schema: { type: string }
 *       - name: namespace
 *         in: query
 *         description: Skip lookup and return exists=true when namespace is CURRENCY.
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Verification result. Network/rate-limit failures return exists=false.
 */
export async function GET(request: NextRequest) {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const symbol = request.nextUrl.searchParams.get('symbol')?.trim();
    const namespace = request.nextUrl.searchParams.get('namespace')?.trim().toUpperCase();

    if (!symbol) {
        return NextResponse.json({ error: 'symbol is required' }, { status: 400 });
    }

    if (namespace === 'CURRENCY') {
        return NextResponse.json({ exists: true });
    }

    try {
        const yahooFinance = new YahooFinance();
        const ySymbol = yahooSymbolFor({ mnemonic: symbol, namespace });
        const quote = await yahooFinance.quote(ySymbol);
        if (quote && quote.symbol && typeof quote.regularMarketPrice === 'number') {
            return NextResponse.json({
                exists: true,
                fullname: quote.longName || quote.shortName || undefined,
            });
        }
        return NextResponse.json({ exists: false });
    } catch {
        return NextResponse.json({ exists: false });
    }
}

const BulkSchema = z.object({
    // Back-compat: a plain string[] of symbols, or objects carrying the
    // namespace so crypto can be mapped to its {SYM}-USD Yahoo pair.
    symbols: z
        .array(z.union([z.string().min(1), z.object({ symbol: z.string().min(1), namespace: z.string().optional() })]))
        .max(200),
});

/**
 * @openapi
 * /api/commodities/verify-symbol:
 *   post:
 *     description: Verify multiple symbols in one call (Yahoo accepts arrays).
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               symbols:
 *                 type: array
 *                 items: { type: string }
 *     responses:
 *       200:
 *         description: Map of { symbol: { exists, fullname? } }.
 */
export async function POST(request: NextRequest) {
    const roleResult = await requireRole('readonly');
    if (roleResult instanceof NextResponse) return roleResult;

    const body = await request.json().catch(() => null);
    const parsed = BulkSchema.safeParse(body);
    if (!parsed.success) {
        return NextResponse.json({ error: 'symbols[] required' }, { status: 400 });
    }

    // Normalize to { original, ySymbol } where original is the mnemonic the
    // client keys results by, and ySymbol is what Yahoo actually needs (crypto
    // maps to {SYM}-USD). Dedup by original.
    const seen = new Set<string>();
    const items: Array<{ original: string; ySymbol: string }> = [];
    for (const raw of parsed.data.symbols) {
        const symbol = (typeof raw === 'string' ? raw : raw.symbol).trim();
        if (!symbol || seen.has(symbol)) continue;
        seen.add(symbol);
        const namespace = typeof raw === 'string' ? undefined : raw.namespace;
        items.push({ original: symbol, ySymbol: yahooSymbolFor({ mnemonic: symbol, namespace }) });
    }
    if (items.length === 0) {
        return NextResponse.json({ results: {} });
    }

    type Entry = { exists: boolean; fullname?: string };
    const results: Record<string, Entry> = {};
    try {
        const yahooFinance = new YahooFinance();
        const quotes = await yahooFinance.quote(items.map((it) => it.ySymbol));
        const byUpper = new Map<string, typeof quotes[number]>();
        for (const q of quotes) {
            if (q?.symbol) byUpper.set(q.symbol.toUpperCase(), q);
        }
        for (const { original, ySymbol } of items) {
            const q = byUpper.get(ySymbol.toUpperCase());
            if (q && typeof q.regularMarketPrice === 'number') {
                results[original] = {
                    exists: true,
                    fullname: q.longName || q.shortName || undefined,
                };
            } else {
                results[original] = { exists: false };
            }
        }
    } catch {
        for (const { original } of items) results[original] = { exists: false };
    }
    return NextResponse.json({ results });
}

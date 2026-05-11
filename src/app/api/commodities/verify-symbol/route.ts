import { NextRequest, NextResponse } from 'next/server';
import YahooFinance from 'yahoo-finance2';
import { requireRole } from '@/lib/auth';
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
        const quote = await yahooFinance.quote(symbol);
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
    symbols: z.array(z.string().min(1)).max(200),
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

    const symbols = Array.from(new Set(parsed.data.symbols.map((s) => s.trim()).filter(Boolean)));
    if (symbols.length === 0) {
        return NextResponse.json({ results: {} });
    }

    type Entry = { exists: boolean; fullname?: string };
    const results: Record<string, Entry> = {};
    try {
        const yahooFinance = new YahooFinance();
        const quotes = await yahooFinance.quote(symbols);
        const byUpper = new Map<string, typeof quotes[number]>();
        for (const q of quotes) {
            if (q?.symbol) byUpper.set(q.symbol.toUpperCase(), q);
        }
        for (const sym of symbols) {
            const q = byUpper.get(sym.toUpperCase());
            if (q && typeof q.regularMarketPrice === 'number') {
                results[sym] = {
                    exists: true,
                    fullname: q.longName || q.shortName || undefined,
                };
            } else {
                results[sym] = { exists: false };
            }
        }
    } catch {
        for (const sym of symbols) results[sym] = { exists: false };
    }
    return NextResponse.json({ results });
}

import { NextRequest, NextResponse } from 'next/server';
import { findExchangeRate } from '@/lib/currency';
import { requireRole } from '@/lib/auth';

/**
 * GET /api/exchange-rates/pair?from={commodity_guid}&to={commodity_guid}[&date={YYYY-MM-DD}]
 *
 * Get the exchange rate between two commodities
 */
export async function GET(request: NextRequest) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const { searchParams } = new URL(request.url);
        const fromGuid = searchParams.get('from');
        const toGuid = searchParams.get('to');
        const dateStr = searchParams.get('date');

        if (!fromGuid || !toGuid) {
            return NextResponse.json(
                { error: 'Both from and to commodity GUIDs are required' },
                { status: 400 }
            );
        }

        const date = dateStr ? new Date(dateStr) : undefined;
        const rate = await findExchangeRate(fromGuid, toGuid, date);

        if (!rate) {
            return NextResponse.json(
                { error: 'Exchange rate not found' },
                { status: 404 }
            );
        }

        return NextResponse.json({
            fromCurrency: rate.fromCurrency,
            toCurrency: rate.toCurrency,
            rate: rate.rate,
            date: rate.date.toISOString().split('T')[0],
            source: rate.source,
        });
    } catch (error) {
        console.error('Error fetching exchange rate:', error);
        return NextResponse.json(
            { error: 'Failed to fetch exchange rate' },
            { status: 500 }
        );
    }
}

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { getBookAccountGuids } from '@/lib/book-scope';
import { loadForecastData } from '@/lib/forecast-data';

/**
 * @openapi
 * /api/tools/cash-flow-forecast:
 *   get:
 *     description: Projects cash account balances forward using scheduled transactions and historical run rates.
 *     parameters:
 *       - name: days
 *         in: query
 *         description: Forecast horizon in days (default 90)
 *         schema:
 *           type: integer
 *           default: 90
 *       - name: accounts
 *         in: query
 *         description: Comma-separated account GUIDs (default = all BANK/CASH/CREDIT accounts)
 *         schema:
 *           type: string
 *       - name: threshold
 *         in: query
 *         description: Low-balance warning threshold (default 0)
 *         schema:
 *           type: number
 *     responses:
 *       200:
 *         description: The forecast with daily series, events, and warnings.
 */
export async function GET(request: NextRequest) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const { searchParams } = new URL(request.url);
        const bookAccountGuids = await getBookAccountGuids();

        const daysParam = searchParams.get('days');
        const days = daysParam ? parseInt(daysParam, 10) : 90;
        if (isNaN(days) || days < 1 || days > 365) {
            return NextResponse.json(
                { error: 'days must be between 1 and 365' },
                { status: 400 }
            );
        }

        const accountsParam = searchParams.get('accounts');
        const accountGuids = accountsParam
            ? accountsParam.split(',').map(s => s.trim()).filter(Boolean)
            : null;

        const thresholdParam = searchParams.get('threshold');
        const threshold = thresholdParam !== null && thresholdParam !== ''
            ? parseFloat(thresholdParam)
            : 0;
        if (!Number.isFinite(threshold)) {
            return NextResponse.json(
                { error: 'threshold must be a number' },
                { status: 400 }
            );
        }

        const forecast = await loadForecastData({
            bookAccountGuids,
            accountGuids,
            horizonDays: days,
            threshold,
        });

        return NextResponse.json(forecast);
    } catch (error) {
        console.error('Error generating cash flow forecast:', error);
        return NextResponse.json(
            { error: 'Failed to generate cash flow forecast' },
            { status: 500 }
        );
    }
}

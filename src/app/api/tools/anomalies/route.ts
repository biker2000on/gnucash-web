import { NextRequest, NextResponse } from 'next/server';
import { detectAnomaliesForBook, scanForAnomalies, type AnomalyOptions } from '@/lib/anomaly-detection';
import { getBookAccountGuids } from '@/lib/book-scope';
import { requireRole } from '@/lib/auth';

/**
 * Parse the optional detector thresholds shared by GET and POST.
 */
function parseOptions(searchParams: URLSearchParams): AnomalyOptions & { months: number } {
    const monthsParam = parseInt(searchParams.get('months') ?? '', 10);
    const months = Number.isFinite(monthsParam) ? Math.min(24, Math.max(3, monthsParam)) : 12;

    const opts: AnomalyOptions & { months: number } = { months };

    const num = (key: string, min: number, max: number): number | undefined => {
        const raw = parseFloat(searchParams.get(key) ?? '');
        return Number.isFinite(raw) ? Math.min(max, Math.max(min, raw)) : undefined;
    };

    const dupWindow = num('duplicateWindowDays', 1, 14);
    if (dupWindow !== undefined) opts.duplicateWindowDays = dupWindow;
    const firstTime = num('firstTimeWindowDays', 7, 120);
    if (firstTime !== undefined) opts.firstTimeWindowDays = firstTime;
    const stdMult = num('outlierStdDevMult', 1, 6);
    if (stdMult !== undefined) opts.outlierStdDevMult = stdMult;
    const spikePct = num('spikeThresholdPct', 0.1, 5);
    if (spikePct !== undefined) opts.spikeThresholdPct = spikePct;
    const spikeMin = num('spikeMinDollars', 0, 100000);
    if (spikeMin !== undefined) opts.spikeMinDollars = spikeMin;

    return opts;
}

/**
 * GET /api/tools/anomalies
 *
 * Detects spending anomalies / fraud signals on demand (no notifications).
 *
 * Query params:
 *   months                Lookback window in months (default 12, clamped 3-24)
 *   duplicateWindowDays   Duplicate-charge window (optional)
 *   firstTimeWindowDays   Recent window for first-time merchants (optional)
 *   outlierStdDevMult     Std-dev multiplier for amount outliers (optional)
 *   spikeThresholdPct     Category spike threshold fraction (optional)
 *   spikeMinDollars       Minimum category spike excess in dollars (optional)
 */
export async function GET(request: NextRequest) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const { searchParams } = new URL(request.url);
        const opts = parseOptions(searchParams);

        const bookAccountGuids = await getBookAccountGuids();
        const anomalies = await detectAnomaliesForBook(bookAccountGuids, opts);

        const counts = anomalies.reduce<Record<string, number>>((acc, a) => {
            acc[a.type] = (acc[a.type] ?? 0) + 1;
            return acc;
        }, {});

        return NextResponse.json({
            anomalies,
            counts,
            params: { months: opts.months },
            generatedAt: new Date().toISOString(),
        });
    } catch (error) {
        console.error('Error detecting spending anomalies:', error);
        return NextResponse.json(
            { error: 'Failed to detect spending anomalies' },
            { status: 500 }
        );
    }
}

/**
 * POST /api/tools/anomalies
 *
 * Runs a scan-and-notify now: detects anomalies and creates notifications for
 * any new ones (deduped). Requires 'edit' role. Same query params as GET.
 */
export async function POST(request: NextRequest) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;

        const { searchParams } = new URL(request.url);
        const opts = parseOptions(searchParams);

        const result = await scanForAnomalies(roleResult.bookGuid, {
            ...opts,
            userId: roleResult.user.id,
        });

        return NextResponse.json({
            ...result,
            generatedAt: new Date().toISOString(),
        });
    } catch (error) {
        console.error('Error running anomaly scan:', error);
        return NextResponse.json(
            { error: 'Failed to run anomaly scan' },
            { status: 500 }
        );
    }
}

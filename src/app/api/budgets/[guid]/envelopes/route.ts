import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import {
    getEnvelopeView,
    getEnvelopeConfig,
    upsertEnvelopeConfig,
    type EnvelopeConfig,
} from '@/lib/budget-envelope';

const GUID_RE = /^[0-9a-f]{32}$/i;

/**
 * @openapi
 * /api/budgets/{guid}/envelopes:
 *   get:
 *     description: >
 *       Envelope view for a budget: per-line rollover config, per-period
 *       carry-in / effective budget / effective remaining (envelope balances),
 *       and the currently-active alert conditions.
 *     parameters:
 *       - name: guid
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *       - name: asOf
 *         in: query
 *         required: false
 *         description: Override the as-of date (YYYY-MM-DD), mainly for testing.
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Envelope view payload.
 *       404:
 *         description: Budget not found.
 */
export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ guid: string }> }
) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const { guid } = await params;
        const { searchParams } = new URL(request.url);
        const asOfParam = searchParams.get('asOf');
        const asOf = asOfParam && /^\d{4}-\d{2}-\d{2}$/.test(asOfParam) ? asOfParam : undefined;

        const view = await getEnvelopeView(guid, { asOf });
        if (!view) {
            return NextResponse.json({ error: 'Budget not found' }, { status: 404 });
        }
        return NextResponse.json(view);
    } catch (error) {
        console.error('Error loading envelope view:', error);
        return NextResponse.json({ error: 'Failed to load envelope view' }, { status: 500 });
    }
}

interface RawConfigRow {
    accountGuid?: unknown;
    rolloverEnabled?: unknown;
    alertThresholdPct?: unknown;
    goalId?: unknown;
}

function parseConfigRows(body: unknown): { rows: EnvelopeConfig[] } | { error: string } {
    const raw = Array.isArray(body)
        ? body
        : body && typeof body === 'object' && Array.isArray((body as { rows?: unknown }).rows)
            ? (body as { rows: unknown[] }).rows
            : null;
    if (!raw) return { error: 'Expected an array of config rows (or { rows: [...] })' };

    const rows: EnvelopeConfig[] = [];
    for (const item of raw as RawConfigRow[]) {
        if (!item || typeof item !== 'object') return { error: 'Invalid config row' };
        const accountGuid = typeof item.accountGuid === 'string' ? item.accountGuid : '';
        if (!GUID_RE.test(accountGuid)) return { error: 'accountGuid must be a 32-char GUID' };

        const rolloverEnabled = typeof item.rolloverEnabled === 'boolean' ? item.rolloverEnabled : true;

        let alertThresholdPct: number | null = null;
        if (item.alertThresholdPct != null && item.alertThresholdPct !== '') {
            const n = Number(item.alertThresholdPct);
            if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 500) {
                return { error: 'alertThresholdPct must be an integer between 1 and 500' };
            }
            alertThresholdPct = n;
        }

        let goalId: number | null = null;
        if (item.goalId != null && item.goalId !== '') {
            const n = Number(item.goalId);
            if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
                return { error: 'goalId must be a positive integer' };
            }
            goalId = n;
        }

        rows.push({ accountGuid, rolloverEnabled, alertThresholdPct, goalId });
    }
    if (rows.length === 0) return { error: 'No config rows provided' };
    return { rows };
}

/**
 * @openapi
 * /api/budgets/{guid}/envelopes:
 *   put:
 *     description: >
 *       Upsert envelope config rows for a budget. Body is an array of
 *       { accountGuid, rolloverEnabled, alertThresholdPct, goalId }.
 *       Unique per (budget, account). Returns the full updated config.
 *     parameters:
 *       - name: guid
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Updated config rows.
 *       400:
 *         description: Invalid payload.
 */
export async function PUT(
    request: NextRequest,
    { params }: { params: Promise<{ guid: string }> }
) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;

        const { guid } = await params;
        if (!GUID_RE.test(guid)) {
            return NextResponse.json({ error: 'Invalid budget GUID' }, { status: 400 });
        }

        const body = await request.json().catch(() => null);
        const parsed = parseConfigRows(body);
        if ('error' in parsed) {
            return NextResponse.json({ error: parsed.error }, { status: 400 });
        }

        await upsertEnvelopeConfig(guid, parsed.rows);
        const config = await getEnvelopeConfig(guid);
        return NextResponse.json({ config });
    } catch (error) {
        console.error('Error saving envelope config:', error);
        return NextResponse.json({ error: 'Failed to save envelope config' }, { status: 500 });
    }
}

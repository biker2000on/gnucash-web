import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { isAccountInActiveBook } from '@/lib/book-scope';
import {
    getReconcileWorkspace,
    finalizeReconciliation,
    ManualReconcileError,
} from '@/lib/reconcile';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Parse a YYYY-MM-DD statement date as UTC midnight, or null if invalid. */
function parseStatementDate(raw: string | null): Date | null {
    if (!raw || !DATE_RE.test(raw)) return null;
    const date = new Date(`${raw}T00:00:00.000Z`);
    return Number.isNaN(date.getTime()) ? null : date;
}

function mapReconcileError(error: ManualReconcileError): NextResponse {
    const status =
        error.code === 'not_found' ? 404 : error.code === 'not_zero' ? 409 : 400;
    return NextResponse.json(
        { error: error.message, detail: error.detail },
        { status },
    );
}

/**
 * GET /api/accounts/[guid]/reconcile?statementDate=YYYY-MM-DD
 *
 * Manual-reconcile workspace (readonly role): last reconciliation info
 * (max reconcile_date among 'y' splits + reconciled balance) and the
 * candidate 'n'/'c' splits posted on or before the statement date.
 * statementDate defaults to today when omitted.
 */
export async function GET(
    request: Request,
    { params }: { params: Promise<{ guid: string }> },
) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const { guid } = await params;
        if (!await isAccountInActiveBook(guid)) {
            return NextResponse.json({ error: 'Account not found' }, { status: 404 });
        }

        const { searchParams } = new URL(request.url);
        const rawDate = searchParams.get('statementDate');
        const statementDate = rawDate
            ? parseStatementDate(rawDate)
            : parseStatementDate(new Date().toISOString().slice(0, 10));
        if (!statementDate) {
            return NextResponse.json(
                { error: 'Invalid statementDate; expected YYYY-MM-DD' },
                { status: 400 },
            );
        }

        const workspace = await getReconcileWorkspace(guid, statementDate);
        return NextResponse.json(workspace);
    } catch (error) {
        if (error instanceof ManualReconcileError) return mapReconcileError(error);
        console.error('Error building reconcile workspace:', error);
        return NextResponse.json(
            { error: 'Failed to build reconcile workspace' },
            { status: 500 },
        );
    }
}

interface FinalizeBody {
    statementDate?: string;
    endingBalance?: number;
    splitGuids?: string[];
}

/**
 * POST /api/accounts/[guid]/reconcile
 *
 * Finalize a manual reconciliation (edit role).
 * Body: { statementDate: 'YYYY-MM-DD', endingBalance: number, splitGuids: string[] }
 *
 * The difference is recomputed server-side from the database; when it is not
 * exactly 0.00 the request fails 409 with the recomputed difference. On
 * success the selected splits are set reconcile_state='y' with
 * reconcile_date = statement date (same semantics as the statement-upload
 * reconcile flow) inside one DB transaction.
 */
export async function POST(
    request: Request,
    { params }: { params: Promise<{ guid: string }> },
) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;

        const { guid } = await params;
        if (!await isAccountInActiveBook(guid)) {
            return NextResponse.json({ error: 'Account not found' }, { status: 404 });
        }

        const body: FinalizeBody = await request.json();

        const statementDate = parseStatementDate(body.statementDate ?? null);
        if (!statementDate) {
            return NextResponse.json(
                { error: 'statementDate is required (YYYY-MM-DD)' },
                { status: 400 },
            );
        }
        if (typeof body.endingBalance !== 'number' || !Number.isFinite(body.endingBalance)) {
            return NextResponse.json(
                { error: 'endingBalance must be a finite number' },
                { status: 400 },
            );
        }
        if (
            !Array.isArray(body.splitGuids) ||
            body.splitGuids.some((g) => typeof g !== 'string' || g.length === 0)
        ) {
            return NextResponse.json(
                { error: 'splitGuids must be an array of split GUIDs' },
                { status: 400 },
            );
        }

        const result = await finalizeReconciliation(
            guid,
            statementDate,
            body.endingBalance,
            body.splitGuids,
        );
        return NextResponse.json({ success: true, ...result });
    } catch (error) {
        if (error instanceof ManualReconcileError) return mapReconcileError(error);
        console.error('Error finalizing manual reconciliation:', error);
        return NextResponse.json(
            { error: 'Failed to finalize reconciliation' },
            { status: 500 },
        );
    }
}

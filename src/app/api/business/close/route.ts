import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import prisma from '@/lib/prisma';
import { getLockDate, setLockDate } from '@/lib/services/book-settings.service';

/**
 * Month-end close: a per-month checklist plus the book's period lock date.
 *
 * Checklist state reuses gnucash_web_compliance_status rows with item_key
 * prefixed 'close-' and period = the month being closed ('2026-06'). The
 * compliance calendar merges statuses by its own item keys, so close- rows
 * never leak into it.
 */

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface CloseChecklistItemDef {
    key: string;
    title: string;
    description: string;
    links: Array<{ label: string; href: string }>;
}

const CLOSE_CHECKLIST_ITEMS: CloseChecklistItemDef[] = [
    {
        key: 'close-reconcile',
        title: 'Reconcile bank & credit card accounts',
        description: 'Tie every cash account out to its statement for the month.',
        links: [{ label: 'Statements', href: '/statements' }],
    },
    {
        key: 'close-ar',
        title: 'Review AR aging',
        description: 'Chase overdue invoices and confirm receivable balances are real.',
        links: [{ label: 'AR/AP Aging', href: '/business/reports/aging' }],
    },
    {
        key: 'close-ap',
        title: 'Review AP aging',
        description: 'Confirm every vendor bill is entered and payables are complete.',
        links: [{ label: 'AR/AP Aging', href: '/business/reports/aging' }],
    },
    {
        key: 'close-uncategorized',
        title: 'Review uncategorized & imbalanced transactions',
        description: 'Clear Imbalance/Orphan activity so the statements are trustworthy.',
        links: [{ label: 'Data Health', href: '/tools/data-health' }],
    },
    {
        key: 'close-reports',
        title: 'Run P&L and Balance Sheet',
        description: 'Read both statements for the month and sanity-check the numbers.',
        links: [
            { label: 'Income Statement', href: '/reports/income_statement' },
            { label: 'Balance Sheet', href: '/reports/balance_sheet' },
        ],
    },
];

const CLOSE_ITEM_KEYS = new Set(CLOSE_CHECKLIST_ITEMS.map((i) => i.key));

/** Last day of a YYYY-MM month as YYYY-MM-DD. */
function monthEnd(month: string): string {
    const [y, m] = month.split('-').map(Number);
    const last = new Date(Date.UTC(y, m, 0)); // day 0 of next month
    return last.toISOString().slice(0, 10);
}

/** The month before the current one (the period you typically close). */
function defaultMonth(): string {
    const now = new Date();
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    return d.toISOString().slice(0, 7);
}

async function buildState(bookGuid: string, month: string, role: string) {
    const [lockDate, statusRows] = await Promise.all([
        getLockDate(bookGuid),
        prisma.gnucash_web_compliance_status.findMany({
            where: {
                book_guid: bookGuid,
                period: month,
                item_key: { in: CLOSE_CHECKLIST_ITEMS.map((i) => i.key) },
            },
        }),
    ]);
    const statusByKey = new Map(statusRows.map((r) => [r.item_key, r]));
    const end = monthEnd(month);

    return {
        month,
        monthEnd: end,
        lockDate,
        /** True when this month is already inside the locked period. */
        monthLocked: lockDate !== null && end <= lockDate,
        role,
        items: CLOSE_CHECKLIST_ITEMS.map((i) => {
            const row = statusByKey.get(i.key);
            return {
                ...i,
                status: row ? ('done' as const) : ('pending' as const),
                completedAt: row ? row.completed_at.toISOString() : null,
            };
        }),
    };
}

/**
 * GET /api/business/close?month=2026-06
 * Close state for one month: checklist statuses + current lock date.
 * Defaults to the previous calendar month. Auth: readonly.
 */
export async function GET(request: NextRequest) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const monthParam = new URL(request.url).searchParams.get('month');
        const month = monthParam ?? defaultMonth();
        if (!MONTH_RE.test(month)) {
            return NextResponse.json({ error: 'month must be YYYY-MM' }, { status: 400 });
        }

        return NextResponse.json(await buildState(roleResult.bookGuid, month, roleResult.role));
    } catch (error) {
        console.error('Error loading close state:', error);
        return NextResponse.json({ error: 'Failed to load close state' }, { status: 500 });
    }
}

/**
 * PUT /api/business/close
 *
 * Two actions:
 *   { action: 'checklist', month, itemKey, done: boolean }  — edit role
 *   { action: 'lockDate', lockDate: 'YYYY-MM-DD' | null }   — admin only
 *     (setting the lock date IS closing the period)
 *
 * Returns the refreshed state for the given (or default) month.
 */
export async function PUT(request: NextRequest) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;
        const { bookGuid, role } = roleResult;

        const body = await request.json().catch(() => null) as {
            action?: unknown; month?: unknown; itemKey?: unknown; done?: unknown; lockDate?: unknown;
        } | null;
        if (!body || typeof body !== 'object') {
            return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
        }

        if (body.action === 'checklist') {
            const month = typeof body.month === 'string' ? body.month : '';
            const itemKey = typeof body.itemKey === 'string' ? body.itemKey : '';
            if (!MONTH_RE.test(month)) {
                return NextResponse.json({ error: 'month must be YYYY-MM' }, { status: 400 });
            }
            if (!CLOSE_ITEM_KEYS.has(itemKey)) {
                return NextResponse.json({ error: `Unknown checklist item: ${itemKey}` }, { status: 400 });
            }
            if (typeof body.done !== 'boolean') {
                return NextResponse.json({ error: 'done must be a boolean' }, { status: 400 });
            }

            if (body.done) {
                await prisma.gnucash_web_compliance_status.upsert({
                    where: {
                        book_guid_item_key_period: { book_guid: bookGuid, item_key: itemKey, period: month },
                    },
                    create: { book_guid: bookGuid, item_key: itemKey, period: month, status: 'done' },
                    update: { status: 'done', completed_at: new Date() },
                });
            } else {
                await prisma.gnucash_web_compliance_status.deleteMany({
                    where: { book_guid: bookGuid, item_key: itemKey, period: month },
                });
            }
            return NextResponse.json(await buildState(bookGuid, month, role));
        }

        if (body.action === 'lockDate') {
            // Locking (or unlocking) a period is an admin decision.
            const adminResult = await requireRole('admin');
            if (adminResult instanceof NextResponse) return adminResult;

            const lockDate = body.lockDate;
            if (lockDate !== null && (typeof lockDate !== 'string' || !DATE_RE.test(lockDate))) {
                return NextResponse.json({ error: 'lockDate must be YYYY-MM-DD or null' }, { status: 400 });
            }
            await setLockDate(bookGuid, lockDate as string | null);

            const month = typeof body.month === 'string' && MONTH_RE.test(body.month)
                ? body.month
                : defaultMonth();
            return NextResponse.json(await buildState(bookGuid, month, adminResult.role));
        }

        return NextResponse.json({ error: "action must be 'checklist' or 'lockDate'" }, { status: 400 });
    } catch (error) {
        console.error('Error updating close state:', error);
        return NextResponse.json({ error: 'Failed to update close state' }, { status: 500 });
    }
}

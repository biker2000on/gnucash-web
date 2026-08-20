import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { requireRole } from '@/lib/auth';
import { getAccountGuidsForBook } from '@/lib/book-scope';
import { buildAccountPathMap } from '@/lib/reports/utils';
import { buildTransactionHistory, type AuditRowLike } from '@/lib/transaction-history';

/** Audit rows one request will render. Beyond this the response says `hasMore`. */
const MAX_HISTORY_ROWS = 500;

/** Every `account_guid` named by the splits inside one audit payload. */
function collectAccountGuids(payload: unknown, into: Set<string>): void {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
    const splits = (payload as { splits?: unknown }).splits;
    if (!Array.isArray(splits)) return;
    for (const split of splits) {
        const accountGuid = (split as { account_guid?: unknown } | null)?.account_guid;
        if (typeof accountGuid === 'string' && accountGuid !== '') into.add(accountGuid);
    }
}

/**
 * GET /api/transactions/{guid}/history
 *
 * The transaction's change timeline: its own audit entries plus the entries
 * for each of its splits, rendered as human-readable field-level diffs.
 *
 * Book-scoped twice over — the transaction must have a split in the caller's
 * book, and only audit rows attributed to that book (or to no book at all, for
 * rows written before `book_guid` existed) are read.
 */
export async function GET(
    request: Request,
    { params }: { params: Promise<{ guid: string }> },
) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const { guid } = await params;
        const bookAccountGuids = await getAccountGuidsForBook(roleResult.bookGuid);

        const splits = await prisma.splits.findMany({
            where: { tx_guid: guid, account_guid: { in: bookAccountGuids } },
            select: { guid: true, account_guid: true },
        });
        if (splits.length === 0) {
            // A transaction outside the caller's book is indistinguishable
            // from one that does not exist.
            return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });
        }

        // Splits deleted by an edit no longer exist, so their guids come from
        // the transaction's own snapshots rather than the live rows: the
        // entity_guid list below is "every split we can still see", and the
        // TRANSACTION rows carry the rest of the story in their snapshots.
        const entityGuids = [guid, ...splits.map(split => split.guid)];

        // Newest first with one probe row: a transaction with more than the
        // cap has its *oldest* entries dropped, and `hasMore` lets the feed
        // say so rather than silently presenting a partial history as whole.
        const rows = await prisma.$queryRaw<AuditRowLike[]>`
            SELECT id, action, entity_type, entity_guid, old_values, new_values,
                   created_at, user_id, undone_at
            FROM gnucash_web_audit
            WHERE entity_guid = ANY(${entityGuids}::text[])
              AND (book_guid IS NULL OR book_guid = ${roleResult.bookGuid})
            ORDER BY created_at DESC, id DESC
            LIMIT ${MAX_HISTORY_ROWS + 1}
        `;
        const hasMore = rows.length > MAX_HISTORY_ROWS;
        if (hasMore) rows.length = MAX_HISTORY_ROWS;

        const userIds = [...new Set(rows.map(row => row.user_id).filter((id): id is number => id !== null))];
        const users = userIds.length === 0
            ? []
            : await prisma.gnucash_web_users.findMany({
                where: { id: { in: userIds } },
                select: { id: true, username: true, display_name: true },
            });
        const userNames = new Map(users.map(user => [user.id, user.display_name || user.username]));

        // Account paths for every account a diff can name. The canonical
        // builder is what the reports use, so the timeline spells a path the
        // same way the rest of the app does (root excluded).
        const accountPaths = await buildAccountPathMap(bookAccountGuids);

        // The transaction's own currency. `split.value` is denominated in it,
        // so without this every diff would render a EUR book's amounts as
        // dollars.
        const transaction = await prisma.transactions.findUnique({
            where: { guid },
            select: { currency: { select: { mnemonic: true } } },
        });

        // Commodity namespace per account a diff can name — how the renderer
        // tells a share leg from a cross-currency cash leg (both have
        // value ≠ quantity). Only the accounts actually referenced are
        // looked up: the live splits, plus any account named in a snapshot
        // whose split has since been deleted.
        const namespaceGuids = new Set<string>(
            splits.map(split => split.account_guid).filter((g): g is string => !!g),
        );
        for (const row of rows) collectAccountGuids(row.old_values, namespaceGuids);
        for (const row of rows) collectAccountGuids(row.new_values, namespaceGuids);
        const accountRows = namespaceGuids.size === 0
            ? []
            : await prisma.accounts.findMany({
                where: { guid: { in: [...namespaceGuids] } },
                select: { guid: true, commodity: { select: { namespace: true } } },
            });
        const namespaces = new Map(
            accountRows.map(account => [account.guid, account.commodity?.namespace ?? undefined]),
        );

        const events = buildTransactionHistory(rows, {
            accountPath: accountGuid => accountPaths.get(accountGuid),
            userName: id => userNames.get(id),
            currency: transaction?.currency?.mnemonic ?? undefined,
            accountNamespace: accountGuid => namespaces.get(accountGuid),
        });

        return NextResponse.json({ events, hasMore, limit: MAX_HISTORY_ROWS });
    } catch (error) {
        console.error('Error building transaction history:', error);
        return NextResponse.json({ error: 'Failed to load transaction history' }, { status: 500 });
    }
}

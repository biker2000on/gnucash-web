import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { requireAuth, requireRole } from '@/lib/auth';
import {
    getUserRoleForBook,
    hasMinimumRole,
} from '@/lib/services/permission.service';
import { acquireBookLock } from '@/lib/book-lock';
import {
    collectBookStorageKeys,
    deleteBookExtensionRows,
    deleteStoredFileKeys,
} from '@/lib/services/book-cleanup.service';
import { cacheInvalidateAllForBook } from '@/lib/cache';
import { publishDataChange } from '@/lib/data-events';
import { deleteOwnedBudgetsForBook } from '@/lib/budget-ownership';
import { deleteOwnedBusinessEntitiesForBook } from '@/lib/business/entity-ownership';
import { hasTargetBookRole } from '@/lib/target-book-auth';

/**
 * GET /api/books/[guid]
 * Get book details.
 */
export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ guid: string }> }
) {
    try {
        const authResult = await requireAuth();
        if (authResult instanceof NextResponse) return authResult;

        const { guid } = await params;
        if (!await hasMinimumRole(authResult.user.id, guid, 'readonly')) {
            return NextResponse.json(
                { error: 'Requires access to the target book' },
                { status: 403 },
            );
        }

        const book = await prisma.books.findUnique({
            where: { guid },
        });

        if (!book) {
            return NextResponse.json({ error: 'Book not found' }, { status: 404 });
        }

        const rootAccount = await prisma.accounts.findUnique({
            where: { guid: book.root_account_guid },
            select: { name: true },
        });

        const accountCount = await prisma.$queryRaw<{ count: bigint }[]>`
            WITH RECURSIVE account_tree AS (
                SELECT guid FROM accounts WHERE guid = ${book.root_account_guid}
                UNION ALL
                SELECT a.guid FROM accounts a
                JOIN account_tree t ON a.parent_guid = t.guid
            )
            SELECT COUNT(*)::bigint as count FROM account_tree
            WHERE guid != ${book.root_account_guid}
        `;

        // Optionally include the book's users + roles (admins only)
        let users: {
            userId: number;
            username: string;
            email: string | null;
            role: string;
            authMethod: string;
            grantedAt: Date | null;
        }[] | undefined;
        if (request.nextUrl.searchParams.get('includeUsers') === 'true') {
            const requesterRole = await getUserRoleForBook(authResult.user.id, guid);
            if (requesterRole === 'admin') {
                const rows = await prisma.gnucash_web_book_permissions.findMany({
                    where: { book_guid: guid },
                    include: {
                        role: true,
                        user: {
                            select: {
                                id: true,
                                username: true,
                                email: true,
                                auth_method: true,
                            },
                        },
                    },
                });
                users = rows
                    .map((p) => ({
                        userId: p.user.id,
                        username: p.user.username,
                        email: p.user.email,
                        role: p.role.name,
                        authMethod: p.user.auth_method,
                        grantedAt: p.granted_at,
                    }))
                    .sort((a, b) => a.username.localeCompare(b.username));
            }
        }

        return NextResponse.json({
            guid: book.guid,
            name: book.name ?? rootAccount?.name ?? 'Unnamed Book',
            description: book.description,
            rootAccountGuid: book.root_account_guid,
            rootTemplateGuid: book.root_template_guid,
            accountCount: Number(accountCount[0]?.count || 0),
            ...(users ? { users } : {}),
        });
    } catch (error) {
        console.error('Error fetching book:', error);
        return NextResponse.json({ error: 'Failed to fetch book' }, { status: 500 });
    }
}

/**
 * PUT /api/books/[guid]
 * Update book name and/or description.
 */
export async function PUT(
    request: NextRequest,
    { params }: { params: Promise<{ guid: string }> }
) {
    try {
        const roleResult = await requireRole('admin');
        if (roleResult instanceof NextResponse) return roleResult;

        const { guid } = await params;
        if (!await hasTargetBookRole(roleResult, guid, 'admin')) {
            return NextResponse.json(
                { error: 'Requires admin role for the target book' },
                { status: 403 },
            );
        }
        const body = await request.json();
        const { name, description } = body;

        // Validate inputs
        if (name !== undefined) {
            if (typeof name !== 'string' || name.trim().length === 0 || name.trim().length > 255) {
                return NextResponse.json({ error: 'Name must be a non-empty string under 255 characters' }, { status: 400 });
            }
        }
        if (description !== undefined && description !== null) {
            if (typeof description !== 'string' || description.length > 2000) {
                return NextResponse.json({ error: 'Description must be under 2000 characters' }, { status: 400 });
            }
        }

        const book = await prisma.books.findUnique({
            where: { guid },
        });

        if (!book) {
            return NextResponse.json({ error: 'Book not found' }, { status: 404 });
        }

        // Update books table with name and description
        await prisma.books.update({
            where: { guid },
            data: {
                name: name ? name.trim() : undefined,
                description: description !== undefined ? (description || null) : undefined,
            },
        });

        // If name is provided, also update root account name
        if (name && typeof name === 'string' && name.trim().length > 0) {
            await prisma.accounts.update({
                where: { guid: book.root_account_guid },
                data: { name: name.trim() },
            });
        }

        return NextResponse.json({
            guid,
            name: name ? name.trim() : undefined,
            description: description !== undefined ? (description || null) : undefined
        });
    } catch (error) {
        console.error('Error updating book:', error);
        return NextResponse.json({ error: 'Failed to update book' }, { status: 500 });
    }
}

/**
 * DELETE /api/books/[guid]
 * Delete book and all associated accounts/transactions.
 */
export async function DELETE(
    request: NextRequest,
    { params }: { params: Promise<{ guid: string }> }
) {
    try {
        const roleResult = await requireRole('admin');
        if (roleResult instanceof NextResponse) return roleResult;

        const { guid } = await params;
        if (!await hasTargetBookRole(roleResult, guid, 'admin')) {
            return NextResponse.json(
                { error: 'Requires admin role for the target book' },
                { status: 403 },
            );
        }

        const book = await prisma.books.findUnique({
            where: { guid },
        });

        if (!book) {
            return NextResponse.json({ error: 'Book not found' }, { status: 404 });
        }

        // Everything — tree enumeration, extension-table cleanup, core-row
        // deletion — happens inside ONE transaction holding the per-book
        // advisory lock, so a concurrently created account cannot orphan the
        // tree and a failed core deletion no longer leaves extension data
        // already destroyed. Stored files (S3/filesystem) cannot be deleted
        // transactionally: their keys are collected inside the transaction
        // and the files are removed only after a successful commit.
        let storageKeys: string[] = [];
        const remainingBooks = await prisma.$transaction(async (tx) => {
            // Serialize against imports, scrubs, reparenting, and other
            // deletes of this book (blocking acquire).
            await acquireBookLock(tx, guid, 'book-delete');

            // Re-read under the lock — a concurrent delete may have won.
            const lockedBook = await tx.books.findUnique({ where: { guid } });
            if (!lockedBook) {
                return null;
            }

            // Enumerate both account trees INSIDE the transaction, with
            // depth so children can be deleted before parents.
            const treeRoots = [...new Set([
                lockedBook.root_account_guid,
                lockedBook.root_template_guid,
            ])].filter((g): g is string => Boolean(g));

            const byGuid = new Map<string, number>();
            for (const rootGuid of treeRoots) {
                const tree = await tx.$queryRaw<{ guid: string; depth: number }[]>`
                    WITH RECURSIVE account_tree AS (
                        SELECT guid, 0 AS depth FROM accounts WHERE guid = ${rootGuid}
                        UNION ALL
                        SELECT a.guid, t.depth + 1 FROM accounts a
                        JOIN account_tree t ON a.parent_guid = t.guid
                    )
                    SELECT guid, depth FROM account_tree
                `;
                for (const row of tree) {
                    byGuid.set(row.guid, Math.max(byGuid.get(row.guid) ?? 0, Number(row.depth)));
                }
            }
            const allAccountGuids = [...byGuid.keys()];

            // Collect stored-file keys while their DB rows still exist;
            // deletion happens after commit.
            storageKeys = await collectBookStorageKeys(guid, tx);

            // Remove all extension-table rows (gnucash_web_*) for this book
            // BEFORE the core deletion: several cleanups derive their row
            // sets from the book's splits/transactions.
            await deleteBookExtensionRows(tx, guid, allAccountGuids, {
                includeLazyTables: true,
            });

            // Remove native budgets explicitly owned by this book. Native
            // recurrences use a restrictive FK, so they must go first.
            await deleteOwnedBudgetsForBook(tx, guid);

            // Native business entities (customers, vendors, invoices, ...) also
            // carry no book column. They must go before the transactions and
            // accounts below, because a posted invoice references both.
            await deleteOwnedBusinessEntitiesForBook(tx, guid);

            // Remove legacy/unowned budget amounts that still reference these
            // accounts. Ambiguous budgets remain unowned and fail closed.
            await tx.budget_amounts.deleteMany({
                where: { account_guid: { in: allAccountGuids } },
            });

            // Capture the transactions touched by this book's splits BEFORE
            // deleting the splits, so the transaction cleanup below can be
            // scoped to exactly those rows instead of sweeping split-less
            // transactions from every book.
            const touchedTxRows = allAccountGuids.length > 0
                ? await tx.$queryRaw<{ tx_guid: string }[]>`
                    SELECT DISTINCT tx_guid FROM splits
                    WHERE account_guid = ANY(${allAccountGuids}::text[])
                `
                : [];
            const touchedTxGuids = touchedTxRows.map(r => r.tx_guid);

            // The slots table has no FK on obj_guid, so every object removed
            // below (splits, lots, transactions, accounts, the book row) must
            // take its slots with it explicitly or they leak as orphans.
            if (allAccountGuids.length > 0) {
                await tx.$executeRaw`
                    DELETE FROM slots WHERE obj_guid IN (
                        SELECT guid FROM splits
                        WHERE account_guid = ANY(${allAccountGuids}::text[])
                    )
                `;
            }

            // Delete splits for these accounts
            await tx.splits.deleteMany({
                where: { account_guid: { in: allAccountGuids } },
            });

            // Lots belong to this book's accounts and their splits are gone;
            // delete the lots and their slots (title, acquisition_date, ...).
            if (allAccountGuids.length > 0) {
                await tx.$executeRaw`
                    DELETE FROM slots WHERE obj_guid IN (
                        SELECT guid FROM lots
                        WHERE account_guid = ANY(${allAccountGuids}::text[])
                    )
                `;
                await tx.lots.deleteMany({
                    where: { account_guid: { in: allAccountGuids } },
                });
            }

            // Delete exactly the touched transactions that now have no
            // splits left (a transaction shared with another book — should
            // not happen, but — keeps its remaining splits and survives).
            if (touchedTxGuids.length > 0) {
                await tx.$executeRaw`
                    DELETE FROM transactions
                    WHERE guid = ANY(${touchedTxGuids}::text[])
                      AND NOT EXISTS (
                        SELECT 1 FROM splits s WHERE s.tx_guid = transactions.guid
                      )
                `;
                // Slots of exactly the transactions deleted above (a shared
                // transaction that survived keeps its slots).
                await tx.$executeRaw`
                    DELETE FROM slots
                    WHERE obj_guid = ANY(${touchedTxGuids}::text[])
                      AND NOT EXISTS (
                        SELECT 1 FROM transactions t WHERE t.guid = slots.obj_guid
                      )
                `;
            }

            // Delete accounts children-first: batch per depth level,
            // deepest first (ordering guaranteed by the recursive CTE depth).
            const depths = [...new Set(byGuid.values())].sort((a, b) => b - a);
            for (const depth of depths) {
                const batch = allAccountGuids.filter(g => byGuid.get(g) === depth);
                await tx.accounts.deleteMany({
                    where: { guid: { in: batch } },
                });
            }

            // Account slots (notes, color, ...) and book slots (counters,
            // gnucash-web/closed-through, ...) go with their objects.
            if (allAccountGuids.length > 0) {
                await tx.slots.deleteMany({
                    where: { obj_guid: { in: allAccountGuids } },
                });
            }
            await tx.slots.deleteMany({ where: { obj_guid: guid } });

            // Delete the book record
            await tx.books.delete({
                where: { guid },
            });

            // Return remaining book count
            return await tx.books.count();
        }, { timeout: 300_000, maxWait: 15_000 });

        if (remainingBooks === null) {
            return NextResponse.json({ error: 'Book not found' }, { status: 404 });
        }

        // Post-commit, best-effort file cleanup.
        await deleteStoredFileKeys(storageKeys);

        void cacheInvalidateAllForBook(guid);
        void publishDataChange(guid, 'book', { guid, action: 'delete' });

        return NextResponse.json({ success: true, remainingBooks });
    } catch (error) {
        console.error('Error deleting book:', error);
        return NextResponse.json({ error: 'Failed to delete book' }, { status: 500 });
    }
}

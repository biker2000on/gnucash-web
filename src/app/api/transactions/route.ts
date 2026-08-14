import { NextResponse } from 'next/server';
import prisma, { toDecimal, generateGuid } from '@/lib/prisma';
import { serializeBigInts } from '@/lib/gnucash';
import { CreateTransactionRequest } from '@/lib/types';
import { validateTransaction, summarizeValidationErrors } from '@/lib/validation';
import { isValidGuid } from '@/lib/guid';
import { Prisma } from '@prisma/client';
import { logAudit, snapshotTransactionByGuid } from '@/lib/services/audit.service';
import { processMultiCurrencySplits } from '@/lib/trading-accounts';
import { getBookAccountGuids, getActiveBookGuid } from '@/lib/book-scope';
import { cacheInvalidateFrom } from '@/lib/cache';
import { publishDataChange } from '@/lib/data-events';
import { requireRole } from '@/lib/auth';
import { buildAccountPathMap } from '@/lib/reports/utils';
import { parseSearchQuery } from '@/lib/tags';
import { getTagsForTransactions } from '@/lib/services/tag.service';
import { writeTransactionNotes } from '@/lib/transaction-notes';
import {
    withPeriodLockCheck,
    assertNotLocked,
    PeriodLockedError,
    periodLockedResponse,
} from '@/lib/services/period-lock.service';

/**
 * Parse a non-negative integer query param, falling back to `fallback` when the
 * value is absent, unparseable, or negative. LIMIT/OFFSET are now real SQL
 * clauses, and PostgreSQL rejects a negative or NaN bind there.
 */
function nonNegativeIntParam(raw: string | null, fallback: number): number {
    if (raw === null || raw.trim() === '') return fallback;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 0) return fallback;
    return parsed;
}

/**
 * Parse an amount-bound query param into a decimal STRING for a `::numeric`
 * cast in SQL. Returned as text (not a JS number) so the bound reaches
 * PostgreSQL as an exact decimal rather than a binary float. Returns null for
 * absent or non-numeric input, which drops the bound rather than erroring the
 * query.
 */
function numericParam(raw: string | null): string | null {
    if (raw === null || raw.trim() === '') return null;
    const trimmed = raw.trim();
    // A well-formed decimal is handed to PostgreSQL verbatim, so a bound like
    // 0.005 is compared exactly and not through a float64 round-trip.
    if (/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) return trimmed;
    // Anything else keeps the old lenient parseFloat behaviour ("12abc" -> 12).
    const parsed = Number.parseFloat(trimmed);
    return Number.isFinite(parsed) ? String(parsed) : null;
}

/**
 * @openapi
 * /api/transactions:
 *   get:
 *     description: Returns a paginated list of transactions with their splits.
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *         description: Number of transactions to return.
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *         description: Number of transactions to skip.
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Search query to filter transactions by description, number, or account name.
 *       - in: query
 *         name: startDate
 *         schema:
 *           type: string
 *           format: date
 *         description: Filter transactions on or after this date (ISO 8601).
 *       - in: query
 *         name: endDate
 *         schema:
 *           type: string
 *           format: date
 *         description: Filter transactions on or before this date (ISO 8601).
 *       - in: query
 *         name: accountTypes
 *         schema:
 *           type: string
 *         description: Comma-separated list of account types to filter by (e.g., ASSET,EXPENSE).
 *       - in: query
 *         name: minAmount
 *         schema:
 *           type: number
 *         description: >
 *           Minimum absolute split amount. A transaction matches when at least
 *           one of its splits has |value| within [minAmount, maxAmount]; both
 *           bounds are tested against the SAME split.
 *       - in: query
 *         name: maxAmount
 *         schema:
 *           type: number
 *         description: >
 *           Maximum absolute split amount. See minAmount — both bounds apply to
 *           the same split.
 *       - in: query
 *         name: reconcileStates
 *         schema:
 *           type: string
 *         description: Comma-separated reconciliation states (n=not reconciled, c=cleared, y=reconciled).
 *     responses:
 *       200:
 *         description: A list of transactions.
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Transaction'
 */
export async function GET(request: Request) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const { searchParams } = new URL(request.url);
        const limit = nonNegativeIntParam(searchParams.get('limit'), 100);
        const offset = nonNegativeIntParam(searchParams.get('offset'), 0);
        // '#tag' tokens in the search act as tag filters (AND semantics);
        // remaining text is the normal description/num/account search.
        const { text: search, tags: tagFilters } = parseSearchQuery(searchParams.get('search') || '');
        const startDate = searchParams.get('startDate');
        const endDate = searchParams.get('endDate');
        const accountTypes = searchParams.get('accountTypes');
        const minAmount = searchParams.get('minAmount');
        const maxAmount = searchParams.get('maxAmount');
        const reconcileStates = searchParams.get('reconcileStates');

        // Get book account GUIDs for scoping
        const bookAccountGuids = await getBookAccountGuids();

        // Every filter below is expressed as a SQL predicate on `transactions t`
        // and evaluated in the SAME query that paginates, so a requested page is
        // a page of MATCHES. Filtering after LIMIT/OFFSET (as this route used to
        // do for amount and reconcile state) both hid matching rows that landed
        // on a later page and under-filled every page it did return.
        //
        // Each split-level predicate is an EXISTS subquery, which is what makes
        // the result de-duplicated by construction: a transaction with twenty
        // splits is still one row, and the matching split may be any of them,
        // not just the first.
        const filters: Prisma.Sql[] = [];

        // Book scoping, merged with the account-type filter when present (a
        // transaction qualifies via a single split that is both in-book and of a
        // requested type — same semantics as the previous Prisma `splits.some`).
        const types = accountTypes
            ? accountTypes.split(',').map(t => t.trim().toUpperCase()).filter(Boolean)
            : [];
        filters.push(types.length > 0
            ? Prisma.sql`EXISTS (
                SELECT 1 FROM splits s
                JOIN accounts a ON a.guid = s.account_guid
                WHERE s.tx_guid = t.guid
                  AND s.account_guid = ANY(${bookAccountGuids}::text[])
                  AND a.account_type = ANY(${types}::text[])
            )`
            : Prisma.sql`EXISTS (
                SELECT 1 FROM splits s
                WHERE s.tx_guid = t.guid
                  AND s.account_guid = ANY(${bookAccountGuids}::text[])
            )`);

        // Date filters
        if (startDate) {
            filters.push(Prisma.sql`t.post_date >= ${new Date(startDate)}`);
        }
        if (endDate) {
            filters.push(Prisma.sql`t.post_date <= ${new Date(endDate)}`);
        }

        // Search filter (description, num, or account name)
        if (search) {
            const like = `%${search}%`;
            filters.push(Prisma.sql`(
                t.description ILIKE ${like}
                OR t.num ILIKE ${like}
                OR EXISTS (
                    SELECT 1 FROM splits s
                    JOIN accounts a ON a.guid = s.account_guid
                    WHERE s.tx_guid = t.guid AND a.name ILIKE ${like}
                )
            )`);
        }

        // Tag filters: a transaction matches a tag when it carries the tag
        // directly OR any of its splits' accounts carries it (account tags
        // propagate to transactions). Multiple tags AND together.
        for (const name of tagFilters) {
            filters.push(Prisma.sql`(
                EXISTS (
                    SELECT 1 FROM gnucash_web_transaction_tags tt
                    JOIN gnucash_web_tags g ON g.id = tt.tag_id
                    WHERE tt.transaction_guid = t.guid AND g.name = ${name}
                )
                OR EXISTS (
                    SELECT 1 FROM splits s
                    JOIN gnucash_web_account_tags at2 ON at2.account_guid = s.account_guid
                    JOIN gnucash_web_tags g ON g.id = at2.tag_id
                    WHERE s.tx_guid = t.guid AND g.name = ${name}
                )
            )`);
        }

        // Amount range. GnuCash stores each split value as a num/denom fraction
        // whose denominator is NOT always a power of ten, so the comparison is
        // done as an exact rational in PostgreSQL `numeric` — never in float and
        // never by string-padding the numerator (see src/lib/reports/utils.ts,
        // which uses the same `::numeric / NULLIF(denom, 0)::numeric` idiom).
        // The bounds are passed as text and cast to numeric so no binary float
        // ever touches the comparison.
        //
        // SEMANTICS: absolute value of a SINGLE split, and both bounds are
        // tested against that same split — i.e. "this transaction has a line
        // between $min and $max". Split-level (not transaction-total) because
        // the journal renders every split of every row, so a per-split match is
        // exactly what the user sees on screen.
        const minVal = numericParam(minAmount);
        const maxVal = numericParam(maxAmount);
        if (minVal !== null || maxVal !== null) {
            const bounds: Prisma.Sql[] = [];
            if (minVal !== null) {
                bounds.push(Prisma.sql`abs(s.value_num::numeric / NULLIF(s.value_denom, 0)::numeric) >= ${minVal}::numeric`);
            }
            if (maxVal !== null) {
                bounds.push(Prisma.sql`abs(s.value_num::numeric / NULLIF(s.value_denom, 0)::numeric) <= ${maxVal}::numeric`);
            }
            filters.push(Prisma.sql`EXISTS (
                SELECT 1 FROM splits s
                WHERE s.tx_guid = t.guid AND ${Prisma.join(bounds, ' AND ')}
            )`);
        }

        // Reconcile state: transaction matches when any split is in one of the
        // requested states.
        const states = reconcileStates
            ? reconcileStates.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
            : [];
        if (states.length > 0) {
            filters.push(Prisma.sql`EXISTS (
                SELECT 1 FROM splits s
                WHERE s.tx_guid = t.guid
                  AND lower(s.reconcile_state) = ANY(${states}::text[])
            )`);
        }

        // Page of matching transaction GUIDs. The guid tiebreaker keeps the
        // order total: post_date alone has ties, and an unstable order makes
        // LIMIT/OFFSET paging duplicate and skip rows across pages.
        const pageRows = await prisma.$queryRaw<{ guid: string }[]>`
            SELECT t.guid
            FROM transactions t
            WHERE ${Prisma.join(filters, ' AND ')}
            ORDER BY t.post_date DESC, t.guid ASC
            LIMIT ${limit} OFFSET ${offset}
        `;
        const pageGuids = pageRows.map(r => r.guid);

        // Hydrate the page (all splits of each matching transaction, not just
        // the splits that matched the filter).
        const pageTransactions = pageGuids.length > 0
            ? await prisma.transactions.findMany({
                where: { guid: { in: pageGuids } },
                include: {
                    splits: {
                        include: {
                            // Narrow to the only relation fields the response uses
                            // (account_name, commodity_mnemonic) instead of every
                            // column of accounts + commodities per split.
                            account: {
                                select: {
                                    name: true,
                                    commodity: { select: { mnemonic: true } },
                                },
                            },
                        },
                    },
                },
            })
            : [];
        const byGuid = new Map(pageTransactions.map(tx => [tx.guid, tx]));
        const transactions = pageGuids
            .map(guid => byGuid.get(guid))
            .filter((tx): tx is (typeof pageTransactions)[number] => tx !== undefined);

        const accountPathMap = await buildAccountPathMap(bookAccountGuids);

        // Fetch receipt counts for the fetched transactions
        const txGuids = transactions.map(tx => tx.guid);
        const receiptCounts = txGuids.length > 0
            ? await prisma.$queryRaw<{ transaction_guid: string; receipt_count: bigint }[]>`
                SELECT gr.transaction_guid, COUNT(*) as receipt_count
                FROM gnucash_web_receipts gr
                WHERE gr.transaction_guid = ANY(${txGuids}::text[])
                  AND gr.book_guid = ${roleResult.bookGuid}
                GROUP BY gr.transaction_guid
            `
            : [];
        const receiptCountMap = new Map(receiptCounts.map(r => [r.transaction_guid, Number(r.receipt_count)]));

        // Fetch direct tags for the fetched transactions
        const tagMap = await getTagsForTransactions(txGuids);

        // Transform to response format
        const result = transactions.map(tx => ({
            guid: tx.guid,
            currency_guid: tx.currency_guid,
            num: tx.num,
            post_date: tx.post_date,
            enter_date: tx.enter_date,
            description: tx.description,
            receipt_count: receiptCountMap.get(tx.guid) ?? 0,
            tags: tagMap.get(tx.guid) ?? [],
            splits: tx.splits.map(split => ({
                guid: split.guid,
                tx_guid: split.tx_guid,
                account_guid: split.account_guid,
                memo: split.memo,
                action: split.action,
                reconcile_state: split.reconcile_state,
                reconcile_date: split.reconcile_date,
                value_num: split.value_num,
                value_denom: split.value_denom,
                quantity_num: split.quantity_num,
                quantity_denom: split.quantity_denom,
                lot_guid: split.lot_guid,
                account_name: split.account.name,
                account_fullname: accountPathMap.get(split.account_guid) || split.account.name,
                commodity_mnemonic: split.account.commodity?.mnemonic,
                value_decimal: toDecimal(split.value_num, split.value_denom),
                quantity_decimal: toDecimal(split.quantity_num, split.quantity_denom),
            })),
        }));

        return NextResponse.json(serializeBigInts(result));
    } catch (error) {
        console.error('Error fetching transactions:', error);
        return NextResponse.json({ error: 'Failed to fetch transactions' }, { status: 500 });
    }
}

/**
 * @openapi
 * /api/transactions:
 *   post:
 *     description: Create a new transaction with splits.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateTransactionRequest'
 *     responses:
 *       201:
 *         description: Transaction created successfully.
 *       400:
 *         description: Validation error.
 *       500:
 *         description: Server error.
 */
export async function POST(request: Request) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;

        const body: CreateTransactionRequest = await request.json();

        // Validate the transaction
        const validation = validateTransaction(body);
        if (!validation.valid) {
            console.error('[POST /api/transactions] Validation failed:', JSON.stringify(validation.errors), 'body:', JSON.stringify({ currency_guid: body.currency_guid, post_date: body.post_date, description: body.description, splits_count: body.splits?.length, splits_sample: body.splits?.slice(0, 2).map(s => ({ account_guid: s.account_guid, value_num: s.value_num, value_denom: s.value_denom })) }));
            // Send both shapes, matching PUT /api/transactions/[guid]: `error`
            // is the human-readable summary the client shows, `errors` keeps
            // the per-field detail for form-level highlighting.
            return NextResponse.json({
                error: summarizeValidationErrors(validation.errors),
                errors: validation.errors,
            }, { status: 400 });
        }

        // Period lock pre-check (fast-fail; the authoritative check runs
        // inside the DB transaction below with the cache bypassed)
        const lockError = await withPeriodLockCheck(roleResult.bookGuid, [body.post_date]);
        if (lockError) return lockError;

        // Verify all account GUIDs exist (deduplicate since multiple splits can reference the same account)
        const uniqueAccountGuids = [...new Set(body.splits.map(s => s.account_guid))];
        const accounts = await prisma.accounts.findMany({
            where: {
                guid: { in: uniqueAccountGuids },
            },
            select: { guid: true },
        });

        if (accounts.length !== uniqueAccountGuids.length) {
            const foundGuids = new Set(accounts.map(a => a.guid));
            const missingGuids = uniqueAccountGuids.filter(g => !foundGuids.has(g));
            return NextResponse.json({
                errors: [{ field: 'splits', message: `Invalid account GUIDs: ${missingGuids.join(', ')}` }]
            }, { status: 400 });
        }

        // Use client-provided GUID or generate one (validate format if provided)
        const txGuid = (body.guid && isValidGuid(body.guid)) ? body.guid : generateGuid();
        const now = new Date();

        // Track multi-currency status for audit log
        let isMultiCurrency = false;
        let totalSplitsCount = body.splits.length;

        // Create transaction with splits in a transaction
        const transaction = await prisma.$transaction(async (tx) => {
            // Period lock (authoritative, in-transaction, cache bypassed):
            // the new transaction's date must be after the lock date.
            await assertNotLocked(roleResult.bookGuid, [body.post_date], { bypassCache: true, client: tx });

            // Process multi-currency splits and add trading splits if needed
            const multiCurrencyResult = await processMultiCurrencySplits(
                body.splits,
                tx
            );
            isMultiCurrency = multiCurrencyResult.isMultiCurrency;
            const allSplits = multiCurrencyResult.allSplits;
            totalSplitsCount = allSplits.length;

            // Insert transaction
            await tx.transactions.create({
                data: {
                    guid: txGuid,
                    currency_guid: body.currency_guid,
                    num: body.num || '',
                    post_date: new Date(body.post_date),
                    enter_date: now,
                    description: body.description,
                },
            });

            // Insert all splits (including auto-generated trading splits)
            for (const split of allSplits) {
                const splitGuid = (split.guid && isValidGuid(split.guid)) ? split.guid : generateGuid();
                await tx.splits.create({
                    data: {
                        guid: splitGuid,
                        tx_guid: txGuid,
                        account_guid: split.account_guid,
                        memo: split.memo || '',
                        action: split.action || '',
                        reconcile_state: split.reconcile_state || 'n',
                        reconcile_date: null,
                        value_num: BigInt(split.value_num),
                        value_denom: BigInt(split.value_denom),
                        quantity_num: BigInt(split.quantity_num),
                        quantity_denom: BigInt(split.quantity_denom),
                        lot_guid: null,
                    },
                });
            }

            // Transaction-level notes (slots, name='notes')
            await writeTransactionNotes(tx, txGuid, body.notes);

            // Return the created transaction with splits
            return await tx.transactions.findUnique({
                where: { guid: txGuid },
                include: {
                    splits: {
                        include: {
                            account: {
                                include: {
                                    commodity: true,
                                },
                            },
                        },
                    },
                },
            });
        });

        if (!transaction) {
            throw new Error('Failed to create transaction');
        }

        const accountPathMap = await buildAccountPathMap(await getBookAccountGuids());

        // Log audit event with a full snapshot (undo-capable)
        await logAudit('CREATE', 'TRANSACTION', txGuid, null,
            await snapshotTransactionByGuid(txGuid) ?? {
                description: body.description,
                post_date: body.post_date,
                splits_count: totalSplitsCount,
            });

        // Invalidate caches from the transaction date forward
        try {
            const bookGuid = await getActiveBookGuid();
            const txDate = new Date(body.post_date);
            await cacheInvalidateFrom(bookGuid, txDate);
        } catch (err) {
            // Cache invalidation failure should not break the transaction operation
            console.warn('Cache invalidation failed:', err);
        }

        // Transform to response format
        const result = {
            guid: transaction.guid,
            currency_guid: transaction.currency_guid,
            num: transaction.num,
            post_date: transaction.post_date,
            enter_date: transaction.enter_date,
            description: transaction.description,
            splits: transaction.splits.map(split => ({
                guid: split.guid,
                tx_guid: split.tx_guid,
                account_guid: split.account_guid,
                memo: split.memo,
                action: split.action,
                reconcile_state: split.reconcile_state,
                reconcile_date: split.reconcile_date,
                value_num: split.value_num,
                value_denom: split.value_denom,
                quantity_num: split.quantity_num,
                quantity_denom: split.quantity_denom,
                lot_guid: split.lot_guid,
                account_name: split.account.name,
                account_fullname: accountPathMap.get(split.account_guid) || split.account.name,
                commodity_mnemonic: split.account.commodity?.mnemonic,
                value_decimal: toDecimal(split.value_num, split.value_denom),
                quantity_decimal: toDecimal(split.quantity_num, split.quantity_denom),
            })),
        };

        void publishDataChange(roleResult.bookGuid, 'transactions', { guid: txGuid, action: 'create' });

        return NextResponse.json(serializeBigInts(result), { status: 201 });
    } catch (error) {
        if (error instanceof PeriodLockedError) {
            return periodLockedResponse(error);
        }
        console.error('Error creating transaction:', error);
        return NextResponse.json({ error: 'Failed to create transaction' }, { status: 500 });
    }
}

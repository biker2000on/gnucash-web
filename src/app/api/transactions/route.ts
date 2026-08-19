import { NextResponse } from 'next/server';
import prisma, { toDecimal, generateGuid } from '@/lib/prisma';
import { serializeBigInts } from '@/lib/gnucash';
import { CreateTransactionRequest } from '@/lib/types';
import { validateTransaction, summarizeValidationErrors } from '@/lib/validation';
import { isValidGuid } from '@/lib/guid';
import { Prisma } from '@prisma/client';
import { logAudit, snapshotTransactionByGuid } from '@/lib/services/audit.service';
import { processMultiCurrencySplits } from '@/lib/trading-accounts';
import { getAccountGuidsForBook, getBookAccountGuids, getActiveBookGuid } from '@/lib/book-scope';
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

/** Thrown for a malformed filter value; caught in GET and answered as a 400. */
class BadFilterError extends Error {}
class OutOfBookGeneratedSplitError extends Error {}

const DECIMAL_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

/**
 * Every parser below shares one rule: a query param is ABSENT only when it is
 * missing entirely or exactly empty. Anything else the user actually typed is
 * either understood or rejected — never quietly treated as "no filter", because
 * that turns a typo into a request for the whole ledger.
 */
const isAbsent = (raw: string | null): raw is null | '' => raw === null || raw === '';

/**
 * Parse a non-negative integer query param, falling back to `fallback` when the
 * param is absent. LIMIT/OFFSET are real SQL clauses, and PostgreSQL rejects a
 * negative or NaN bind there, so a malformed value is a 400 rather than a
 * silent fallback to the default page.
 */
function nonNegativeIntParam(raw: string | null, fallback: number, name: string): number {
    if (isAbsent(raw)) return fallback;
    const trimmed = raw.trim();
    if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(Number(trimmed))) {
        throw new BadFilterError(`Invalid ${name}: "${raw}" is not a non-negative integer`);
    }
    return Number.parseInt(trimmed, 10);
}

/**
 * Parse an amount-bound query param into a decimal STRING for a `::numeric`
 * cast in SQL. Returned as text (not a JS number) so the bound reaches
 * PostgreSQL as an exact decimal rather than a binary float.
 *
 * A present-but-unparseable bound is REJECTED, never dropped — including one
 * that is only whitespace. Dropping it would turn a filter the user asked for
 * into no filter at all, answering with the whole ledger instead of the nothing
 * it used to return.
 */
function numericParam(raw: string | null, name: string): string | null {
    if (isAbsent(raw)) return null;
    const trimmed = raw.trim();
    if (!DECIMAL_RE.test(trimmed)) {
        throw new BadFilterError(`Invalid ${name}: "${raw}" is not a number`);
    }
    return trimmed;
}

/**
 * Parse a date query param. An unparseable date used to reach the driver as an
 * Invalid Date and fail the whole request with a 500; it is a 400 now.
 */
function dateParam(raw: string | null, name: string): Date | null {
    if (isAbsent(raw)) return null;
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) {
        throw new BadFilterError(`Invalid ${name}: "${raw}" is not a date`);
    }
    return date;
}

/**
 * Split a comma-separated filter param into tokens, rejecting empty ones.
 *
 * An empty token is malformed input, and the one thing it must not do is widen
 * the result: `accountTypes=,` used to match nothing (it searched for the
 * account type ""), so silently dropping the blank tokens would leave no
 * predicate at all and return every transaction in the book.
 */
function listParam(raw: string | null, name: string): string[] {
    if (isAbsent(raw)) return [];
    const tokens = raw.split(',').map(t => t.trim());
    if (tokens.some(t => t === '')) {
        throw new BadFilterError(`Invalid ${name}: "${raw}" contains an empty value`);
    }
    return tokens;
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
 *           Minimum transaction amount, where a transaction's amount is the
 *           largest absolute value among its splits (the transaction's amount
 *           for an ordinary two-split transaction).
 *       - in: query
 *         name: maxAmount
 *         schema:
 *           type: number
 *         description: >
 *           Maximum transaction amount, measured the same way as minAmount: a
 *           transaction is excluded when ANY of its splits exceeds this bound.
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
 *       400:
 *         description: >
 *           A query parameter is present but malformed — a non-numeric
 *           minAmount/maxAmount (whitespace included), an empty entry in
 *           accountTypes/reconcileStates, an unparseable startDate/endDate, or a
 *           limit/offset that is not a non-negative integer. Rejected rather
 *           than ignored, so a malformed value can never quietly widen the
 *           result set. A missing or exactly-empty parameter is still "no
 *           filter".
 */
export async function GET(request: Request) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const { searchParams } = new URL(request.url);
        const limit = nonNegativeIntParam(searchParams.get('limit'), 100, 'limit');
        const offset = nonNegativeIntParam(searchParams.get('offset'), 0, 'offset');
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
        const types = listParam(accountTypes, 'accountTypes').map(t => t.toUpperCase());
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
        const from = dateParam(startDate, 'startDate');
        const to = dateParam(endDate, 'endDate');
        if (from) {
            filters.push(Prisma.sql`t.post_date >= ${from}`);
        }
        if (to) {
            filters.push(Prisma.sql`t.post_date <= ${to}`);
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

        // Amount range.
        //
        // SEMANTICS: the transaction's magnitude is the LARGEST absolute value
        // among its splits, which for an ordinary two-split transaction is the
        // transaction's amount — what the "Amount Range" control in
        // src/components/filters/AmountFilter.tsx promises. Absolute, never
        // signed. The cost is that a per-line search ("which transaction has a
        // $12 fee line?") is no longer expressible here: a $3,000 paycheque is
        // excluded by maxAmount=100 even though it contains a $12 split.
        //
        // The bounds never divide. GnuCash stores split values as num/denom
        // fractions whose denominator is NOT always a power of ten, and
        // `numeric / numeric` in PostgreSQL rounds the quotient to a finite
        // scale, so a thirds-style fraction would compare wrong at the boundary.
        // Cross-multiplying is exact, since `numeric * numeric` is exact:
        //
        //     |value| >= bound   <=>   |value_num| >= bound * |value_denom|
        //     |value| <= bound   <=>   |value_num| <= bound * |value_denom|
        //
        // abs() on the denominator keeps a negative denominator from flipping
        // the inequality, and `value_denom <> 0` keeps an undefined split out of
        // the comparison instead of erroring or matching everything. Bounds are
        // bound as decimal text and cast to ::numeric, so no binary float
        // touches the comparison.
        //
        // Note the cast happens INSIDE abs(): `abs(x::numeric)`, never
        // `abs(x)::numeric`. bigint abs() overflows on INT64_MIN
        // (-9223372036854775808 has no positive bigint counterpart) and raises
        // "bigint out of range", which would blow up exactly the signed values
        // this predicate exists to handle. numeric is unbounded.
        //
        // "largest split >= min" is "some split reaches the floor"; "largest
        // split <= max" is "no split breaks the ceiling".
        const minVal = numericParam(minAmount, 'minAmount');
        const maxVal = numericParam(maxAmount, 'maxAmount');
        if (minVal !== null) {
            filters.push(Prisma.sql`EXISTS (
                SELECT 1 FROM splits s
                WHERE s.tx_guid = t.guid
                  AND s.value_denom <> 0
                  AND abs(s.value_num::numeric) >= ${minVal}::numeric * abs(s.value_denom::numeric)
            )`);
        }
        if (maxVal !== null) {
            filters.push(Prisma.sql`NOT EXISTS (
                SELECT 1 FROM splits s
                WHERE s.tx_guid = t.guid
                  AND s.value_denom <> 0
                  AND abs(s.value_num::numeric) > ${maxVal}::numeric * abs(s.value_denom::numeric)
            )`);
            if (minVal === null) {
                // A ceiling alone would otherwise admit a transaction with no
                // comparable split at all (every denominator zero), which has no
                // "largest split" to bound.
                filters.push(Prisma.sql`EXISTS (
                    SELECT 1 FROM splits s
                    WHERE s.tx_guid = t.guid AND s.value_denom <> 0
                )`);
            }
        }

        // Reconcile state: transaction matches when any split is in one of the
        // requested states.
        const states = listParam(reconcileStates, 'reconcileStates').map(s => s.toLowerCase());
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
        if (error instanceof BadFilterError) {
            return NextResponse.json({ error: error.message }, { status: 400 });
        }
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

        // A split may only post to an account in the session-derived book.
        // Do not turn a foreign guid into an existence oracle: a missing and a
        // foreign account both produce this same 404, before any write starts.
        const uniqueAccountGuids = [...new Set(body.splits.map(s => s.account_guid))];
        const bookAccountGuids = new Set(await getAccountGuidsForBook(roleResult.bookGuid));
        if (bookAccountGuids.size === 0 || uniqueAccountGuids.some(guid => !bookAccountGuids.has(guid))) {
            return NextResponse.json(
                { error: 'One or more accounts not found in this book' },
                { status: 404 },
            );
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
                tx,
                bookAccountGuids,
            );
            isMultiCurrency = multiCurrencyResult.isMultiCurrency;
            const allSplits = multiCurrencyResult.allSplits;
            // Helpers may append splits (Trading:* today). Keep the write
            // boundary authoritative: no generated account can escape the
            // caller's book even if a future helper gets its lookup wrong.
            if (allSplits.some(split => !bookAccountGuids.has(split.account_guid))) {
                throw new OutOfBookGeneratedSplitError();
            }
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
                multi_currency: isMultiCurrency,
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
        if (error instanceof OutOfBookGeneratedSplitError) {
            return NextResponse.json(
                { error: 'One or more accounts not found in this book' },
                { status: 404 },
            );
        }
        if (error instanceof PeriodLockedError) {
            return periodLockedResponse(error);
        }
        console.error('Error creating transaction:', error);
        return NextResponse.json({ error: 'Failed to create transaction' }, { status: 500 });
    }
}

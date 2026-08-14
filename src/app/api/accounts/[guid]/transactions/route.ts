import { NextResponse } from 'next/server';
import prisma, { toDecimal } from '@/lib/prisma';
import { serializeBigInts } from '@/lib/gnucash';
import { Prisma } from '@prisma/client';
import { isAccountInActiveBook } from '@/lib/book-scope';
import { requireRole } from '@/lib/auth';
import { buildAccountPathMap } from '@/lib/reports/utils';
import {
    traceCostBasis,
    isTransferIn,
    createCostBasisCache,
    preloadLotSplits,
    createCostBasisPool,
    addPurchaseToPool,
    addTracedTransferToPool,
    removeSharesFromPool,
    type CostBasisMethod,
} from '@/lib/cost-basis';
import { parseSearchQuery } from '@/lib/tags';
import { getTagsForTransactions } from '@/lib/services/tag.service';
import { readTransactionNotes } from '@/lib/transaction-notes';
import { cacheGet, cacheSet } from '@/lib/cache';

/**
 * Running per-transaction totals for the investment ledger.
 *
 * `costBasis` is the basis of the shares whose basis could be established, NOT
 * of `shareBalance`. `costBasisUncoveredShares` is how many of those shares
 * have no establishable basis (in-kind transfers whose origin is not in this
 * book). The two travel together deliberately: a running cost-basis column that
 * omitted the uncovered count would read as a complete basis and understate it.
 *
 * `costBasisUncoveredShares` is `null` when coverage is UNKNOWN, which is a
 * different statement from `0` ("every share has a basis"). Two situations
 * produce it, and both are cases where claiming full coverage would be a
 * fabrication:
 *
 *  - Carry-over tracing is switched off (`costBasisCarryOver=false`). That path
 *    deliberately does not detect transfer-ins, so an in-kind transfer lands at
 *    its $0 split value; the basis it reports may be missing real cost. It is
 *    not re-traced here — turning tracing off is the user's choice — but the
 *    result no longer claims completeness.
 *  - The share balance runs short/negative (an oversell). The pool clamps at
 *    zero shares and cannot describe a short position, so it can no longer say
 *    anything true about coverage. The share balance itself stays correct.
 *
 * `null` (never `undefined`) so the field survives the JSON round-trip through
 * Redis instead of being dropped from the cached object.
 */
type InvestmentRunningTotal = {
    shareBalance: number;
    costBasis: number;
    costBasisUncoveredShares: number | null;
};

type InvestmentTotals = Map<string, InvestmentRunningTotal>;

/**
 * Share-count tolerance for comparing the pool's share count against the raw
 * running balance. Matches the epsilon the lot code uses; the pool's pro-rata
 * arithmetic accumulates float drift that a tighter bound would misread as a
 * short position.
 */
const COVERAGE_EPS = 0.0001;

/**
 * Serialize the uncovered-share count for the response: a decimal string when
 * coverage is known, `null` when it is not. A transaction absent from the
 * totals map is also unknown — never defaulted to '0', which would assert full
 * coverage for a row nothing was computed for.
 */
function uncoveredShareText(total: InvestmentRunningTotal | undefined): string | null {
    const uncovered = total?.costBasisUncoveredShares;
    return uncovered == null ? null : uncovered.toString();
}

/** Thrown for a malformed filter value; caught in GET and answered as a 400. */
class BadFilterError extends Error {}

const DECIMAL_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

/** A query param is absent only when it is missing or exactly empty. */
const isAbsent = (raw: string | null): raw is null | '' => raw === null || raw === '';

function nonNegativeIntParam(raw: string | null, fallback: number, name: string): number {
    if (isAbsent(raw)) return fallback;
    const trimmed = raw.trim();
    if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(Number(trimmed))) {
        throw new BadFilterError(`Invalid ${name}: "${raw}" is not a non-negative integer`);
    }
    return Number.parseInt(trimmed, 10);
}

/** Return exact decimal text for PostgreSQL's numeric comparison. */
function numericParam(raw: string | null, name: string): string | null {
    if (isAbsent(raw)) return null;
    const trimmed = raw.trim();
    if (!DECIMAL_RE.test(trimmed)) {
        throw new BadFilterError(`Invalid ${name}: "${raw}" is not a number`);
    }
    return trimmed;
}

function dateParam(raw: string | null, name: string): Date | null {
    if (isAbsent(raw)) return null;
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) {
        throw new BadFilterError(`Invalid ${name}: "${raw}" is not a date`);
    }
    return date;
}

function listParam(raw: string | null, name: string): string[] {
    if (isAbsent(raw)) return [];
    const tokens = raw.split(',').map(token => token.trim());
    if (tokens.some(token => token === '')) {
        throw new BadFilterError(`Invalid ${name}: "${raw}" contains an empty value`);
    }
    return tokens;
}

/**
 * In-flight recomputes of the investment running totals, keyed by the same
 * cache key used for Redis.
 *
 * The running totals are inherently O(full history): page 1 of the ledger is
 * the NEWEST transactions, so its running share balance / cost basis depends on
 * every earlier split. The Redis entry written on the first miss is what keeps
 * that work to once per (account, method, carry-over, date range) — but
 * `getRedis()` is allowed to return null (no REDIS_URL, or a 30s cooldown after
 * a connection blip), and in that degraded state every concurrent ledger
 * request would otherwise start its own full-history walk, including the
 * per-transfer `traceCostBasis` lookups. Coalescing them onto a single promise
 * keeps the recompute to one at a time per key without introducing a
 * process-local cache that no mutation could invalidate (a stale share balance
 * or cost basis is far worse than a slow one).
 *
 * Entries live only for the duration of the computation, so joiners always see
 * data from an in-progress read of the current DB state.
 */
const inFlightInvestmentTotals = new Map<string, Promise<InvestmentTotals>>();

/**
 * Resolve the running totals for `cacheKey`: Redis first, then an in-flight
 * recompute if one is already running for the same key, then a fresh
 * computation (whose result is written back to Redis before it resolves, so the
 * next page — whatever its offset — hits the cache instead of recomputing).
 */
async function loadInvestmentRunningTotals(
    cacheKey: string,
    compute: () => Promise<InvestmentTotals>,
): Promise<InvestmentTotals> {
    const cached = await cacheGet<Array<[string, InvestmentRunningTotal]>>(cacheKey);
    if (cached) return new Map(cached);

    const inFlight = inFlightInvestmentTotals.get(cacheKey);
    if (inFlight) return inFlight;

    const pending = (async () => {
        const totals = await compute();
        await cacheSet(cacheKey, [...totals.entries()], 3600);
        return totals;
    })();
    inFlightInvestmentTotals.set(cacheKey, pending);
    try {
        return await pending;
    } finally {
        if (inFlightInvestmentTotals.get(cacheKey) === pending) {
            inFlightInvestmentTotals.delete(cacheKey);
        }
    }
}

/**
 * @openapi
 * /api/accounts/{guid}/transactions:
 *   get:
 *     description: Returns a paginated account ledger.
 *     parameters:
 *       - in: query
 *         name: minAmount
 *         schema:
 *           type: number
 *         description: >
 *           Minimum magnitude of an individual quantity split in this account
 *           (or included subaccount). This deliberately differs from the global
 *           transaction journal, which has no current account and therefore
 *           uses the transaction's largest value split.
 *       - in: query
 *         name: maxAmount
 *         schema:
 *           type: number
 *         description: Maximum magnitude of an individual quantity split in this account (or included subaccount).
 */

export async function GET(
    request: Request,
    { params }: { params: Promise<{ guid: string }> }
) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const { searchParams } = new URL(request.url);
        const limit = nonNegativeIntParam(searchParams.get('limit'), 100, 'limit');
        const offset = nonNegativeIntParam(searchParams.get('offset'), 0, 'offset');
        const startDate = dateParam(searchParams.get('startDate'), 'startDate');
        const endDate = dateParam(searchParams.get('endDate'), 'endDate');
        const unreviewedOnly = searchParams.get('unreviewedOnly') === 'true';
        // '#tag' tokens in the search act as tag filters (AND semantics)
        const { text: search, tags: tagFilters } = parseSearchQuery(searchParams.get('search')?.trim() || '');
        const minAmount = numericParam(searchParams.get('minAmount'), 'minAmount');
        const maxAmount = numericParam(searchParams.get('maxAmount'), 'maxAmount');
        const reconcileStates = listParam(searchParams.get('reconcileStates'), 'reconcileStates')
            .map(state => state.toLowerCase());
        const includeSubaccounts = searchParams.get('includeSubaccounts') === 'true';
        const costBasisCarryOver = searchParams.get('costBasisCarryOver') !== 'false'; // default true
        const costBasisMethod = (searchParams.get('costBasisMethod') || 'fifo') as CostBasisMethod;
        const { guid: accountGuid } = await params;

        // Verify account belongs to active book
        if (!await isAccountInActiveBook(accountGuid)) {
            return NextResponse.json({ error: 'Account not found' }, { status: 404 });
        }

        // Fetch account early so we can detect investment accounts
        const account = await prisma.accounts.findUnique({
            where: { guid: accountGuid },
            include: { commodity: true },
        });
        const accountMnemonic = account?.commodity?.mnemonic || '';
        const isInvestmentAccount = !includeSubaccounts
            && account?.commodity?.namespace !== undefined
            && account.commodity.namespace !== 'CURRENCY';

        // Build the set of account GUIDs to query
        let targetAccountGuids = [accountGuid];
        if (includeSubaccounts) {
            const descendants = await prisma.$queryRaw<{ guid: string }[]>`
                WITH RECURSIVE descendants AS (
                    SELECT guid FROM accounts WHERE guid = ${accountGuid}
                    UNION ALL
                    SELECT a.guid FROM accounts a
                    JOIN descendants d ON a.parent_guid = d.guid
                )
                SELECT guid FROM descendants
            `;
            targetAccountGuids = descendants.map(d => d.guid);
        }

        // Pre-fetch unreviewed GUIDs if filter is active
        let unreviewedGuids: string[] | undefined;
        if (unreviewedOnly) {
            const unreviewedMeta = await prisma.$queryRaw<{ transaction_guid: string }[]>`
                SELECT m.transaction_guid
                FROM gnucash_web_transaction_meta m
                JOIN splits s ON s.tx_guid = m.transaction_guid
                WHERE s.account_guid = ANY(${targetAccountGuids}::text[]) AND m.reviewed = false
            `;
            unreviewedGuids = unreviewedMeta.map(m => m.transaction_guid);
            if (unreviewedGuids.length === 0) {
                if (isInvestmentAccount) {
                    return NextResponse.json({ transactions: [], is_investment: true });
                }
                return NextResponse.json([]);
            }
        }

        // Compute per-row investment running totals (share balance & cost basis)
        let investmentRunningTotals: InvestmentTotals | null = null;

        if (isInvestmentAccount && !unreviewedOnly && !includeSubaccounts) {
            const cacheStart = startDate?.toISOString().slice(0, 10) || '0001-01-01';
            const cacheEnd = endDate?.toISOString().slice(0, 10) || '9999-12-31';
            // `investment-ledger-v2` retires entries written before
            // costBasisUncoveredShares existed. Those cached payloads report no
            // uncovered shares at all, which a reader takes as "fully covered"
            // — the exact false claim this field was added to stop, served for
            // up to a full TTL after deploy. Bump this metric name whenever the
            // shape of InvestmentRunningTotal changes.
            const totalsCacheKey =
                `cache:${roleResult.bookGuid}:investment-ledger-v2:${accountGuid}:` +
                `${costBasisMethod}:${costBasisCarryOver ? 'carry' : 'local'}:` +
                `${cacheStart}-${cacheEnd}`;
            const accountCommodityGuid = account?.commodity_guid || '';

            investmentRunningTotals = await loadInvestmentRunningTotals(totalsCacheKey, async () => {
            if (costBasisCarryOver && accountCommodityGuid) {
                // Enhanced path: flat batched queries (account splits, sibling
                // splits by tx, sibling accounts) instead of a 3-level nested
                // include that dragged every column of every related row.
                const dateWhere: Prisma.transactionsWhereInput = {};
                if (startDate) dateWhere.post_date = { ...dateWhere.post_date as object, gte: startDate };
                if (endDate) dateWhere.post_date = { ...dateWhere.post_date as object, lte: endDate };

                const baseSplits = await prisma.splits.findMany({
                    where: {
                        account_guid: accountGuid,
                        transaction: Object.keys(dateWhere).length > 0 ? dateWhere : undefined,
                    },
                    select: {
                        guid: true,
                        tx_guid: true,
                        account_guid: true,
                        lot_guid: true,
                        quantity_num: true,
                        quantity_denom: true,
                        value_num: true,
                        value_denom: true,
                        transaction: { select: { post_date: true, enter_date: true } },
                    },
                });

                // One batch: all sibling splits of the involved transactions
                const investmentTxGuids = [...new Set(baseSplits.map(s => s.tx_guid))];
                const siblingSplits = investmentTxGuids.length > 0
                    ? await prisma.splits.findMany({
                        where: { tx_guid: { in: investmentTxGuids } },
                        select: {
                            guid: true,
                            tx_guid: true,
                            account_guid: true,
                            quantity_num: true,
                            quantity_denom: true,
                            value_num: true,
                            value_denom: true,
                        },
                    })
                    : [];
                // One batch: accounts of those sibling splits (guid +
                // commodity_guid — same fields the old include selected)
                const siblingAccountGuids = [...new Set(siblingSplits.map(s => s.account_guid))];
                const siblingAccounts = siblingAccountGuids.length > 0
                    ? await prisma.accounts.findMany({
                        where: { guid: { in: siblingAccountGuids } },
                        select: { guid: true, commodity_guid: true },
                    })
                    : [];
                const siblingAccountByGuid = new Map(siblingAccounts.map(a => [a.guid, a]));

                type SiblingSplit = (typeof siblingSplits)[number] & {
                    account: { guid: string; commodity_guid: string | null } | null;
                };
                const siblingsByTx = new Map<string, SiblingSplit[]>();
                for (const s of siblingSplits) {
                    const arr = siblingsByTx.get(s.tx_guid) ?? [];
                    arr.push({ ...s, account: siblingAccountByGuid.get(s.account_guid) ?? null });
                    siblingsByTx.set(s.tx_guid, arr);
                }

                const allSplitsForAccount = baseSplits.map(s => ({
                    ...s,
                    transaction: {
                        post_date: s.transaction?.post_date ?? null,
                        enter_date: s.transaction?.enter_date ?? null,
                        splits: siblingsByTx.get(s.tx_guid) ?? [],
                    },
                }));

                // Sort in JS for reliability
                allSplitsForAccount.sort((a, b) => {
                    const dateA = a.transaction?.post_date?.getTime() || 0;
                    const dateB = b.transaction?.post_date?.getTime() || 0;
                    if (dateA !== dateB) return dateA - dateB;
                    const enterA = a.transaction?.enter_date?.getTime() || 0;
                    const enterB = b.transaction?.enter_date?.getTime() || 0;
                    return enterA - enterB;
                });

                let runShares = 0;
                // A CostBasisPool, not a loose running total: traceCostBasis
                // returns basis for only the shares whose basis it could
                // establish, so adding that basis while counting EVERY share
                // (and then dividing on each sale) understates the basis of the
                // whole ledger column. The pool keeps the two counts in step.
                const pool = createCostBasisPool();
                const totals: InvestmentTotals = new Map();
                const costBasisCache = createCostBasisCache();

                // Preload lot splits for every transfer-in that carries a lot,
                // in ONE query, so traceCostBasis skips its per-lot lookup
                const transferLotGuids = allSplitsForAccount
                    .filter(split =>
                        Number(split.quantity_num) / Number(split.quantity_denom) > 0 &&
                        split.lot_guid &&
                        isTransferIn(split, split.transaction?.splits || [], accountCommodityGuid))
                    .map(split => split.lot_guid!);
                await preloadLotSplits(transferLotGuids, costBasisCache);

                for (const split of allSplitsForAccount) {
                    const shares = Number(split.quantity_num) / Number(split.quantity_denom);
                    const value = Math.abs(Number(split.value_num) / Number(split.value_denom));

                    if (shares > 0) {
                        runShares += shares;

                        // Check if this is a transfer-in
                        const txSplits = split.transaction?.splits || [];
                        if (isTransferIn(split, txSplits, accountCommodityGuid)) {
                            const traced = await traceCostBasis(split.guid, costBasisMethod, accountCommodityGuid, shares, costBasisCache);
                            // Carries the trace's covered/uncovered split, so a
                            // partly-traceable transfer stays partly covered
                            // instead of being credited as fully basised.
                            addTracedTransferToPool(pool, traced);
                        } else {
                            addPurchaseToPool(pool, shares, value);
                        }
                    } else if (shares < 0) {
                        // Pro rata across covered and uncovered shares, giving
                        // up basis at the COVERED average — the old
                        // runCostBasis / runShares divided a partial basis by
                        // the full share count on every sale.
                        removeSharesFromPool(pool, Math.abs(shares));
                        runShares += shares;
                    }
                    // The pool clamps removals at the shares it holds, so an
                    // oversell (short position) leaves it empty while runShares
                    // goes negative. runShares is the correct balance and stays
                    // as-is; coverage becomes unknown rather than a "0
                    // uncovered" claim that would hand consumers a negative
                    // `shareBalance - uncovered` denominator.
                    const poolShares = pool.coveredShares + pool.uncoveredShares;
                    const coverageIsKnowable = Math.abs(runShares - poolShares) < COVERAGE_EPS;
                    totals.set(split.tx_guid, {
                        shareBalance: runShares,
                        costBasis: pool.basisOfCoveredShares,
                        costBasisUncoveredShares: coverageIsKnowable ? pool.uncoveredShares : null,
                    });
                }
                return totals;
            } else {
                // Original path: simple raw SQL without transfer tracing
                const allSplitsWithTx = await prisma.$queryRaw<{
                    tx_guid: string;
                    quantity_num: bigint;
                    quantity_denom: bigint;
                    value_num: bigint;
                    value_denom: bigint;
                }[]>`
                    SELECT s.tx_guid, s.quantity_num, s.quantity_denom, s.value_num, s.value_denom
                    FROM splits s
                    JOIN transactions t ON t.guid = s.tx_guid
                    WHERE s.account_guid = ${accountGuid}
                    ${endDate ? Prisma.sql`AND t.post_date <= ${endDate}` : Prisma.empty}
                    ${startDate ? Prisma.sql`AND t.post_date >= ${startDate}` : Prisma.empty}
                    ORDER BY t.post_date ASC, t.enter_date ASC
                `;

                let runShares = 0;
                let runCostBasis = 0;
                const totals: InvestmentTotals = new Map();

                for (const split of allSplitsWithTx) {
                    const shares = Number(split.quantity_num) / Number(split.quantity_denom);
                    const value = Math.abs(Number(split.value_num) / Number(split.value_denom));

                    if (shares > 0) {
                        runShares += shares;
                        runCostBasis += value;
                    } else if (shares < 0) {
                        const soldShares = Math.abs(shares);
                        if (runShares > 0) {
                            const avgCost = runCostBasis / runShares;
                            runCostBasis -= avgCost * soldShares;
                        }
                        runShares += shares;
                    }
                    totals.set(split.tx_guid, {
                        shareBalance: runShares,
                        costBasis: runCostBasis,
                        // Carry-over tracing is off on this path, so it does no
                        // transfer-in detection: an in-kind transfer-in enters
                        // at its $0 split value and this basis may be missing
                        // real cost. Re-adding tracing here would reimplement
                        // the very feature the caller switched off, so instead
                        // the result declines to claim coverage at all.
                        costBasisUncoveredShares: null,
                    });
                }
                return totals;
            }
            });
        }

        // Every predicate is in this GUID query, before LIMIT/OFFSET. This keeps
        // paging over matches (rather than a raw page subsequently shortened in
        // JavaScript), while the hydration below still returns all splits.
        const filters: Prisma.Sql[] = [Prisma.sql`EXISTS (
            SELECT 1 FROM splits s
            WHERE s.tx_guid = t.guid
              AND s.account_guid = ANY(${targetAccountGuids}::text[])
        )`];
        if (startDate) filters.push(Prisma.sql`t.post_date >= ${startDate}`);
        if (endDate) filters.push(Prisma.sql`t.post_date <= ${endDate}`);
        if (unreviewedGuids) filters.push(Prisma.sql`t.guid = ANY(${unreviewedGuids}::text[])`);
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

        // This is a per-account ledger, so amount and reconciliation filters
        // apply only to the splits whose amount/reconcile icon the ledger shows.
        // The global transaction journal intentionally differs: it has no
        // current account and therefore filters its largest value split.
        //
        // Amount uses quantity (the ledger's Amount column), not value. Compare
        // each qualifying split exactly by cross-multiplication rather than
        // division, because numeric division rounds repeating fractions. A
        // transaction posting twice to this account is accepted when either
        // individual split meets the bound; this intentionally differs from the
        // displayed sum, whose exact comparison would require division.
        if (minAmount !== null) {
            filters.push(Prisma.sql`EXISTS (
                SELECT 1 FROM splits s
                WHERE s.tx_guid = t.guid
                  AND s.account_guid = ANY(${targetAccountGuids}::text[])
                  AND s.quantity_denom <> 0
                  AND abs(s.quantity_num::numeric) >= ${minAmount}::numeric * abs(s.quantity_denom::numeric)
            )`);
        }
        if (maxAmount !== null) {
            filters.push(Prisma.sql`NOT EXISTS (
                SELECT 1 FROM splits s
                WHERE s.tx_guid = t.guid
                  AND s.account_guid = ANY(${targetAccountGuids}::text[])
                  AND s.quantity_denom <> 0
                  AND abs(s.quantity_num::numeric) > ${maxAmount}::numeric * abs(s.quantity_denom::numeric)
            )`);
            if (minAmount === null) {
                filters.push(Prisma.sql`EXISTS (
                    SELECT 1 FROM splits s
                    WHERE s.tx_guid = t.guid
                      AND s.account_guid = ANY(${targetAccountGuids}::text[])
                      AND s.quantity_denom <> 0
                )`);
            }
        }
        if (reconcileStates.length > 0) {
            filters.push(Prisma.sql`EXISTS (
                SELECT 1 FROM splits s
                WHERE s.tx_guid = t.guid
                  AND s.account_guid = ANY(${targetAccountGuids}::text[])
                  AND lower(s.reconcile_state) = ANY(${reconcileStates}::text[])
            )`);
        }

        // `guid` makes offset paging a total order when dates tie.
        const pageRows = await prisma.$queryRaw<{ guid: string }[]>`
            SELECT t.guid
            FROM transactions t
            WHERE ${Prisma.join(filters, ' AND ')}
            ORDER BY t.post_date DESC, t.enter_date DESC, t.guid ASC
            LIMIT ${limit} OFFSET ${offset}
        `;
        const pageGuids = pageRows.map(row => row.guid);
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
                                account_type: true,
                                commodity: { select: { mnemonic: true } },
                            },
                        },
                    },
                },
                },
            })
            : [];
        const transactionsByGuid = new Map(pageTransactions.map(tx => [tx.guid, tx]));
        const transactions = pageGuids
            .map(guid => transactionsByGuid.get(guid))
            .filter((tx): tx is (typeof pageTransactions)[number] => tx !== undefined);

        if (transactions.length === 0) {
            if (isInvestmentAccount) {
                return NextResponse.json({ transactions: [], is_investment: true });
            }
            return NextResponse.json([]);
        }

        // 3b. Fetch transaction meta (reviewed status, source) for these transactions
        const txGuids = transactions.map(tx => tx.guid);
        const transactionMeta = await prisma.$queryRaw<{
            transaction_guid: string;
            source: string;
            reviewed: boolean;
            match_type: string | null;
            original_description: string | null;
        }[]>`
            SELECT transaction_guid, source, reviewed, match_type, original_description
            FROM gnucash_web_transaction_meta
            WHERE transaction_guid = ANY(${txGuids}::text[])
        `;
        const metaMap = new Map(transactionMeta.map(m => [m.transaction_guid, m]));

        // 3c. Fetch receipt counts for these transactions (scoped by book)
        const activeBookGuid = roleResult.bookGuid;
        const receiptCounts = await prisma.$queryRaw<{ transaction_guid: string; receipt_count: bigint }[]>`
            SELECT gr.transaction_guid, COUNT(*) as receipt_count
            FROM gnucash_web_receipts gr
            WHERE gr.transaction_guid = ANY(${txGuids}::text[])
              AND gr.book_guid = ${activeBookGuid}
            GROUP BY gr.transaction_guid
        `;
        const receiptCountMap = new Map(receiptCounts.map(r => [r.transaction_guid, Number(r.receipt_count)]));

        // 3d. Fetch direct tags for these transactions
        const tagMap = await getTagsForTransactions(txGuids);

        // 3e. Fetch transaction-level notes (slots, name='notes') in one batch
        const notesMap = await readTransactionNotes(prisma, txGuids);

        // 4. Build account path map for only the accounts referenced by this
        // page's splits (buildAccountPathMap resolves missing ancestors, so
        // full paths are preserved without loading every account in the DB)
        const referencedAccountGuids = [...new Set(
            transactions.flatMap(tx => tx.splits.map(s => s.account_guid)),
        )];
        const accountPathMap = await buildAccountPathMap(referencedAccountGuids);

        // A filtered page must not pretend its visible rows form a running
        // balance. Instead each row receives the actual account balance as of
        // that transaction, calculated across the unfiltered account history.
        const runningBalanceRows = !unreviewedOnly && pageGuids.length > 0
            ? await prisma.$queryRaw<{ guid: string; running_balance: number }[]>`
                WITH account_transaction_deltas AS (
                    SELECT t.guid, t.post_date, t.enter_date,
                        SUM(s.quantity_num::float8 / s.quantity_denom::float8) AS delta
                    FROM transactions t
                    JOIN splits s ON s.tx_guid = t.guid
                    WHERE s.account_guid = ANY(${targetAccountGuids}::text[])
                      ${endDate ? Prisma.sql`AND t.post_date <= ${endDate}` : Prisma.empty}
                    GROUP BY t.guid, t.post_date, t.enter_date
                ), balances AS (
                    SELECT guid,
                        SUM(delta) OVER (
                            ORDER BY post_date ASC, enter_date ASC, guid DESC
                            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                        ) AS running_balance
                    FROM account_transaction_deltas
                )
                SELECT guid, running_balance::float8 AS running_balance
                FROM balances
                WHERE guid = ANY(${pageGuids}::text[])
            `
            : [];
        const runningBalanceByGuid = new Map(
            runningBalanceRows.map(row => [row.guid, Number(row.running_balance)]),
        );

        // 5. Build the response with as-of account balances
        const result = transactions.map(tx => {
            // Enrich splits with computed decimals
            const enrichedSplits = tx.splits.map(split => ({
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
                account_type: split.account.account_type,
                commodity_mnemonic: split.account.commodity?.mnemonic,
                value_decimal: toDecimal(split.value_num, split.value_denom),
                quantity_decimal: toDecimal(split.quantity_num, split.quantity_denom),
            }));

            // Find ALL splits for the current account — a transaction can post multiple times to
            // the same account (e.g., mortgage principal + additional principal both on PNC Mortgage).
            // Sum them for the running-balance delta; use the first for per-row UI fields like
            // account_split_guid / reconcile_state.
            const accountSplits = enrichedSplits.filter(s => targetAccountGuids.includes(s.account_guid));
            const accountSplit = accountSplits[0];
            const splitValue = accountSplits.reduce(
                (sum, s) => sum + Number(s.quantity_num) / Number(s.quantity_denom),
                0,
            );

            const meta = metaMap.get(tx.guid);
            const row = {
                guid: tx.guid,
                currency_guid: tx.currency_guid,
                num: tx.num,
                post_date: tx.post_date,
                enter_date: tx.enter_date,
                description: tx.description,
                notes: notesMap.get(tx.guid) ?? null,
                receipt_count: receiptCountMap.get(tx.guid) ?? 0,
                tags: tagMap.get(tx.guid) ?? [],
                splits: enrichedSplits,
                running_balance: unreviewedOnly ? '' : (runningBalanceByGuid.get(tx.guid) ?? 0).toFixed(2),
                account_split_value: splitValue.toFixed(2),
                commodity_mnemonic: accountMnemonic,
                account_split_guid: accountSplit?.guid || '',
                account_split_reconcile_state: accountSplit?.reconcile_state || 'n',
                account_splits: accountSplits.map((split) => ({
                    guid: split.guid,
                    reconcile_state: split.reconcile_state || 'n',
                    amount: (
                        Number(split.quantity_num) / Number(split.quantity_denom)
                    ).toString(),
                })),
                // Transaction meta: reviewed status, source, preserved payee
                reviewed: meta?.reviewed ?? true, // default to reviewed if no meta row
                source: meta?.source ?? 'manual',
                match_type: meta?.match_type ?? null,
                original_description: meta?.original_description ?? null,
                // Investment running totals (only present for investment accounts)
                ...(investmentRunningTotals ? {
                    share_balance: investmentRunningTotals.get(tx.guid)?.shareBalance.toString() ?? '0',
                    // Basis of the shares that HAVE one; the companion field
                    // says how many shares it does not cover — or `null` when
                    // coverage is unknown, which is NOT the same as zero. A
                    // client must not derive a per-share basis from a null.
                    cost_basis: investmentRunningTotals.get(tx.guid)?.costBasis.toString() ?? '0',
                    cost_basis_uncovered_shares: uncoveredShareText(investmentRunningTotals.get(tx.guid)),
                } : {}),
            };

            return row;
        });

        if (isInvestmentAccount) {
            return NextResponse.json(serializeBigInts({
                transactions: result,
                is_investment: true,
            }));
        } else {
            return NextResponse.json(serializeBigInts(result));
        }
    } catch (error) {
        if (error instanceof BadFilterError) {
            return NextResponse.json({ error: error.message }, { status: 400 });
        }
        console.error('Error fetching account transactions:', error);
        return NextResponse.json({ error: 'Failed' }, { status: 500 });
    }
}

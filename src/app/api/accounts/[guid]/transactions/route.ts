import { NextResponse } from 'next/server';
import prisma, { toDecimal } from '@/lib/prisma';
import { serializeBigInts } from '@/lib/gnucash';
import { Prisma } from '@prisma/client';
import { isAccountInActiveBook } from '@/lib/book-scope';
import { requireRole } from '@/lib/auth';
import { buildAccountPathMap } from '@/lib/reports/utils';
import { traceCostBasis, isTransferIn, createCostBasisCache, type CostBasisMethod } from '@/lib/cost-basis';

export async function GET(
    request: Request,
    { params }: { params: Promise<{ guid: string }> }
) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const { searchParams } = new URL(request.url);
        const limit = parseInt(searchParams.get('limit') || '100');
        const offset = parseInt(searchParams.get('offset') || '0');
        const startDate = searchParams.get('startDate');
        const endDate = searchParams.get('endDate');
        const unreviewedOnly = searchParams.get('unreviewedOnly') === 'true';
        const search = searchParams.get('search')?.trim() || '';
        const minAmount = searchParams.get('minAmount') ? parseFloat(searchParams.get('minAmount')!) : null;
        const maxAmount = searchParams.get('maxAmount') ? parseFloat(searchParams.get('maxAmount')!) : null;
        const reconcileStates = searchParams.get('reconcileStates')?.split(',').filter(Boolean) || [];
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

        // Build date filter for transactions
        const dateFilter: Prisma.transactionsWhereInput = {};
        if (startDate) {
            dateFilter.post_date = {
                ...(dateFilter.post_date as Prisma.DateTimeNullableFilter || {}),
                gte: new Date(startDate),
            };
        }
        if (endDate) {
            dateFilter.post_date = {
                ...(dateFilter.post_date as Prisma.DateTimeNullableFilter || {}),
                lte: new Date(endDate),
            };
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

        // 1. Get the total balance of the account (considering date filter for filtered balance)
        // For running balance, we need balance as of the end of the date range (or total if no filter)
        let startingBalance = 0;

        if (!unreviewedOnly) {
            const balanceWhere: Prisma.splitsWhereInput = {
                account_guid: { in: targetAccountGuids },
                ...(endDate ? {
                    transaction: {
                        post_date: {
                            lte: new Date(endDate),
                        },
                    },
                } : {}),
            };

            const balanceSplits = await prisma.splits.findMany({
                where: balanceWhere,
            });

            const totalBalance = balanceSplits.reduce((sum, split) => {
                return sum + Number(split.quantity_num) / Number(split.quantity_denom);
            }, 0);

            // 2. Get the sum of splits for transactions that are NEWER than the current batch (to calculate starting balance for the page)
            startingBalance = totalBalance;
            if (offset > 0) {
                // Get transaction GUIDs that are newer (before this page)
                const newerTransactions = await prisma.transactions.findMany({
                    where: {
                        ...dateFilter,
                        splits: {
                            some: {
                                account_guid: { in: targetAccountGuids },
                            },
                        },
                    },
                    orderBy: [
                        { post_date: 'desc' },
                        { enter_date: 'desc' },
                    ],
                    take: offset,
                    select: {
                        guid: true,
                    },
                });

                const newerTxGuids = newerTransactions.map(tx => tx.guid);

                if (newerTxGuids.length > 0) {
                    const newerSplits = await prisma.splits.findMany({
                        where: {
                            account_guid: { in: targetAccountGuids },
                            tx_guid: {
                                in: newerTxGuids,
                            },
                        },
                    });

                    const newerSum = newerSplits.reduce((sum, split) => {
                        return sum + Number(split.quantity_num) / Number(split.quantity_denom);
                    }, 0);

                    startingBalance = totalBalance - newerSum;
                }
            }
        }

        // Compute per-row investment running totals (share balance & cost basis)
        let investmentRunningTotals: Map<string, { shareBalance: number; costBasis: number }> | null = null;

        if (isInvestmentAccount && !unreviewedOnly && !includeSubaccounts) {
            const accountCommodityGuid = account?.commodity_guid || '';

            if (costBasisCarryOver && accountCommodityGuid) {
                // Enhanced path: use Prisma queries with account info for transfer detection
                const dateWhere: Prisma.transactionsWhereInput = {};
                if (startDate) dateWhere.post_date = { ...dateWhere.post_date as object, gte: new Date(startDate) };
                if (endDate) dateWhere.post_date = { ...dateWhere.post_date as object, lte: new Date(endDate) };

                const allSplitsForAccount = await prisma.splits.findMany({
                    where: {
                        account_guid: accountGuid,
                        transaction: Object.keys(dateWhere).length > 0 ? dateWhere : undefined,
                    },
                    include: {
                        transaction: {
                            include: {
                                splits: {
                                    include: {
                                        account: { select: { guid: true, commodity_guid: true } },
                                    },
                                },
                            },
                        },
                    },
                });

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
                let runCostBasis = 0;
                investmentRunningTotals = new Map();
                const costBasisCache = createCostBasisCache();

                for (const split of allSplitsForAccount) {
                    const shares = Number(split.quantity_num) / Number(split.quantity_denom);
                    const value = Math.abs(Number(split.value_num) / Number(split.value_denom));

                    if (shares > 0) {
                        runShares += shares;

                        // Check if this is a transfer-in
                        const txSplits = split.transaction?.splits || [];
                        if (isTransferIn(split, txSplits, accountCommodityGuid)) {
                            const traced = await traceCostBasis(split.guid, costBasisMethod, accountCommodityGuid, shares, costBasisCache);
                            runCostBasis += traced.totalCost;
                        } else {
                            runCostBasis += value;
                        }
                    } else if (shares < 0) {
                        const soldShares = Math.abs(shares);
                        if (runShares > 0) {
                            const avgCost = runCostBasis / runShares;
                            runCostBasis -= avgCost * soldShares;
                        }
                        runShares += shares;
                    }
                    investmentRunningTotals.set(split.tx_guid, {
                        shareBalance: runShares,
                        costBasis: runCostBasis,
                    });
                }
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
                    ${endDate ? Prisma.sql`AND t.post_date <= ${new Date(endDate)}` : Prisma.empty}
                    ${startDate ? Prisma.sql`AND t.post_date >= ${new Date(startDate)}` : Prisma.empty}
                    ORDER BY t.post_date ASC, t.enter_date ASC
                `;

                let runShares = 0;
                let runCostBasis = 0;
                investmentRunningTotals = new Map();

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
                    investmentRunningTotals.set(split.tx_guid, {
                        shareBalance: runShares,
                        costBasis: runCostBasis,
                    });
                }
            }
        }

        // Build search filter
        const searchFilter: Prisma.transactionsWhereInput = search ? {
            OR: [
                { description: { contains: search, mode: 'insensitive' } },
                { num: { contains: search, mode: 'insensitive' } },
                { splits: { some: { account: { name: { contains: search, mode: 'insensitive' } } } } },
            ],
        } : {};

        // 3. Fetch transactions for this account with date filtering
        const transactions = await prisma.transactions.findMany({
            where: {
                ...dateFilter,
                ...searchFilter,
                ...(unreviewedGuids ? { guid: { in: unreviewedGuids } } : {}),
                splits: {
                    some: {
                        account_guid: { in: targetAccountGuids },
                    },
                },
            },
            orderBy: [
                { post_date: 'desc' },
                { enter_date: 'desc' },
            ],
            take: limit,
            skip: offset,
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
        }[]>`
            SELECT transaction_guid, source, reviewed
            FROM gnucash_web_transaction_meta
            WHERE transaction_guid = ANY(${txGuids}::text[])
        `;
        const metaMap = new Map(transactionMeta.map(m => [m.transaction_guid, m]));

        // 3c. Fetch receipt counts for these transactions
        const receiptCounts = await prisma.$queryRaw<{ transaction_guid: string; receipt_count: bigint }[]>`
            SELECT gr.transaction_guid, COUNT(*) as receipt_count
            FROM gnucash_web_receipts gr
            WHERE gr.transaction_guid = ANY(${txGuids}::text[])
            GROUP BY gr.transaction_guid
        `;
        const receiptCountMap = new Map(receiptCounts.map(r => [r.transaction_guid, Number(r.receipt_count)]));

        // 4. Build account path map
        const accountPathMap = await buildAccountPathMap();

        // 5. Build the response with running balance
        let currentRunningBalance = startingBalance;
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
                commodity_mnemonic: split.account.commodity?.mnemonic,
                value_decimal: toDecimal(split.value_num, split.value_denom),
                quantity_decimal: toDecimal(split.quantity_num, split.quantity_denom),
            }));

            // Find the split corresponding to the current account (or any target account in subaccounts mode)
            const accountSplit = enrichedSplits.find(s => targetAccountGuids.includes(s.account_guid));
            const splitValue = accountSplit
                ? Number(accountSplit.quantity_num) / Number(accountSplit.quantity_denom)
                : 0;

            const meta = metaMap.get(tx.guid);
            const row = {
                guid: tx.guid,
                currency_guid: tx.currency_guid,
                num: tx.num,
                post_date: tx.post_date,
                enter_date: tx.enter_date,
                description: tx.description,
                receipt_count: receiptCountMap.get(tx.guid) ?? 0,
                splits: enrichedSplits,
                running_balance: unreviewedOnly ? '' : currentRunningBalance.toFixed(2),
                account_split_value: splitValue.toFixed(2),
                commodity_mnemonic: accountMnemonic,
                account_split_guid: accountSplit?.guid || '',
                account_split_reconcile_state: accountSplit?.reconcile_state || 'n',
                // Transaction meta: reviewed status and source
                reviewed: meta?.reviewed ?? true, // default to reviewed if no meta row
                source: meta?.source ?? 'manual',
                // Investment running totals (only present for investment accounts)
                ...(investmentRunningTotals ? {
                    share_balance: investmentRunningTotals.get(tx.guid)?.shareBalance.toString() ?? '0',
                    cost_basis: investmentRunningTotals.get(tx.guid)?.costBasis.toString() ?? '0',
                } : {}),
            };

            if (!unreviewedOnly) currentRunningBalance -= splitValue;
            return row;
        });

        // Post-fetch filtering: amount range and reconcile states
        let filtered = result;
        if (minAmount !== null) {
            filtered = filtered.filter(tx => Math.abs(parseFloat(tx.account_split_value)) >= minAmount);
        }
        if (maxAmount !== null) {
            filtered = filtered.filter(tx => Math.abs(parseFloat(tx.account_split_value)) <= maxAmount);
        }
        if (reconcileStates.length > 0) {
            filtered = filtered.filter(tx => reconcileStates.includes(tx.account_split_reconcile_state));
        }

        if (isInvestmentAccount) {
            return NextResponse.json(serializeBigInts({
                transactions: filtered,
                is_investment: true,
            }));
        } else {
            return NextResponse.json(serializeBigInts(filtered));
        }
    } catch (error) {
        console.error('Error fetching account transactions:', error);
        return NextResponse.json({ error: 'Failed' }, { status: 500 });
    }
}

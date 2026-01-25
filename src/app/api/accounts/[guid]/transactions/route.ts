import { NextResponse } from 'next/server';
import prisma, { toDecimal } from '@/lib/prisma';
import { serializeBigInts } from '@/lib/gnucash';
import { Prisma } from '@prisma/client';

export async function GET(
    request: Request,
    { params }: { params: Promise<{ guid: string }> }
) {
    try {
        const { searchParams } = new URL(request.url);
        const limit = parseInt(searchParams.get('limit') || '100');
        const offset = parseInt(searchParams.get('offset') || '0');
        const startDate = searchParams.get('startDate');
        const endDate = searchParams.get('endDate');
        const { guid: accountGuid } = await params;

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

        // 1. Get the total balance of the account (considering date filter for filtered balance)
        // For running balance, we need balance as of the end of the date range (or total if no filter)
        const balanceWhere: Prisma.splitsWhereInput = {
            account_guid: accountGuid,
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
        let startingBalance = totalBalance;
        if (offset > 0) {
            // Get transaction GUIDs that are newer (before this page)
            const newerTransactions = await prisma.transactions.findMany({
                where: {
                    ...dateFilter,
                    splits: {
                        some: {
                            account_guid: accountGuid,
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
                        account_guid: accountGuid,
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

        // 3. Fetch transactions for this account with date filtering
        const transactions = await prisma.transactions.findMany({
            where: {
                ...dateFilter,
                splits: {
                    some: {
                        account_guid: accountGuid,
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
            return NextResponse.json([]);
        }

        // 4. Get account mnemonic
        const account = await prisma.accounts.findUnique({
            where: { guid: accountGuid },
            include: { commodity: true },
        });
        const accountMnemonic = account?.commodity?.mnemonic || '';

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
                commodity_mnemonic: split.account.commodity?.mnemonic,
                value_decimal: toDecimal(split.value_num, split.value_denom),
                quantity_decimal: toDecimal(split.quantity_num, split.quantity_denom),
            }));

            // Find the split corresponding to the current account
            const accountSplit = enrichedSplits.find(s => s.account_guid === accountGuid);
            const splitValue = accountSplit
                ? Number(accountSplit.quantity_num) / Number(accountSplit.quantity_denom)
                : 0;

            const row = {
                guid: tx.guid,
                currency_guid: tx.currency_guid,
                num: tx.num,
                post_date: tx.post_date,
                enter_date: tx.enter_date,
                description: tx.description,
                splits: enrichedSplits,
                running_balance: currentRunningBalance.toFixed(2),
                account_split_value: splitValue.toFixed(2),
                commodity_mnemonic: accountMnemonic,
                account_split_guid: accountSplit?.guid || '',
                account_split_reconcile_state: accountSplit?.reconcile_state || 'n',
            };

            currentRunningBalance -= splitValue;
            return row;
        });

        return NextResponse.json(serializeBigInts(result));
    } catch (error) {
        console.error('Error fetching account transactions:', error);
        return NextResponse.json({ error: 'Failed' }, { status: 500 });
    }
}

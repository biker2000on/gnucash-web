import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { getAccountHoldings, getPriceHistory, isInvestmentAccount } from '@/lib/commodities';
import { isAccountInActiveBook } from '@/lib/book-scope';
import { requireRole } from '@/lib/auth';

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ guid: string }> }
) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const { guid } = await params;

        // Verify account belongs to active book
        if (!await isAccountInActiveBook(guid)) {
            return NextResponse.json({ error: 'Account not found' }, { status: 404 });
        }

        const { searchParams } = new URL(request.url);
        const asOfDateStr = searchParams.get('asOfDate');
        const asOfDate = asOfDateStr ? new Date(asOfDateStr) : undefined;
        const daysParam = searchParams.get('days');
        const days = daysParam ? parseInt(daysParam, 10) : 365;

        // Get account details
        const account = await prisma.accounts.findUnique({
            where: { guid },
            include: {
                commodity: true,
            },
        });

        if (!account) {
            return NextResponse.json(
                { error: 'Account not found' },
                { status: 404 }
            );
        }

        // Check if this is an investment account
        const isInvestment = account.commodity?.namespace !== 'CURRENCY';

        if (!isInvestment) {
            return NextResponse.json({
                isInvestment: false,
                account: {
                    guid: account.guid,
                    name: account.name,
                    account_type: account.account_type,
                },
            });
        }

        // Get holdings data
        const holdings = await getAccountHoldings(guid, asOfDate);

        // Get price history
        const priceHistory = account.commodity_guid
            ? await getPriceHistory(account.commodity_guid, undefined, days)
            : [];

        // Get transaction history for this account
        const transactions = await prisma.splits.findMany({
            where: {
                account_guid: guid,
            },
            include: {
                transaction: {
                    select: {
                        guid: true,
                        post_date: true,
                        description: true,
                    },
                },
            },
            orderBy: {
                transaction: {
                    post_date: 'desc',
                },
            },
            take: 50,
        });

        return NextResponse.json({
            isInvestment: true,
            account: {
                guid: account.guid,
                name: account.name,
                account_type: account.account_type,
            },
            commodity: account.commodity ? {
                guid: account.commodity.guid,
                namespace: account.commodity.namespace,
                mnemonic: account.commodity.mnemonic,
                fullname: account.commodity.fullname,
            } : null,
            holdings: {
                shares: holdings.shares,
                costBasis: holdings.costBasis,
                marketValue: holdings.marketValue,
                gainLoss: holdings.gainLoss,
                gainLossPercent: holdings.gainLossPercent,
                latestPrice: holdings.latestPrice,
            },
            priceHistory,
            transactions: transactions.map(split => ({
                guid: split.guid,
                date: split.transaction.post_date?.toISOString().split('T')[0] || '',
                description: split.transaction.description || '',
                shares: Number(split.quantity_num) / Number(split.quantity_denom),
                amount: Number(split.value_num) / Number(split.value_denom),
                action: split.action,
            })),
        });
    } catch (error) {
        console.error('Error fetching valuation:', error);
        return NextResponse.json(
            { error: 'Failed to fetch valuation data' },
            { status: 500 }
        );
    }
}

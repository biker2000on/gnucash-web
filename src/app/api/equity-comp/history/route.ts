import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { requireRole } from '@/lib/auth';
import { getBookAccountGuids } from '@/lib/book-scope';
import { toDecimalNumber } from '@/lib/gnucash';
import { EQUITY_COMP_SLOT, type EquityCompKind } from '@/lib/equity-comp';

export interface EquityCompHistoryItem {
    txGuid: string;
    kind: EquityCompKind;
    postDate: string;
    description: string;
    symbol: string | null;
    stockAccountGuid: string | null;
    shares: number;
    /** Cost basis established for the acquired shares (FMV value). */
    costBasis: number;
    /** Compensation income recognized (positive number). */
    compensationIncome: number;
}

/**
 * @openapi
 * /api/equity-comp/history:
 *   get:
 *     description: >
 *       List previously posted equity compensation transactions (RSU vests and
 *       ESPP purchases), identified by their gnucash_web_equity_comp slot tag.
 *     responses:
 *       200:
 *         description: History list, newest first.
 */
export async function GET() {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const tagSlots = await prisma.slots.findMany({
            where: {
                name: EQUITY_COMP_SLOT,
                string_val: { in: ['vest', 'espp'] },
            },
            select: { obj_guid: true, string_val: true },
        });

        if (tagSlots.length === 0) {
            return NextResponse.json([]);
        }

        const kindByTx = new Map<string, EquityCompKind>(
            tagSlots.map(s => [s.obj_guid, s.string_val as EquityCompKind])
        );

        const bookAccountGuids = new Set(await getBookAccountGuids());

        const transactions = await prisma.transactions.findMany({
            where: { guid: { in: [...kindByTx.keys()] } },
            orderBy: [{ post_date: 'desc' }, { enter_date: 'desc' }],
            include: {
                splits: {
                    include: {
                        account: {
                            select: {
                                guid: true,
                                account_type: true,
                                commodity: {
                                    select: { mnemonic: true, namespace: true },
                                },
                            },
                        },
                    },
                },
            },
        });

        const items: EquityCompHistoryItem[] = [];
        for (const tx of transactions) {
            // Book scoping: only include transactions touching the active book.
            if (!tx.splits.some(s => bookAccountGuids.has(s.account_guid))) continue;

            // Stock leg: non-currency commodity, not a trading split.
            const stockSplit = tx.splits.find(s =>
                s.account.account_type !== 'TRADING' &&
                s.account.commodity?.namespace !== 'CURRENCY'
            );
            // Compensation income leg (negative value → positive income).
            const incomeSplit = tx.splits.find(s => s.account.account_type === 'INCOME');

            items.push({
                txGuid: tx.guid,
                kind: kindByTx.get(tx.guid) ?? 'vest',
                postDate: tx.post_date ? tx.post_date.toISOString().slice(0, 10) : '',
                description: tx.description ?? '',
                symbol: stockSplit?.account.commodity?.mnemonic ?? null,
                stockAccountGuid: stockSplit?.account.guid ?? null,
                shares: stockSplit
                    ? toDecimalNumber(stockSplit.quantity_num, stockSplit.quantity_denom)
                    : 0,
                costBasis: stockSplit
                    ? toDecimalNumber(stockSplit.value_num, stockSplit.value_denom)
                    : 0,
                compensationIncome: incomeSplit
                    ? -toDecimalNumber(incomeSplit.value_num, incomeSplit.value_denom)
                    : 0,
            });
        }

        return NextResponse.json(items);
    } catch (error) {
        console.error('Error fetching equity-comp history:', error);
        return NextResponse.json({ error: 'Failed to fetch equity compensation history' }, { status: 500 });
    }
}

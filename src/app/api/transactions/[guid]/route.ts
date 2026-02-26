import { NextResponse } from 'next/server';
import prisma, { toDecimal, generateGuid } from '@/lib/prisma';
import { serializeBigInts } from '@/lib/gnucash';
import { CreateTransactionRequest } from '@/lib/types';
import { validateTransaction } from '@/lib/validation';
import { logAudit } from '@/lib/services/audit.service';
import { processMultiCurrencySplits } from '@/lib/trading-accounts';
import { getBookAccountGuids, getActiveBookGuid } from '@/lib/book-scope';
import { cacheInvalidateFrom } from '@/lib/cache';
import { requireRole } from '@/lib/auth';

export async function GET(
    request: Request,
    { params }: { params: Promise<{ guid: string }> }
) {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const { guid } = await params;

        // Verify transaction belongs to active book
        const bookAccountGuids = await getBookAccountGuids();
        const txCheck = await prisma.transactions.findFirst({
            where: {
                guid,
                splits: { some: { account_guid: { in: bookAccountGuids } } },
            },
            select: { guid: true },
        });
        if (!txCheck) {
            return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });
        }

        // Fetch transaction with splits
        const transaction = await prisma.transactions.findUnique({
            where: { guid },
            include: {
                splits: {
                    include: {
                        account: {
                            include: {
                                commodity: true,
                            },
                        },
                    },
                    orderBy: {
                        value_num: 'desc',
                    },
                },
            },
        });

        if (!transaction) {
            return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });
        }

        // Get account fullnames from account_hierarchy view
        const accountGuids = transaction.splits.map(s => s.account_guid);
        const accountHierarchy = await prisma.$queryRaw<{ guid: string; fullname: string }[]>`
            SELECT guid, fullname FROM account_hierarchy WHERE guid = ANY(${accountGuids}::text[])
        `;
        const fullnameMap = new Map(accountHierarchy.map(a => [a.guid, a.fullname]));

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
                account_fullname: fullnameMap.get(split.account_guid) || split.account.name,
                commodity_mnemonic: split.account.commodity?.mnemonic,
                value_decimal: toDecimal(split.value_num, split.value_denom),
                quantity_decimal: toDecimal(split.quantity_num, split.quantity_denom),
            })),
        };

        return NextResponse.json(serializeBigInts(result));
    } catch (error) {
        console.error('Error fetching transaction:', error);
        return NextResponse.json({ error: 'Failed to fetch transaction' }, { status: 500 });
    }
}

export async function PUT(
    request: Request,
    { params }: { params: Promise<{ guid: string }> }
) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;

        const { guid } = await params;
        const rawBody = await request.json();
        const { original_enter_date, ...bodyData } = rawBody;
        const body: CreateTransactionRequest = bodyData;

        // Validate the transaction
        const validation = validateTransaction(body);
        if (!validation.valid) {
            return NextResponse.json({ errors: validation.errors }, { status: 400 });
        }

        // Verify transaction exists and capture old values for audit
        const existingTx = await prisma.transactions.findUnique({
            where: { guid },
            include: {
                splits: true,
            },
        });
        if (!existingTx) {
            return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });
        }

        // Optimistic locking: check enter_date hasn't changed since the client read it
        if (original_enter_date && existingTx.enter_date) {
            const currentEnterDate = existingTx.enter_date.toISOString();
            if (currentEnterDate !== original_enter_date) {
                return NextResponse.json(
                    { error: 'Transaction was modified by another user. Please refresh and try again.' },
                    { status: 409 }
                );
            }
        }

        // Verify all account GUIDs exist
        const accountGuids = body.splits.map(s => s.account_guid);
        const accounts = await prisma.accounts.findMany({
            where: {
                guid: { in: accountGuids },
            },
            select: { guid: true },
        });

        if (accounts.length !== accountGuids.length) {
            const foundGuids = new Set(accounts.map(a => a.guid));
            const missingGuids = accountGuids.filter(g => !foundGuids.has(g));
            return NextResponse.json({
                errors: [{ field: 'splits', message: `Invalid account GUIDs: ${missingGuids.join(', ')}` }]
            }, { status: 400 });
        }

        // Track multi-currency status for audit log
        let isMultiCurrency = false;
        let totalSplitsCount = body.splits.length;

        // Update transaction and recreate splits in a transaction
        const transaction = await prisma.$transaction(async (tx) => {
            // Process multi-currency splits and add trading splits if needed
            const multiCurrencyResult = await processMultiCurrencySplits(
                body.splits,
                tx
            );
            isMultiCurrency = multiCurrencyResult.isMultiCurrency;
            const allSplits = multiCurrencyResult.allSplits;
            totalSplitsCount = allSplits.length;

            // Update transaction (enter_date updated for optimistic locking)
            await tx.transactions.update({
                where: { guid },
                data: {
                    currency_guid: body.currency_guid,
                    num: body.num || '',
                    post_date: new Date(body.post_date),
                    enter_date: new Date(),
                    description: body.description,
                },
            });

            // Delete existing splits
            await tx.splits.deleteMany({
                where: { tx_guid: guid },
            });

            // Insert all splits (including auto-generated trading splits)
            for (const split of allSplits) {
                const splitGuid = generateGuid();
                await tx.splits.create({
                    data: {
                        guid: splitGuid,
                        tx_guid: guid,
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

            // Return the updated transaction with splits
            return await tx.transactions.findUnique({
                where: { guid },
                include: {
                    splits: {
                        include: {
                            account: {
                                include: {
                                    commodity: true,
                                },
                            },
                        },
                        orderBy: {
                            value_num: 'desc',
                        },
                    },
                },
            });
        });

        if (!transaction) {
            throw new Error('Failed to update transaction');
        }

        // Log audit event
        await logAudit('UPDATE', 'TRANSACTION', guid, {
            description: existingTx.description,
            post_date: existingTx.post_date,
            splits_count: existingTx.splits.length,
        }, {
            description: body.description,
            post_date: body.post_date,
            splits_count: totalSplitsCount,
            is_multi_currency: isMultiCurrency,
            trading_splits_added: isMultiCurrency ? totalSplitsCount - body.splits.length : 0,
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
                commodity_mnemonic: split.account.commodity?.mnemonic,
                value_decimal: toDecimal(split.value_num, split.value_denom),
                quantity_decimal: toDecimal(split.quantity_num, split.quantity_denom),
            })),
        };

        return NextResponse.json(serializeBigInts(result));
    } catch (error) {
        console.error('Error updating transaction:', error);
        return NextResponse.json({ error: 'Failed to update transaction' }, { status: 500 });
    }
}

export async function DELETE(
    request: Request,
    { params }: { params: Promise<{ guid: string }> }
) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;

        const { guid } = await params;

        // Verify transaction exists and capture values for audit
        const existingTx = await prisma.transactions.findUnique({
            where: { guid },
            include: {
                splits: true,
            },
        });
        if (!existingTx) {
            return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });
        }

        // Preserve SimpleFin meta rows for dedup (NULL out transaction_guid, mark deleted)
        await prisma.$executeRaw`
            UPDATE gnucash_web_transaction_meta
            SET transaction_guid = NULL, deleted_at = NOW()
            WHERE transaction_guid = ${guid}
              AND simplefin_transaction_id IS NOT NULL
        `;

        // Clean up meta rows for non-SimpleFin transactions
        await prisma.$executeRaw`
            DELETE FROM gnucash_web_transaction_meta
            WHERE transaction_guid = ${guid}
              AND simplefin_transaction_id IS NULL
        `;

        // Delete transaction (splits will be cascade deleted due to onDelete: Cascade in schema)
        await prisma.$transaction(async (tx) => {
            // Delete splits first (even though cascade should handle it)
            await tx.splits.deleteMany({
                where: { tx_guid: guid },
            });

            // Delete transaction
            await tx.transactions.delete({
                where: { guid },
            });
        });

        // Log audit event
        await logAudit('DELETE', 'TRANSACTION', guid, {
            description: existingTx.description,
            post_date: existingTx.post_date,
            splits_count: existingTx.splits.length,
        }, null);

        // Invalidate caches from the transaction date forward
        try {
            const bookGuid = await getActiveBookGuid();
            if (existingTx.post_date) {
                const txDate = new Date(existingTx.post_date);
                await cacheInvalidateFrom(bookGuid, txDate);
            }
        } catch (err) {
            // Cache invalidation failure should not break the transaction operation
            console.warn('Cache invalidation failed:', err);
        }

        return NextResponse.json({ success: true, deleted: guid });
    } catch (error) {
        console.error('Error deleting transaction:', error);
        return NextResponse.json({ error: 'Failed to delete transaction' }, { status: 500 });
    }
}

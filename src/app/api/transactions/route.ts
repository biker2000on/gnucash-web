import { NextResponse } from 'next/server';
import prisma, { toDecimal, generateGuid } from '@/lib/prisma';
import { serializeBigInts } from '@/lib/gnucash';
import { Transaction, Split, CreateTransactionRequest } from '@/lib/types';
import { validateTransaction } from '@/lib/validation';
import { Prisma } from '@prisma/client';

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
 *         description: Minimum absolute transaction amount.
 *       - in: query
 *         name: maxAmount
 *         schema:
 *           type: number
 *         description: Maximum absolute transaction amount.
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
        const { searchParams } = new URL(request.url);
        const limit = parseInt(searchParams.get('limit') || '100');
        const offset = parseInt(searchParams.get('offset') || '0');
        const search = searchParams.get('search') || '';
        const startDate = searchParams.get('startDate');
        const endDate = searchParams.get('endDate');
        const accountTypes = searchParams.get('accountTypes');
        const minAmount = searchParams.get('minAmount');
        const maxAmount = searchParams.get('maxAmount');
        const reconcileStates = searchParams.get('reconcileStates');

        // Build where conditions
        const whereConditions: Prisma.transactionsWhereInput = {};

        // Date filters
        if (startDate || endDate) {
            whereConditions.post_date = {};
            if (startDate) {
                whereConditions.post_date.gte = new Date(startDate);
            }
            if (endDate) {
                whereConditions.post_date.lte = new Date(endDate);
            }
        }

        // Search filter (description, num, or account name)
        if (search) {
            whereConditions.OR = [
                { description: { contains: search, mode: 'insensitive' } },
                { num: { contains: search, mode: 'insensitive' } },
                {
                    splits: {
                        some: {
                            account: {
                                name: { contains: search, mode: 'insensitive' },
                            },
                        },
                    },
                },
            ];
        }

        // Account type filter
        if (accountTypes) {
            const types = accountTypes.split(',').map(t => t.trim().toUpperCase());
            whereConditions.splits = {
                ...whereConditions.splits,
                some: {
                    ...((whereConditions.splits as Prisma.SplitsListRelationFilter)?.some || {}),
                    account: {
                        account_type: { in: types },
                    },
                },
            };
        }

        // Amount range filters (need raw SQL for these due to computed values)
        // For minAmount and maxAmount, we'll use Prisma's raw filter
        let minAmountFilter: Prisma.transactionsWhereInput | undefined;
        let maxAmountFilter: Prisma.transactionsWhereInput | undefined;

        if (minAmount || maxAmount || reconcileStates) {
            // These require post-filtering or raw SQL
            // For now, we'll fetch and filter in JS for complex cases
            // This is less efficient but maintains correctness
        }

        // Fetch transactions
        const transactions = await prisma.transactions.findMany({
            where: whereConditions,
            orderBy: {
                post_date: 'desc',
            },
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

        // Post-filter for amount range and reconcile states if needed
        let filteredTransactions = transactions;

        if (minAmount) {
            const minVal = parseFloat(minAmount);
            filteredTransactions = filteredTransactions.filter(tx =>
                tx.splits.some(split => {
                    const absValue = Math.abs(Number(split.value_num) / Number(split.value_denom));
                    return absValue >= minVal;
                })
            );
        }

        if (maxAmount) {
            const maxVal = parseFloat(maxAmount);
            filteredTransactions = filteredTransactions.filter(tx =>
                tx.splits.some(split => {
                    const absValue = Math.abs(Number(split.value_num) / Number(split.value_denom));
                    return absValue <= maxVal;
                })
            );
        }

        if (reconcileStates) {
            const states = reconcileStates.split(',').map(s => s.trim().toLowerCase());
            filteredTransactions = filteredTransactions.filter(tx =>
                tx.splits.some(split => states.includes(split.reconcile_state.toLowerCase()))
            );
        }

        // Transform to response format
        const result = filteredTransactions.map(tx => ({
            guid: tx.guid,
            currency_guid: tx.currency_guid,
            num: tx.num,
            post_date: tx.post_date,
            enter_date: tx.enter_date,
            description: tx.description,
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
        const body: CreateTransactionRequest = await request.json();

        // Validate the transaction
        const validation = validateTransaction(body);
        if (!validation.valid) {
            return NextResponse.json({ errors: validation.errors }, { status: 400 });
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

        // Generate GUIDs
        const txGuid = generateGuid();
        const now = new Date();

        // Create transaction with splits in a transaction
        const transaction = await prisma.$transaction(async (tx) => {
            // Insert transaction
            const newTx = await tx.transactions.create({
                data: {
                    guid: txGuid,
                    currency_guid: body.currency_guid,
                    num: body.num || '',
                    post_date: new Date(body.post_date),
                    enter_date: now,
                    description: body.description,
                },
            });

            // Insert splits
            for (const split of body.splits) {
                const splitGuid = generateGuid();
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
                        quantity_num: BigInt(split.quantity_num ?? split.value_num),
                        quantity_denom: BigInt(split.quantity_denom ?? split.value_denom),
                        lot_guid: null,
                    },
                });
            }

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

        return NextResponse.json(serializeBigInts(result), { status: 201 });
    } catch (error) {
        console.error('Error creating transaction:', error);
        return NextResponse.json({ error: 'Failed to create transaction' }, { status: 500 });
    }
}

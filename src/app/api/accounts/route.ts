import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { serializeBigInts } from '@/lib/gnucash';
import { getLatestPrice } from '@/lib/commodities';
import { Account, AccountWithChildren } from '@/lib/types';
import { Prisma } from '@prisma/client';
import { AccountService, CreateAccountSchema } from '@/lib/services/account.service';

/**
 * @openapi
 * /api/accounts:
 *   get:
 *     description: Returns the account hierarchy with total and period balances.
 *     parameters:
 *       - name: startDate
 *         in: query
 *         description: Start date for period balance calculation (ISO 8601)
 *         schema:
 *           type: string
 *           format: date
 *       - name: endDate
 *         in: query
 *         description: End date for period balance calculation (ISO 8601)
 *         schema:
 *           type: string
 *           format: date
 *     responses:
 *       200:
 *         description: A hierarchical list of accounts.
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Account'
 */
export async function GET(request: NextRequest) {
    try {
        const searchParams = request.nextUrl.searchParams;
        const startDate = searchParams.get('startDate');
        const endDate = searchParams.get('endDate');
        const flat = searchParams.get('flat') === 'true';

        // Flat mode: return all accounts with fullname (for account selector)
        if (flat) {
            // For flat mode, we need a recursive query to build fullnames
            // Using raw SQL for the recursive CTE as Prisma doesn't support recursive queries
            const flatAccounts = await prisma.$queryRaw<Array<{
                guid: string;
                name: string;
                account_type: string;
                parent_guid: string | null;
                commodity_guid: string | null;
                fullname: string;
                commodity_mnemonic: string;
            }>>`
                WITH RECURSIVE account_path AS (
                    SELECT guid, name, account_type, parent_guid, commodity_guid,
                           name::text as fullname
                    FROM accounts
                    WHERE parent_guid IS NULL OR parent_guid NOT IN (SELECT guid FROM accounts)

                    UNION ALL

                    SELECT a.guid, a.name, a.account_type, a.parent_guid, a.commodity_guid,
                           (ap.fullname || ':' || a.name)::text as fullname
                    FROM accounts a
                    JOIN account_path ap ON a.parent_guid = ap.guid
                )
                SELECT ap.guid, ap.name, ap.account_type, ap.parent_guid, ap.commodity_guid, ap.fullname,
                       c.mnemonic as commodity_mnemonic
                FROM account_path ap
                JOIN commodities c ON ap.commodity_guid = c.guid
                WHERE ap.account_type NOT IN ('ROOT')
                ORDER BY ap.fullname
            `;
            return NextResponse.json(serializeBigInts(flatAccounts));
        }

        // Hierarchical mode with balances
        // Build date filter conditions for period balance
        let periodBalanceFilter: Prisma.splitsWhereInput = {};
        if (startDate && endDate) {
            periodBalanceFilter = {
                transaction: {
                    post_date: {
                        gte: new Date(startDate),
                        lte: new Date(endDate),
                    },
                },
            };
        } else if (startDate) {
            periodBalanceFilter = {
                transaction: {
                    post_date: {
                        gte: new Date(startDate),
                    },
                },
            };
        } else if (endDate) {
            periodBalanceFilter = {
                transaction: {
                    post_date: {
                        lte: new Date(endDate),
                    },
                },
            };
        }

        // Fetch all accounts with their commodity and splits
        const accountsData = await prisma.accounts.findMany({
            include: {
                commodity: true,
                splits: {
                    include: {
                        transaction: true,
                    },
                },
            },
        });

        // Calculate balances for each account
        // Pre-fetch prices for investment accounts (STOCK/MUTUAL with non-currency commodities)
        const investmentTypes = ['STOCK', 'MUTUAL'];
        const priceCache = new Map<string, number>();
        for (const acc of accountsData) {
            if (investmentTypes.includes(acc.account_type) && acc.commodity_guid && acc.commodity?.namespace !== 'CURRENCY') {
                if (!priceCache.has(acc.commodity_guid)) {
                    const price = await getLatestPrice(acc.commodity_guid);
                    priceCache.set(acc.commodity_guid, price?.value || 0);
                }
            }
        }

        const accounts: Account[] = accountsData.map(acc => {
            const isInvestment = investmentTypes.includes(acc.account_type) && acc.commodity?.namespace !== 'CURRENCY';
            const pricePerShare = isInvestment && acc.commodity_guid ? (priceCache.get(acc.commodity_guid) || 0) : 0;

            // Calculate total balance from all splits
            let totalBalance = 0;
            let periodBalance = 0;

            for (const split of acc.splits) {
                const qty = Number(split.quantity_num) / Number(split.quantity_denom);
                totalBalance += qty;

                // Check if split's transaction falls within period
                const postDate = split.transaction.post_date;
                if (postDate) {
                    const inPeriod =
                        (!startDate || postDate >= new Date(startDate)) &&
                        (!endDate || postDate <= new Date(endDate));
                    if (inPeriod) {
                        periodBalance += qty;
                    }
                }
            }

            return {
                guid: acc.guid,
                name: acc.name,
                account_type: acc.account_type,
                commodity_guid: acc.commodity_guid || '',
                commodity_scu: acc.commodity_scu,
                non_std_scu: acc.non_std_scu,
                parent_guid: acc.parent_guid,
                code: acc.code || '',
                description: acc.description || '',
                hidden: acc.hidden || 0,
                placeholder: acc.placeholder || 0,
                commodity_mnemonic: acc.commodity?.mnemonic,
                total_balance: totalBalance.toFixed(2),
                period_balance: periodBalance.toFixed(2),
                total_balance_usd: isInvestment ? (totalBalance * pricePerShare).toFixed(2) : undefined,
                period_balance_usd: isInvestment ? (periodBalance * pricePerShare).toFixed(2) : undefined,
            };
        });

        // Build hierarchy
        const accountMap: Record<string, AccountWithChildren> = {};
        const roots: AccountWithChildren[] = [];

        accounts.forEach(acc => {
            accountMap[acc.guid] = { ...acc, children: [] };
        });

        accounts.forEach(acc => {
            const node = accountMap[acc.guid];
            if (acc.parent_guid && accountMap[acc.parent_guid]) {
                accountMap[acc.parent_guid].children.push(node);
            } else {
                roots.push(node);
            }
        });

        // The user wants to display accounts starting 1 level under "Root Account"
        // and hide "Template Root" accounts.
        const rootNode = roots.find(r => r.name === 'Root Account' || r.account_type === 'ROOT' && !r.name.toLowerCase().includes('template'));

        if (rootNode) {
            return NextResponse.json(rootNode.children);
        }

        // Fallback: if no clear root is found, return roots that aren't system roots
        const filteredRoots = roots.filter(r =>
            r.account_type !== 'ROOT' &&
            !r.name.toLowerCase().includes('template root')
        );

        return NextResponse.json(filteredRoots);
    } catch (error) {
        console.error('Error fetching accounts:', error);
        return NextResponse.json({ error: 'Failed to fetch accounts' }, { status: 500 });
    }
}

/**
 * @openapi
 * /api/accounts:
 *   post:
 *     description: Create a new account.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *               - account_type
 *               - commodity_guid
 *             properties:
 *               name:
 *                 type: string
 *               account_type:
 *                 type: string
 *                 enum: [ASSET, BANK, CASH, CREDIT, EQUITY, EXPENSE, INCOME, LIABILITY, MUTUAL, PAYABLE, RECEIVABLE, ROOT, STOCK, TRADING]
 *               parent_guid:
 *                 type: string
 *                 nullable: true
 *               commodity_guid:
 *                 type: string
 *               code:
 *                 type: string
 *               description:
 *                 type: string
 *               hidden:
 *                 type: integer
 *               placeholder:
 *                 type: integer
 *     responses:
 *       201:
 *         description: Account created successfully.
 *       400:
 *         description: Validation error.
 *       500:
 *         description: Server error.
 */
export async function POST(request: NextRequest) {
    try {
        const body = await request.json();

        // Validate input
        const parseResult = CreateAccountSchema.safeParse(body);
        if (!parseResult.success) {
            return NextResponse.json(
                { errors: parseResult.error.issues },
                { status: 400 }
            );
        }

        const account = await AccountService.create(parseResult.data);
        return NextResponse.json(account, { status: 201 });
    } catch (error) {
        console.error('Error creating account:', error);
        if (error instanceof Error) {
            return NextResponse.json({ error: error.message }, { status: 400 });
        }
        return NextResponse.json({ error: 'Failed to create account' }, { status: 500 });
    }
}

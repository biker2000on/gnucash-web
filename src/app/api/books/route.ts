import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { generateGuid } from '@/lib/gnucash';

/**
 * GET /api/books
 * List all books with their root account name and account count.
 */
export async function GET() {
    try {
        const books = await prisma.books.findMany();

        // Enrich each book with name and account count
        const enrichedBooks = await Promise.all(
            books.map(async (book) => {
                const rootAccount = await prisma.accounts.findUnique({
                    where: { guid: book.root_account_guid },
                    select: { name: true },
                });

                // Count accounts under this book's root
                const accountCount = await prisma.$queryRaw<{ count: bigint }[]>`
                    WITH RECURSIVE account_tree AS (
                        SELECT guid FROM accounts WHERE guid = ${book.root_account_guid}
                        UNION ALL
                        SELECT a.guid FROM accounts a
                        JOIN account_tree t ON a.parent_guid = t.guid
                    )
                    SELECT COUNT(*)::bigint as count FROM account_tree
                    WHERE guid != ${book.root_account_guid}
                `;

                return {
                    guid: book.guid,
                    name: rootAccount?.name || 'Unknown',
                    rootAccountGuid: book.root_account_guid,
                    accountCount: Number(accountCount[0]?.count || 0),
                };
            })
        );

        return NextResponse.json(enrichedBooks);
    } catch (error) {
        console.error('Error fetching books:', error);
        return NextResponse.json({ error: 'Failed to fetch books' }, { status: 500 });
    }
}

/**
 * POST /api/books
 * Create a new empty book with standard top-level accounts.
 */
export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const { name } = body;

        if (!name || typeof name !== 'string' || name.trim().length === 0) {
            return NextResponse.json(
                { error: 'Book name is required' },
                { status: 400 }
            );
        }

        // Find a currency commodity (USD by default, or first available currency)
        let currencyGuid = '';
        const usdCurrency = await prisma.commodities.findFirst({
            where: { namespace: 'CURRENCY', mnemonic: 'USD' },
            select: { guid: true },
        });
        if (usdCurrency) {
            currencyGuid = usdCurrency.guid;
        } else {
            const anyCurrency = await prisma.commodities.findFirst({
                where: { namespace: 'CURRENCY' },
                select: { guid: true },
            });
            if (anyCurrency) {
                currencyGuid = anyCurrency.guid;
            } else {
                return NextResponse.json(
                    { error: 'No currency commodities found. Import at least one first.' },
                    { status: 400 }
                );
            }
        }

        const bookGuid = generateGuid();
        const rootAccountGuid = generateGuid();
        const templateRootGuid = generateGuid();

        // Create the book with root accounts and standard structure in a transaction
        await prisma.$transaction(async (tx) => {
            // Create root account
            await tx.accounts.create({
                data: {
                    guid: rootAccountGuid,
                    name: name.trim(),
                    account_type: 'ROOT',
                    commodity_guid: currencyGuid,
                    commodity_scu: 100,
                    non_std_scu: 0,
                    parent_guid: null,
                    code: '',
                    description: '',
                    hidden: 0,
                    placeholder: 0,
                },
            });

            // Create template root account
            await tx.accounts.create({
                data: {
                    guid: templateRootGuid,
                    name: 'Template Root',
                    account_type: 'ROOT',
                    commodity_guid: currencyGuid,
                    commodity_scu: 100,
                    non_std_scu: 0,
                    parent_guid: null,
                    code: '',
                    description: '',
                    hidden: 0,
                    placeholder: 0,
                },
            });

            // Create book record
            await tx.books.create({
                data: {
                    guid: bookGuid,
                    root_account_guid: rootAccountGuid,
                    root_template_guid: templateRootGuid,
                },
            });

            // Create standard top-level accounts
            const standardAccounts = [
                { name: 'Assets', type: 'ASSET' },
                { name: 'Liabilities', type: 'LIABILITY' },
                { name: 'Income', type: 'INCOME' },
                { name: 'Expenses', type: 'EXPENSE' },
                { name: 'Equity', type: 'EQUITY' },
            ];

            for (const acc of standardAccounts) {
                await tx.accounts.create({
                    data: {
                        guid: generateGuid(),
                        name: acc.name,
                        account_type: acc.type,
                        commodity_guid: currencyGuid,
                        commodity_scu: 100,
                        non_std_scu: 0,
                        parent_guid: rootAccountGuid,
                        code: '',
                        description: '',
                        hidden: 0,
                        placeholder: 1,
                    },
                });
            }
        });

        return NextResponse.json(
            { guid: bookGuid, name: name.trim(), rootAccountGuid, accountCount: 5 },
            { status: 201 }
        );
    } catch (error) {
        console.error('Error creating book:', error);
        return NextResponse.json({ error: 'Failed to create book' }, { status: 500 });
    }
}

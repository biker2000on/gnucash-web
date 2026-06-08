import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { generateGuid } from '@/lib/gnucash';
import { requireAuth } from '@/lib/auth';
import { getUserBooks } from '@/lib/services/permission.service';

interface BookSummaryRow {
    guid: string;
    root_account_guid: string;
    root_name: string | null;
    account_count: bigint;
}

/**
 * GET /api/books
 * List all books the current user has access to.
 */
export async function GET() {
    try {
        const authResult = await requireAuth();
        if (authResult instanceof NextResponse) return authResult;

        // Get only books the user has permissions for
        const userBooks = await getUserBooks(authResult.user.id);
        if (userBooks.length === 0) {
            return NextResponse.json([]);
        }

        const userBookGuids = userBooks.map(b => b.guid);
        const roleMap = new Map(userBooks.map(b => [b.guid, b.role]));

        const bookSummaries = await prisma.$queryRaw<BookSummaryRow[]>`
            WITH RECURSIVE book_tree AS (
                SELECT
                    b.guid AS book_guid,
                    b.root_account_guid,
                    b.root_account_guid AS account_guid
                FROM books b
                WHERE b.guid = ANY(${userBookGuids}::text[])

                UNION ALL

                SELECT
                    bt.book_guid,
                    bt.root_account_guid,
                    a.guid AS account_guid
                FROM accounts a
                JOIN book_tree bt ON a.parent_guid = bt.account_guid
            )
            SELECT
                b.guid,
                b.root_account_guid,
                root.name AS root_name,
                COUNT(bt.account_guid) FILTER (WHERE bt.account_guid != b.root_account_guid)::bigint AS account_count
            FROM books b
            LEFT JOIN accounts root ON root.guid = b.root_account_guid
            LEFT JOIN book_tree bt ON bt.book_guid = b.guid
            WHERE b.guid = ANY(${userBookGuids}::text[])
            GROUP BY b.guid, b.root_account_guid, root.name
        `;
        const summaryMap = new Map(bookSummaries.map(summary => [summary.guid, summary]));

        const books = await prisma.books.findMany({
            where: { guid: { in: userBookGuids } },
            orderBy: { name: 'asc' },
        });

        const enrichedBooks = books.map((book) => {
            const summary = summaryMap.get(book.guid);
            return {
                guid: book.guid,
                name: book.name ?? summary?.root_name ?? 'Unnamed Book',
                description: book.description,
                rootAccountGuid: book.root_account_guid,
                accountCount: Number(summary?.account_count || 0),
                role: roleMap.get(book.guid),
            };
        });

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
        const authResult = await requireAuth();
        if (authResult instanceof NextResponse) return authResult;

        const body = await request.json();
        const { name, description } = body;

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
                    name: name.trim(),
                    description: description || null,
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
            { guid: bookGuid, name: name.trim(), description: description || null, rootAccountGuid, accountCount: 5 },
            { status: 201 }
        );
    } catch (error) {
        console.error('Error creating book:', error);
        return NextResponse.json({ error: 'Failed to create book' }, { status: 500 });
    }
}

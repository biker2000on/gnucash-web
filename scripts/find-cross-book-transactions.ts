/**
 * Read-only diagnostic for transactions whose splits belong to more than one
 * book root. A hit requires manual repair: transaction PUT and DELETE
 * intentionally return 404 for these rows so no book can mutate another
 * book's data through a cross-book transaction.
 *
 * Account ownership is resolved through resolveBookLockGuidForAccount(),
 * which reuses the existing bounded (depth < 200) parent_guid recursive walk
 * in src/lib/book-lock.ts rather than introducing another ownership CTE.
 *
 * Run: npx tsx scripts/find-cross-book-transactions.ts
 */
import prisma from '@/lib/prisma';
import { resolveBookLockGuidForAccount } from '@/lib/book-lock';

async function main(): Promise<void> {
    const splits = await prisma.splits.findMany({
        select: { tx_guid: true, account_guid: true },
        orderBy: [{ tx_guid: 'asc' }, { account_guid: 'asc' }],
    });

    const ownerByAccount = new Map<string, string>();
    const booksByTransaction = new Map<string, Set<string>>();
    for (const split of splits) {
        let owner = ownerByAccount.get(split.account_guid);
        if (!owner) {
            owner = await resolveBookLockGuidForAccount(split.account_guid);
            ownerByAccount.set(split.account_guid, owner);
        }
        const owners = booksByTransaction.get(split.tx_guid) ?? new Set<string>();
        owners.add(owner);
        booksByTransaction.set(split.tx_guid, owners);
    }

    const crossBook = [...booksByTransaction]
        .filter(([, owners]) => owners.size > 1)
        .map(([tx_guid, owners]) => ({ tx_guid, book_guids: [...owners].sort() }));

    if (crossBook.length === 0) {
        console.log('No cross-book transactions found.');
        return;
    }

    console.log(JSON.stringify(crossBook, null, 2));
    process.exitCode = 1;
}

main()
    .catch(error => {
        console.error('Failed to inspect cross-book transactions:', error);
        process.exitCode = 2;
    })
    .finally(async () => {
        await prisma.$disconnect();
    });

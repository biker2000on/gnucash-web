import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { getBookAccountGuids } from '@/lib/book-scope';
import { requireRole } from '@/lib/auth';

/** Tag names that mark an account (and all its descendants) as a tax account. */
const TAX_TAG_NAMES = ['tax', 'taxes'];

/**
 * GET /api/dashboard/tax-accounts
 *
 * Returns the set of account GUIDs that should be treated as tax accounts on
 * the dashboard. An account is a tax account if it (or any ancestor) carries
 * the "tax" or "taxes" tag. When no accounts are tagged, `tagged` is false and
 * the client falls back to word-boundary name matching.
 */
export async function GET() {
    try {
        const roleResult = await requireRole('readonly');
        if (roleResult instanceof NextResponse) return roleResult;

        const bookAccountGuids = await getBookAccountGuids();
        const bookGuidSet = new Set(bookAccountGuids);

        const taggedRows = await prisma.gnucash_web_account_tags.findMany({
            where: {
                tag: { name: { in: TAX_TAG_NAMES } },
            },
            select: { account_guid: true },
        });

        const taggedGuids = taggedRows
            .map(r => r.account_guid)
            .filter(guid => bookGuidSet.has(guid));

        if (taggedGuids.length === 0) {
            return NextResponse.json({ guids: [], tagged: false });
        }

        // Expand to all descendants: tagging a parent marks the whole subtree.
        const accounts = await prisma.accounts.findMany({
            where: { guid: { in: bookAccountGuids } },
            select: { guid: true, parent_guid: true },
        });

        const childrenMap = new Map<string, string[]>();
        for (const acc of accounts) {
            if (acc.parent_guid) {
                const children = childrenMap.get(acc.parent_guid) || [];
                children.push(acc.guid);
                childrenMap.set(acc.parent_guid, children);
            }
        }

        const result = new Set<string>();
        const queue = [...taggedGuids];
        while (queue.length > 0) {
            const guid = queue.pop()!;
            if (result.has(guid)) continue;
            result.add(guid);
            const children = childrenMap.get(guid);
            if (children) queue.push(...children);
        }

        return NextResponse.json({ guids: [...result], tagged: true });
    } catch (error) {
        console.error('Error fetching tax accounts:', error);
        return NextResponse.json(
            { error: 'Failed to fetch tax accounts' },
            { status: 500 }
        );
    }
}

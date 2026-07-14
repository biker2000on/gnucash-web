import prisma from '@/lib/prisma';
import { getActiveBookGuid } from '@/lib/book-scope';
import { normalizeTagName, isValidTagName, pickTagColor, type Tag } from '@/lib/tags';

/**
 * Resolve a list of raw tag names to tag rows in the active book, creating
 * any that don't exist (with auto-assigned palette colors, under the active
 * book). Throws on invalid names.
 */
export async function resolveOrCreateTags(rawNames: string[]): Promise<Tag[]> {
    const names: string[] = [];
    const seen = new Set<string>();
    for (const raw of rawNames) {
        const name = normalizeTagName(String(raw ?? ''));
        if (!isValidTagName(name)) {
            throw new Error(`Invalid tag name: "${raw}". Use lowercase letters, digits, hyphens, and underscores.`);
        }
        if (!seen.has(name)) {
            seen.add(name);
            names.push(name);
        }
    }

    if (names.length === 0) return [];

    const bookGuid = await getActiveBookGuid();

    const existing = await prisma.gnucash_web_tags.findMany({
        where: { book_guid: bookGuid, name: { in: names } },
    });
    const existingByName = new Map(existing.map(t => [t.name, t]));

    const missing = names.filter(n => !existingByName.has(n));
    if (missing.length > 0) {
        const allColors = await prisma.gnucash_web_tags.findMany({
            where: { book_guid: bookGuid },
            select: { color: true },
        });
        const usedColors = allColors.map(t => t.color);
        for (const name of missing) {
            const color = pickTagColor(usedColors);
            usedColors.push(color);
            const created = await prisma.gnucash_web_tags.create({
                data: { book_guid: bookGuid, name, color },
            });
            existingByName.set(name, created);
        }
    }

    return names.map(n => {
        const tag = existingByName.get(n)!;
        return { id: tag.id, name: tag.name, color: tag.color, description: tag.description };
    });
}

/** Fetch the tags assigned to a transaction. */
export async function getTransactionTags(transactionGuid: string): Promise<Tag[]> {
    const rows = await prisma.gnucash_web_transaction_tags.findMany({
        where: { transaction_guid: transactionGuid },
        include: { tag: true },
        orderBy: { tag: { name: 'asc' } },
    });
    return rows.map(r => ({
        id: r.tag.id,
        name: r.tag.name,
        color: r.tag.color,
        description: r.tag.description,
    }));
}

/** Replace the full tag list for a transaction (creating tags by name as needed). */
export async function setTransactionTags(transactionGuid: string, rawNames: string[]): Promise<Tag[]> {
    const tags = await resolveOrCreateTags(rawNames);
    await prisma.$transaction([
        prisma.gnucash_web_transaction_tags.deleteMany({
            where: { transaction_guid: transactionGuid },
        }),
        ...(tags.length > 0 ? [
            prisma.gnucash_web_transaction_tags.createMany({
                data: tags.map(t => ({ transaction_guid: transactionGuid, tag_id: t.id })),
            }),
        ] : []),
    ]);
    return tags;
}

/** Fetch the tags assigned to an account. */
export async function getAccountTags(accountGuid: string): Promise<Tag[]> {
    const rows = await prisma.gnucash_web_account_tags.findMany({
        where: { account_guid: accountGuid },
        include: { tag: true },
        orderBy: { tag: { name: 'asc' } },
    });
    return rows.map(r => ({
        id: r.tag.id,
        name: r.tag.name,
        color: r.tag.color,
        description: r.tag.description,
    }));
}

/** Replace the full tag list for an account (creating tags by name as needed). */
export async function setAccountTags(accountGuid: string, rawNames: string[]): Promise<Tag[]> {
    const tags = await resolveOrCreateTags(rawNames);
    await prisma.$transaction([
        prisma.gnucash_web_account_tags.deleteMany({
            where: { account_guid: accountGuid },
        }),
        ...(tags.length > 0 ? [
            prisma.gnucash_web_account_tags.createMany({
                data: tags.map(t => ({ account_guid: accountGuid, tag_id: t.id })),
            }),
        ] : []),
    ]);
    return tags;
}

/**
 * Batch-fetch direct tags for a set of transactions.
 * Returns a map of transaction_guid -> Tag[].
 */
export async function getTagsForTransactions(transactionGuids: string[]): Promise<Map<string, Tag[]>> {
    const map = new Map<string, Tag[]>();
    if (transactionGuids.length === 0) return map;

    const rows = await prisma.gnucash_web_transaction_tags.findMany({
        where: { transaction_guid: { in: transactionGuids } },
        include: { tag: true },
    });
    for (const row of rows) {
        const list = map.get(row.transaction_guid) ?? [];
        list.push({ id: row.tag.id, name: row.tag.name, color: row.tag.color });
        map.set(row.transaction_guid, list);
    }
    for (const list of map.values()) {
        list.sort((a, b) => a.name.localeCompare(b.name));
    }
    return map;
}

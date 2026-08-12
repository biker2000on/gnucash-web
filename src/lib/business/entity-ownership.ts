/**
 * Book scope for the native GnuCash business tables.
 *
 * `customers`, `vendors`, `employees`, `jobs`, `invoices`, `orders`,
 * `billterms` and `taxtables` are native GnuCash tables with no `book_guid`
 * column — the desktop app assumes one book per database. This app is
 * multi-book with per-book RBAC, so ownership is kept in an app-owned side
 * table (created in db-init.ts, backfilled there too).
 *
 * Semantics deliberately match `budget-ownership.ts`: **missing ownership means
 * foreign**. An unattributed entity is invisible rather than visible to
 * everyone, so a gap in the backfill cannot become a cross-book leak.
 */

import prisma from '@/lib/prisma';

export type BusinessEntityType =
    | 'customer'
    | 'vendor'
    | 'employee'
    | 'job'
    | 'invoice'
    | 'order'
    | 'billterm'
    | 'taxtable';

/** Minimal client shape so callers can pass a transaction client. */
export interface EntityOwnershipClient {
    gnucash_web_business_entity_ownership: {
        create(args: {
            data: { entity_type: string; entity_guid: string; book_guid: string };
        }): Promise<unknown>;
        findUnique(args: {
            where: { entity_type_entity_guid: { entity_type: string; entity_guid: string } };
            select: { book_guid: true };
        }): Promise<{ book_guid: string } | null>;
        findMany(args: {
            where: { entity_type: string; book_guid: string };
            select: { entity_guid: true };
        }): Promise<Array<{ entity_guid: string }>>;
        deleteMany(args: {
            where: { entity_type: string; entity_guid: string };
        }): Promise<unknown>;
    };
}

/** Raised when a caller reaches for an entity outside its authorized book. */
export class BusinessEntityScopeError extends Error {
    constructor(entityType: BusinessEntityType) {
        super(`${entityType} not found`);
        this.name = 'BusinessEntityScopeError';
    }
}

function client(db?: EntityOwnershipClient): EntityOwnershipClient {
    return db ?? (prisma as unknown as EntityOwnershipClient);
}

/**
 * Record the owning book for a newly created entity. Callers must pass the
 * same transaction that creates the entity row, so an entity can never be
 * committed without an owner.
 */
export async function recordEntityOwnership(
    entityType: BusinessEntityType,
    entityGuid: string,
    bookGuid: string,
    db?: EntityOwnershipClient,
): Promise<void> {
    await client(db).gnucash_web_business_entity_ownership.create({
        data: { entity_type: entityType, entity_guid: entityGuid, book_guid: bookGuid },
    });
}

/** True only when the entity is explicitly owned by the requested book. */
export async function isEntityOwnedByBook(
    entityType: BusinessEntityType,
    entityGuid: string,
    bookGuid: string,
    db?: EntityOwnershipClient,
): Promise<boolean> {
    const row = await client(db).gnucash_web_business_entity_ownership.findUnique({
        where: { entity_type_entity_guid: { entity_type: entityType, entity_guid: entityGuid } },
        select: { book_guid: true },
    });
    return row?.book_guid === bookGuid;
}

/** The book that owns an entity, or null when it is unattributed. */
export async function getEntityOwnerBook(
    entityType: BusinessEntityType,
    entityGuid: string,
    db?: EntityOwnershipClient,
): Promise<string | null> {
    const row = await client(db).gnucash_web_business_entity_ownership.findUnique({
        where: { entity_type_entity_guid: { entity_type: entityType, entity_guid: entityGuid } },
        select: { book_guid: true },
    });
    return row?.book_guid ?? null;
}

/** Throw unless the entity belongs to the book. Use before any single-entity read or write. */
export async function assertEntityOwnedByBook(
    entityType: BusinessEntityType,
    entityGuid: string,
    bookGuid: string,
    db?: EntityOwnershipClient,
): Promise<void> {
    if (!(await isEntityOwnedByBook(entityType, entityGuid, bookGuid, db))) {
        throw new BusinessEntityScopeError(entityType);
    }
}

/**
 * Guids of one entity type owned by a book — the filter for every list query.
 * An empty array means "this book owns none", which callers must treat as an
 * empty result rather than as "no filter".
 */
export async function listOwnedEntityGuids(
    entityType: BusinessEntityType,
    bookGuid: string,
    db?: EntityOwnershipClient,
): Promise<string[]> {
    const rows = await client(db).gnucash_web_business_entity_ownership.findMany({
        where: { entity_type: entityType, book_guid: bookGuid },
        select: { entity_guid: true },
    });
    return rows.map(r => r.entity_guid);
}

/**
 * Client shape for book teardown: raw SQL, because the native business tables
 * must be deleted in foreign-key order and Prisma has no cascade for them.
 */
export interface EntityTeardownClient {
    $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number>;
}

/**
 * Delete every native business entity owned by a book, child-first.
 *
 * Must run BEFORE the book's transactions and accounts are removed: invoices
 * reference the posting transaction and account. Ownership rows are removed
 * last, since they are what identifies the entities in the first place — the
 * books FK would otherwise cascade them away and strand the native rows
 * permanently (invisible, because unowned means foreign).
 */
export async function deleteOwnedBusinessEntitiesForBook(
    db: EntityTeardownClient,
    bookGuid: string,
): Promise<void> {
    const owned = (type: BusinessEntityType) =>
        `SELECT entity_guid FROM gnucash_web_business_entity_ownership
          WHERE entity_type = '${type}' AND book_guid = $1`;

    // Children before parents. None of the native business tables carry real
    // foreign keys (verified against the live schema: zero FK constraints on
    // entries/invoices/taxtables/taxtable_entries), so nothing cascades — every
    // child row must be named explicitly or it is orphaned when its parent goes.
    //
    // A vendor BILL is an `invoices` row with owner_type = vendor; its line
    // items hang off `entries.bill` while `entries.invoice` stays NULL. Both
    // attachment columns must be swept, exactly as the XML importer's
    // overwrite-clearing path does (clearCollisionRows in gnucash-xml/importer.ts).
    await db.$executeRawUnsafe(
        `DELETE FROM entries WHERE invoice IN (${owned('invoice')})`, bookGuid);
    await db.$executeRawUnsafe(
        `DELETE FROM entries WHERE bill IN (${owned('invoice')})`, bookGuid);
    await db.$executeRawUnsafe(
        `DELETE FROM entries WHERE order_guid IN (${owned('order')})`, bookGuid);
    await db.$executeRawUnsafe(
        `DELETE FROM invoices WHERE guid IN (${owned('invoice')})`, bookGuid);
    await db.$executeRawUnsafe(
        `DELETE FROM orders WHERE guid IN (${owned('order')})`, bookGuid);
    await db.$executeRawUnsafe(
        `DELETE FROM jobs WHERE guid IN (${owned('job')})`, bookGuid);
    await db.$executeRawUnsafe(
        `DELETE FROM customers WHERE guid IN (${owned('customer')})`, bookGuid);
    await db.$executeRawUnsafe(
        `DELETE FROM vendors WHERE guid IN (${owned('vendor')})`, bookGuid);
    await db.$executeRawUnsafe(
        `DELETE FROM employees WHERE guid IN (${owned('employee')})`, bookGuid);
    // Tax-table rates are rows in taxtable_entries keyed by `taxtable`, with no
    // FK and therefore no cascade — drop them before their taxtable.
    await db.$executeRawUnsafe(
        `DELETE FROM taxtable_entries WHERE taxtable IN (${owned('taxtable')})`, bookGuid);
    await db.$executeRawUnsafe(
        `DELETE FROM taxtables WHERE guid IN (${owned('taxtable')})`, bookGuid);
    await db.$executeRawUnsafe(
        `DELETE FROM billterms WHERE guid IN (${owned('billterm')})`, bookGuid);

    await db.$executeRawUnsafe(
        `DELETE FROM gnucash_web_business_entity_ownership WHERE book_guid = $1`, bookGuid);
}

/** Drop the ownership row when the entity itself is deleted. */
export async function deleteEntityOwnership(
    entityType: BusinessEntityType,
    entityGuid: string,
    db?: EntityOwnershipClient,
): Promise<void> {
    await client(db).gnucash_web_business_entity_ownership.deleteMany({
        where: { entity_type: entityType, entity_guid: entityGuid },
    });
}

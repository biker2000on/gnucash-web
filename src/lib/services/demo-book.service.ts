/**
 * Demo Book Service
 *
 * Creates a fully seeded demo book — 'Demo Household' or 'Demo Business' —
 * so new users can explore reports, the tax estimator, and business tools
 * with realistic data before importing their own.
 *
 * Flow:
 *  1. Pick a unique name ('Demo Household', 'Demo Household 2', ...).
 *  2. createDefaultBook() with the matching entity template (household /
 *     llc_single) and the DEMO description marker the UI badges on.
 *  3. Save an entity profile (named household members / LLC owner) and grant
 *     the creating user admin on the new book.
 *  4. Apply the deterministic seed plan from src/lib/demo-seed.ts: extra
 *     accounts, ~12 months of transactions, demo-stock prices, and tax
 *     category mappings (business books map Income/Expenses so the estimated
 *     tax and S-corp analyzers demo well).
 *
 * Deleting a demo book is just the normal book DELETE
 * (DELETE /api/books/[guid]) — demo books carry no special rows beyond what
 * that route already cleans up.
 */

import prisma from '@/lib/prisma';
import { generateGuid } from '@/lib/gnucash';
import { createDefaultBook } from '@/lib/default-book';
import { saveEntityProfile } from '@/lib/services/entity.service';
import { grantRole } from '@/lib/services/permission.service';
import {
    buildDemoSeedPlan,
    DEMO_BOOK_DESCRIPTION,
    DEMO_STOCK,
    type DemoBookKind,
    type DemoSeedPlan,
} from '@/lib/demo-seed';

export const DEMO_BOOK_KINDS: DemoBookKind[] = ['household', 'business'];

export interface CreateDemoBookResult {
    bookGuid: string;
    name: string;
    transactionCount: number;
}

/** 'Demo Household' → 'Demo Household 2' → ... first name not already taken. */
async function pickUniqueName(baseName: string): Promise<string> {
    const existing = await prisma.books.findMany({
        where: { name: { startsWith: baseName } },
        select: { name: true },
    });
    const taken = new Set(existing.map(b => b.name));
    if (!taken.has(baseName)) return baseName;
    for (let n = 2; ; n++) {
        const candidate = `${baseName} ${n}`;
        if (!taken.has(candidate)) return candidate;
    }
}

interface AccountRow {
    guid: string;
    name: string;
    parent_guid: string | null;
}

/** Map of colon-delimited path (relative to root) → account guid. */
async function buildPathMap(rootGuid: string): Promise<Map<string, string>> {
    const rows = await prisma.$queryRaw<AccountRow[]>`
        WITH RECURSIVE account_tree AS (
            SELECT guid, name, parent_guid FROM accounts WHERE guid = ${rootGuid}
            UNION ALL
            SELECT a.guid, a.name, a.parent_guid FROM accounts a
            JOIN account_tree t ON a.parent_guid = t.guid
        )
        SELECT guid, name, parent_guid FROM account_tree
    `;
    const byGuid = new Map(rows.map(r => [r.guid, r]));
    const pathMap = new Map<string, string>();
    for (const row of rows) {
        if (row.guid === rootGuid) continue;
        const segments: string[] = [];
        let cursor: AccountRow | undefined = row;
        while (cursor && cursor.guid !== rootGuid) {
            segments.unshift(cursor.name);
            cursor = cursor.parent_guid ? byGuid.get(cursor.parent_guid) : undefined;
        }
        pathMap.set(segments.join(':'), row.guid);
    }
    return pathMap;
}

/** Find or create the DEMO stock commodity (shared across demo books). */
async function ensureDemoCommodity(): Promise<string> {
    const existing = await prisma.commodities.findFirst({
        where: { namespace: DEMO_STOCK.namespace, mnemonic: DEMO_STOCK.mnemonic },
        select: { guid: true },
    });
    if (existing) return existing.guid;
    const created = await prisma.commodities.create({
        data: {
            guid: generateGuid(),
            namespace: DEMO_STOCK.namespace,
            mnemonic: DEMO_STOCK.mnemonic,
            fullname: DEMO_STOCK.fullname,
            cusip: '',
            fraction: DEMO_STOCK.fraction,
            quote_flag: 0,
            quote_source: '',
            quote_tz: '',
        },
    });
    return created.guid;
}

/**
 * Ensure every account the plan references exists, creating missing ones
 * under their (template-created) parents. Returns path → guid for the whole
 * book tree including the new accounts.
 */
async function ensurePlanAccounts(
    plan: DemoSeedPlan,
    rootGuid: string,
    usdGuid: string,
    demoCommodityGuid: string | null
): Promise<Map<string, string>> {
    const pathMap = await buildPathMap(rootGuid);

    for (const spec of plan.accounts) {
        if (pathMap.has(spec.path)) continue;

        const lastColon = spec.path.lastIndexOf(':');
        const parentPath = lastColon >= 0 ? spec.path.slice(0, lastColon) : '';
        const name = lastColon >= 0 ? spec.path.slice(lastColon + 1) : spec.path;
        const parentGuid = parentPath === '' ? rootGuid : pathMap.get(parentPath);
        if (!parentGuid) {
            throw new Error(`Demo seed: parent account not found for path "${spec.path}"`);
        }

        const isStock = spec.commodity === 'DEMO';
        if (isStock && !demoCommodityGuid) {
            throw new Error('Demo seed: DEMO commodity required but not provided');
        }
        const guid = generateGuid();
        await prisma.accounts.create({
            data: {
                guid,
                name,
                account_type: spec.type,
                commodity_guid: isStock ? demoCommodityGuid! : usdGuid,
                commodity_scu: isStock ? DEMO_STOCK.fraction : 100,
                non_std_scu: 0,
                parent_guid: parentGuid,
                code: '',
                description: '',
                hidden: 0,
                placeholder: 0,
            },
        });
        pathMap.set(spec.path, guid);
    }

    return pathMap;
}

async function insertPlanTransactions(
    plan: DemoSeedPlan,
    pathMap: Map<string, string>,
    usdGuid: string
): Promise<number> {
    const now = new Date();
    const txRows: {
        guid: string;
        currency_guid: string;
        num: string;
        post_date: Date;
        enter_date: Date;
        description: string;
    }[] = [];
    const splitRows: {
        guid: string;
        tx_guid: string;
        account_guid: string;
        memo: string;
        action: string;
        reconcile_state: string;
        reconcile_date: null;
        value_num: bigint;
        value_denom: bigint;
        quantity_num: bigint;
        quantity_denom: bigint;
        lot_guid: null;
    }[] = [];

    for (const tx of plan.transactions) {
        const txGuid = generateGuid();
        txRows.push({
            guid: txGuid,
            currency_guid: usdGuid,
            num: tx.num ?? '',
            // Noon UTC keeps the calendar date stable across server timezones.
            post_date: new Date(`${tx.date}T12:00:00Z`),
            enter_date: now,
            description: tx.description,
        });
        for (const split of tx.splits) {
            const accountGuid = pathMap.get(split.accountPath);
            if (!accountGuid) {
                throw new Error(`Demo seed: account not found for path "${split.accountPath}"`);
            }
            splitRows.push({
                guid: generateGuid(),
                tx_guid: txGuid,
                account_guid: accountGuid,
                memo: split.memo ?? '',
                action: split.action ?? '',
                reconcile_state: 'n',
                reconcile_date: null,
                value_num: BigInt(split.valueCents),
                value_denom: 100n,
                quantity_num: BigInt(split.quantityNum ?? split.valueCents),
                quantity_denom: BigInt(split.quantityDenom ?? 100),
                lot_guid: null,
            });
        }
    }

    await prisma.$transaction([
        prisma.transactions.createMany({ data: txRows }),
        prisma.splits.createMany({ data: splitRows }),
    ]);
    return txRows.length;
}

async function insertPlanPrices(
    plan: DemoSeedPlan,
    demoCommodityGuid: string,
    usdGuid: string
): Promise<void> {
    if (plan.prices.length === 0) return;
    // The prices table has no unique constraint on (commodity, date) — dedup
    // against existing rows so a second demo book doesn't double-insert.
    const existing = await prisma.prices.findMany({
        where: { commodity_guid: demoCommodityGuid, currency_guid: usdGuid },
        select: { date: true },
    });
    const existingDates = new Set(existing.map(p => p.date.toISOString().slice(0, 10)));
    const rows = plan.prices
        .filter(p => !existingDates.has(p.date))
        .map(p => ({
            guid: generateGuid(),
            commodity_guid: demoCommodityGuid,
            currency_guid: usdGuid,
            date: new Date(`${p.date}T12:00:00Z`),
            source: 'user:price',
            type: 'last',
            value_num: BigInt(p.priceCents),
            value_denom: 100n,
        }));
    if (rows.length > 0) {
        await prisma.prices.createMany({ data: rows });
    }
}

async function applyTaxMappings(
    plan: DemoSeedPlan,
    pathMap: Map<string, string>
): Promise<void> {
    for (const mapping of plan.taxMappings) {
        const accountGuid = pathMap.get(mapping.accountPath);
        if (!accountGuid) {
            throw new Error(`Demo seed: account not found for tax mapping "${mapping.accountPath}"`);
        }
        await prisma.gnucash_web_tax_mappings.upsert({
            where: { account_guid: accountGuid },
            create: { account_guid: accountGuid, tax_category: mapping.taxCategory },
            update: { tax_category: mapping.taxCategory, updated_at: new Date() },
        });
    }
}

/**
 * Create a demo book seeded with ~12 months of deterministic sample data.
 * The creating user is granted admin on the new book.
 */
export async function createDemoBook(
    userId: number,
    kind: DemoBookKind,
    today: Date = new Date()
): Promise<CreateDemoBookResult> {
    const baseName = kind === 'household' ? 'Demo Household' : 'Demo Business';
    const name = await pickUniqueName(baseName);
    const entityType = kind === 'household' ? 'household' : 'llc_single';

    const bookGuid = await createDefaultBook(name, DEMO_BOOK_DESCRIPTION, entityType, 'USD');
    await grantRole(userId, bookGuid, 'admin', userId);

    if (kind === 'household') {
        await saveEntityProfile(bookGuid, {
            entityType: 'household',
            entityName: null,
            filingStatus: 'mfj',
            members: [
                { role: 'self', name: 'Alex Demo', birthday: '1988-04-12', coveredByEmployerPlan: true, sortOrder: 0 },
                { role: 'spouse', name: 'Jordan Demo', birthday: '1990-09-27', coveredByEmployerPlan: false, sortOrder: 1 },
            ],
        });
    } else {
        await saveEntityProfile(bookGuid, {
            entityType: 'llc_single',
            entityName: 'Demo Consulting LLC',
            members: [
                { role: 'owner', name: 'Alex Demo', ownershipPercent: 100, sortOrder: 0 },
            ],
        });
    }

    const book = await prisma.books.findUnique({
        where: { guid: bookGuid },
        select: { root_account_guid: true },
    });
    if (!book) throw new Error('Demo book creation failed: book not found after create');

    const usd = await prisma.commodities.findFirst({
        where: { namespace: 'CURRENCY', mnemonic: 'USD' },
        select: { guid: true },
    });
    if (!usd) throw new Error('USD commodity not found');

    const plan = buildDemoSeedPlan(kind, today);
    const demoCommodityGuid = plan.prices.length > 0 || plan.accounts.some(a => a.commodity === 'DEMO')
        ? await ensureDemoCommodity()
        : null;

    const pathMap = await ensurePlanAccounts(plan, book.root_account_guid, usd.guid, demoCommodityGuid);
    const transactionCount = await insertPlanTransactions(plan, pathMap, usd.guid);
    if (demoCommodityGuid) {
        await insertPlanPrices(plan, demoCommodityGuid, usd.guid);
    }
    await applyTaxMappings(plan, pathMap);

    return { bookGuid, name, transactionCount };
}

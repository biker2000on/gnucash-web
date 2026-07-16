/**
 * Personal-finance import service (Mint / YNAB / Monarch → EXISTING book).
 *
 * previewPersonalImport() parses the upload, resolves source accounts and
 * categories against the active book (auto-suggestions + caller mappings),
 * detects duplicates against existing transactions, and reports which rows
 * fall inside the book's period lock. No writes.
 *
 * commitPersonalImport() re-runs the same plan and applies it: accounts via
 * findOrCreateAccount (with account_type fix-up), then chunked createMany
 * for two-split transactions. Period-locked rows are SKIPPED (not fatal) and
 * surfaced in the result; a gnucash_web_import_batches row records the run
 * with source 'mint' | 'ynab' | 'monarch'.
 */

import prisma from '@/lib/prisma';
import { generateGuid, fromDecimal, findOrCreateAccount, toDecimalNumber } from '@/lib/gnucash';
import { invalidateBookAccountGuidsCache } from '@/lib/book-scope';
import { getCachedLockDate } from '@/lib/services/period-lock.service';
import { resolveImportLocale, type ImportLocaleId } from './parse-locale';
import { parseMintCsv } from './mint';
import { parseYnabCsv } from './ynab';
import { parseMonarchCsv } from './monarch';
import {
    buildPersonalPlan,
    CATEGORY_TARGET_TYPES,
    SOURCE_TARGET_TYPES,
    type BookAccount,
    type ExistingTransactionKey,
    type PersonalImportPlan,
    type PersonalParseResult,
    type PersonalPlanOptions,
    type PersonalSource,
    type PlannedAccountCreate,
    type PlannedPersonalTransaction,
} from './personal-import';

export const PERSONAL_SOURCES: readonly PersonalSource[] = ['mint', 'ynab', 'monarch'] as const;

export const PERSONAL_SOURCE_LABELS: Record<PersonalSource, string> = {
    mint: 'Mint',
    ynab: 'YNAB',
    monarch: 'Monarch Money',
};

export function isPersonalSource(s: string): s is PersonalSource {
    return (PERSONAL_SOURCES as readonly string[]).includes(s);
}

/** Dispatch to the right row parser for a source. */
export function parsePersonalCsv(
    source: PersonalSource,
    content: string,
    localeId?: ImportLocaleId | null
): PersonalParseResult {
    const locale = resolveImportLocale(localeId);
    switch (source) {
        case 'mint':
            return parseMintCsv(content, locale);
        case 'ynab':
            return parseYnabCsv(content, locale);
        case 'monarch':
            return parseMonarchCsv(content, locale);
    }
}

/* ------------------------------------------------------------------ */
/* Shared input / context                                               */
/* ------------------------------------------------------------------ */

export interface PersonalImportInput {
    content: string;
    locale?: ImportLocaleId | null;
    accountMappings?: Record<string, string>;
    categoryMappings?: Record<string, string>;
    skipDuplicates?: boolean;
    filename?: string | null;
}

export interface PersonalBookContext {
    bookGuid: string;
    rootGuid: string;
    bookAccountGuids: string[];
}

/* ------------------------------------------------------------------ */
/* Book loading helpers                                                 */
/* ------------------------------------------------------------------ */

/** Every account in the book with its colon path relative to the root. */
export async function loadBookAccounts(
    rootGuid: string,
    bookGuids: string[]
): Promise<BookAccount[]> {
    const rows = await prisma.accounts.findMany({
        where: { guid: { in: bookGuids } },
        select: {
            guid: true,
            name: true,
            parent_guid: true,
            account_type: true,
            placeholder: true,
        },
    });

    const byGuid = new Map(rows.map((r) => [r.guid, r]));
    const fullnameCache = new Map<string, string>();

    function fullnameOf(guid: string): string {
        if (guid === rootGuid) return '';
        const cached = fullnameCache.get(guid);
        if (cached !== undefined) return cached;
        const row = byGuid.get(guid);
        if (!row) return '';
        const parentPath =
            row.parent_guid && row.parent_guid !== rootGuid ? fullnameOf(row.parent_guid) : '';
        const full = parentPath ? `${parentPath}:${row.name}` : row.name;
        fullnameCache.set(guid, full);
        return full;
    }

    return rows
        .filter((r) => r.guid !== rootGuid && r.account_type !== 'ROOT')
        .map((r) => ({
            guid: r.guid,
            name: r.name,
            fullname: fullnameOf(r.guid),
            accountType: r.account_type,
            placeholder: r.placeholder === 1,
        }));
}

/** Existing transactions in the mapped target accounts, for duplicate detection. */
async function loadExistingTransactions(
    targetGuids: string[],
    dates: string[]
): Promise<ExistingTransactionKey[]> {
    if (targetGuids.length === 0 || dates.length === 0) return [];
    const sorted = [...dates].sort();
    const min = new Date(`${sorted[0]}T00:00:00Z`);
    const max = new Date(`${sorted[sorted.length - 1]}T23:59:59Z`);

    const splits = await prisma.splits.findMany({
        where: {
            account_guid: { in: targetGuids },
            transaction: { post_date: { gte: min, lte: max } },
        },
        select: {
            account_guid: true,
            value_num: true,
            value_denom: true,
            transaction: { select: { post_date: true, description: true } },
        },
    });

    const result: ExistingTransactionKey[] = [];
    for (const s of splits) {
        const postDate = s.transaction?.post_date;
        if (!postDate) continue;
        result.push({
            accountGuid: s.account_guid,
            date: postDate.toISOString().slice(0, 10),
            amount: toDecimalNumber(s.value_num, s.value_denom),
            description: s.transaction?.description ?? '',
        });
    }
    return result;
}

/** Book currency: root's commodity when it is a currency, else CURRENCY:USD. */
export async function resolveBookCurrency(
    rootGuid: string
): Promise<{ guid: string; fraction: number } | null> {
    const root = await prisma.accounts.findUnique({
        where: { guid: rootGuid },
        select: { commodity: { select: { guid: true, namespace: true, fraction: true } } },
    });
    if (root?.commodity && root.commodity.namespace === 'CURRENCY') {
        return { guid: root.commodity.guid, fraction: Number(root.commodity.fraction) || 100 };
    }
    const usd = await prisma.commodities.findFirst({
        where: { namespace: 'CURRENCY', mnemonic: 'USD' },
        select: { guid: true, fraction: true },
    });
    return usd ? { guid: usd.guid, fraction: Number(usd.fraction) || 100 } : null;
}

/* ------------------------------------------------------------------ */
/* Plan preparation (shared by preview + commit)                        */
/* ------------------------------------------------------------------ */

interface PreparedPlan {
    parsed: PersonalParseResult;
    plan: PersonalImportPlan;
    accounts: BookAccount[];
    lockDate: string | null;
    lockedTransactions: PlannedPersonalTransaction[];
    importableTransactions: PlannedPersonalTransaction[];
}

async function preparePlan(
    source: PersonalSource,
    input: PersonalImportInput,
    ctx: PersonalBookContext
): Promise<PreparedPlan> {
    const parsed = parsePersonalCsv(source, input.content, input.locale);
    const accounts = await loadBookAccounts(ctx.rootGuid, ctx.bookAccountGuids);

    const planOptions: PersonalPlanOptions = {
        accountMappings: input.accountMappings,
        categoryMappings: input.categoryMappings,
        skipDuplicates: input.skipDuplicates !== false,
    };

    // Phase 1: resolve targets without duplicate data, then load the existing
    // transactions for the resolved EXISTING targets and re-plan with them.
    const prePlan = buildPersonalPlan(parsed.records, accounts, [], planOptions);
    const targetGuids = prePlan.sourceAccounts
        .map((s) => (s.target.kind === 'existing' ? s.target.guid : null))
        .filter((g): g is string => Boolean(g));
    const existing = await loadExistingTransactions(
        targetGuids,
        parsed.records.map((r) => r.date)
    );
    const plan = buildPersonalPlan(parsed.records, accounts, existing, planOptions);

    // Period lock: rows on or before the lock date are skipped, not fatal.
    const lockDate = await getCachedLockDate(ctx.bookGuid);
    const lockedTransactions: PlannedPersonalTransaction[] = [];
    const importableTransactions: PlannedPersonalTransaction[] = [];
    for (const t of plan.transactions) {
        if (lockDate && t.date <= lockDate) lockedTransactions.push(t);
        else importableTransactions.push(t);
    }

    return { parsed, plan, accounts, lockDate, lockedTransactions, importableTransactions };
}

/* ------------------------------------------------------------------ */
/* Preview                                                              */
/* ------------------------------------------------------------------ */

export interface PersonalPreviewAccountRow {
    name: string;
    records: number;
    /** Resolved target (mapping > suggestion > new) */
    targetGuid: string | null;
    targetPath: string;
    accountType: string;
    isNew: boolean;
    mapped: boolean;
}

export interface PersonalPreviewCategoryRow {
    name: string;
    records: number;
    total: number;
    targetGuid: string | null;
    targetPath: string;
    accountType: string;
    isNew: boolean;
    mapped: boolean;
}

export interface AccountOption {
    guid: string;
    path: string;
    type: string;
}

export interface PersonalPreview {
    source: PersonalSource;
    transactionCount: number;
    rowsRead: number;
    errorCount: number;
    duplicateCount: number;
    lockedCount: number;
    lockDate: string | null;
    ambiguousDateRows: number;
    dateRange: { start: string; end: string } | null;
    accounts: PersonalPreviewAccountRow[];
    categories: PersonalPreviewCategoryRow[];
    errors: Array<{ row: number; message: string }>;
    warnings: string[];
    /** Existing accounts pickable as source-account targets */
    sourceAccountOptions: AccountOption[];
    /** Existing accounts pickable as category targets */
    categoryAccountOptions: AccountOption[];
    sampleTransactions: Array<{
        date: string;
        description: string;
        amount: number;
        account: string;
        category: string;
    }>;
    skippedDuplicates: Array<{
        row: number;
        date: string;
        amount: number;
        description: string;
        account: string;
    }>;
}

export async function previewPersonalImport(
    source: PersonalSource,
    input: PersonalImportInput,
    ctx: PersonalBookContext
): Promise<PersonalPreview> {
    const { parsed, plan, accounts, lockDate, lockedTransactions, importableTransactions } =
        await preparePlan(source, input, ctx);

    const warnings = [...parsed.warnings, ...plan.warnings];
    if (parsed.ambiguousDateRows > 0) {
        warnings.push(
            `${parsed.ambiguousDateRows} row${parsed.ambiguousDateRows === 1 ? ' has a date' : 's have dates'} that could be read either month-first or day-first (e.g. 03/04/2025). ` +
                'Double-check the date format selector if the date range below looks wrong.'
        );
    }
    if (lockedTransactions.length > 0 && lockDate) {
        warnings.push(
            `${lockedTransactions.length} transaction${lockedTransactions.length === 1 ? '' : 's'} dated on or before the book's period lock (${lockDate}) will be skipped.`
        );
    }

    const optionList = (types: Set<string>): AccountOption[] =>
        accounts
            .filter((a) => types.has(a.accountType) && !a.placeholder)
            .map((a) => ({ guid: a.guid, path: a.fullname, type: a.accountType }))
            .sort((a, b) => a.path.localeCompare(b.path));

    return {
        source,
        transactionCount: importableTransactions.length,
        rowsRead: parsed.rowsRead,
        errorCount: parsed.errors.length,
        duplicateCount: plan.duplicates.length,
        lockedCount: lockedTransactions.length,
        lockDate,
        ambiguousDateRows: parsed.ambiguousDateRows,
        dateRange: parsed.dateRange,
        accounts: plan.sourceAccounts.map((s) => ({
            name: s.name,
            records: s.records,
            targetGuid: s.target.kind === 'existing' ? s.target.guid : null,
            targetPath: s.path,
            accountType: s.accountType,
            isNew: s.isNew,
            mapped: s.mapped,
        })),
        categories: plan.categories.map((c) => ({
            name: c.name,
            records: c.records,
            total: c.total,
            targetGuid: c.target.kind === 'existing' ? c.target.guid : null,
            targetPath: c.path,
            accountType: c.accountType,
            isNew: c.isNew,
            mapped: c.mapped,
        })),
        errors: parsed.errors.slice(0, 200),
        warnings,
        sourceAccountOptions: optionList(SOURCE_TARGET_TYPES),
        categoryAccountOptions: optionList(CATEGORY_TARGET_TYPES),
        sampleTransactions: importableTransactions.slice(0, 25).map((t) => ({
            date: t.date,
            description: t.description,
            amount: t.splits[0].amount,
            account: t.sourceAccount,
            category: t.category,
        })),
        skippedDuplicates: plan.duplicates.slice(0, 100),
    };
}

/* ------------------------------------------------------------------ */
/* Commit                                                               */
/* ------------------------------------------------------------------ */

export interface PersonalCommitResult {
    accountsCreated: number;
    transactionsCreated: number;
    splitsCreated: number;
    duplicatesSkipped: number;
    lockedSkipped: number;
    errorRows: number;
    warnings: string[];
    batchId: number;
}

const CHUNK = 2000;

/**
 * Create a planned account path under the book root, then fix the
 * account_type of newly created segments (findOrCreateAccount defaults them
 * to INCOME). Mirrors the QIF importer's approach.
 */
export async function createPlannedAccount(
    tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
    planned: PlannedAccountCreate,
    rootGuid: string,
    currencyGuid: string
): Promise<{ guid: string; created: number }> {
    const segments = planned.path.split(':').filter((s) => s.trim() !== '');

    // Which leading segments already exist?
    let parentGuid = rootGuid;
    let existingDepth = 0;
    for (const segment of segments) {
        const existingRow = await tx.accounts.findFirst({
            where: { name: segment, parent_guid: parentGuid },
            select: { guid: true },
        });
        if (!existingRow) break;
        parentGuid = existingRow.guid;
        existingDepth++;
    }

    const leafGuid = await findOrCreateAccount(planned.path, rootGuid, currencyGuid, tx);

    if (existingDepth < segments.length) {
        // Re-walk and set the type of every newly created segment.
        let walkGuid = rootGuid;
        const newGuids: string[] = [];
        for (let i = 0; i < segments.length; i++) {
            const row = await tx.accounts.findFirst({
                where: { name: segments[i], parent_guid: walkGuid },
                select: { guid: true },
            });
            if (!row) break;
            walkGuid = row.guid;
            if (i >= existingDepth) newGuids.push(row.guid);
        }
        if (newGuids.length > 0) {
            await tx.accounts.updateMany({
                where: { guid: { in: newGuids } },
                data: { account_type: planned.accountType },
            });
        }
        return { guid: leafGuid, created: segments.length - existingDepth };
    }
    return { guid: leafGuid, created: 0 };
}

export async function commitPersonalImport(
    userId: number,
    source: PersonalSource,
    input: PersonalImportInput,
    ctx: PersonalBookContext
): Promise<PersonalCommitResult> {
    const { parsed, plan, lockDate, lockedTransactions, importableTransactions } =
        await preparePlan(source, input, ctx);

    if (importableTransactions.length === 0) {
        const detail =
            parsed.errors[0]?.message ??
            (lockedTransactions.length > 0
                ? `all rows fall on or before the period lock (${lockDate}).`
                : plan.duplicates.length > 0
                    ? 'every row is a duplicate of an existing transaction.'
                    : undefined);
        throw new Error(`No importable transactions found in the upload${detail ? `: ${detail}` : '.'}`);
    }

    const currency = await resolveBookCurrency(ctx.rootGuid);
    if (!currency) {
        throw new Error('No currency commodity available for this book.');
    }

    const result: PersonalCommitResult = {
        accountsCreated: 0,
        transactionsCreated: 0,
        splitsCreated: 0,
        duplicatesSkipped: input.skipDuplicates !== false ? plan.duplicates.length : 0,
        lockedSkipped: lockedTransactions.length,
        errorRows: parsed.errors.length,
        warnings: [...parsed.warnings, ...plan.warnings],
        batchId: 0,
    };

    // Only accounts actually referenced by importable transactions get created.
    const referencedKeys = new Set<string>();
    for (const t of importableTransactions) {
        for (const s of t.splits) {
            if (s.account.kind === 'new') referencedKeys.add(s.account.key);
        }
    }
    const accountsToCreate = plan.accountsToCreate.filter((a) => referencedKeys.has(a.key));

    await prisma.$transaction(
        async (tx) => {
            // 1. Accounts (few; sequential findOrCreateAccount is fine)
            const newAccountGuids = new Map<string, string>();
            for (const planned of accountsToCreate) {
                const { guid, created } = await createPlannedAccount(
                    tx,
                    planned,
                    ctx.rootGuid,
                    currency.guid
                );
                newAccountGuids.set(planned.key, guid);
                result.accountsCreated += created;
            }

            const resolveRef = (ref: PlannedPersonalTransaction['splits'][number]['account']): string => {
                if (ref.kind === 'existing') return ref.guid;
                const guid = newAccountGuids.get(ref.key);
                if (!guid) throw new Error(`Import plan references unknown account key "${ref.key}"`);
                return guid;
            };

            // 2. Transactions + splits (chunked createMany; txns first — FK)
            const enterDate = new Date();
            const transactionRows: Array<{
                guid: string;
                currency_guid: string;
                num: string;
                post_date: Date;
                enter_date: Date;
                description: string;
            }> = [];
            const splitRows: Array<{
                guid: string;
                tx_guid: string;
                account_guid: string;
                memo: string;
                action: string;
                reconcile_state: string;
                reconcile_date: Date | null;
                value_num: bigint;
                value_denom: bigint;
                quantity_num: bigint;
                quantity_denom: bigint;
                lot_guid: null;
            }> = [];

            for (const txn of importableTransactions) {
                const txGuid = generateGuid();
                // Noon UTC, matching the QIF/QBO importers' post_date convention.
                const postDate = new Date(`${txn.date}T12:00:00Z`);
                transactionRows.push({
                    guid: txGuid,
                    currency_guid: currency.guid,
                    num: '',
                    post_date: postDate,
                    enter_date: enterDate,
                    description: txn.description.slice(0, 2048),
                });
                for (const split of txn.splits) {
                    const { num, denom } = fromDecimal(split.amount, currency.fraction);
                    splitRows.push({
                        guid: generateGuid(),
                        tx_guid: txGuid,
                        account_guid: resolveRef(split.account),
                        memo: (split.memo || '').slice(0, 2048),
                        action: '',
                        reconcile_state: 'n',
                        reconcile_date: null,
                        value_num: num,
                        value_denom: denom,
                        quantity_num: num,
                        quantity_denom: denom,
                        lot_guid: null,
                    });
                }
            }

            for (let i = 0; i < transactionRows.length; i += CHUNK) {
                await tx.transactions.createMany({ data: transactionRows.slice(i, i + CHUNK) });
            }
            for (let i = 0; i < splitRows.length; i += CHUNK) {
                await tx.splits.createMany({ data: splitRows.slice(i, i + CHUNK) });
            }
            result.transactionsCreated = transactionRows.length;
            result.splitsCreated = splitRows.length;
        },
        { maxWait: 10_000, timeout: 300_000 }
    );

    if (result.accountsCreated > 0) invalidateBookAccountGuidsCache();

    const batch = await prisma.gnucash_web_import_batches.create({
        data: {
            book_guid: ctx.bookGuid,
            source,
            filename: input.filename ?? null,
            total_items: parsed.records.length + parsed.errors.length,
            matched_items: result.transactionsCreated,
            user_id: userId,
            status: 'completed',
            completed_at: new Date(),
            settings: {
                dateRange: parsed.dateRange,
                locale: input.locale ?? 'us',
                errorCount: parsed.errors.length,
                duplicatesSkipped: result.duplicatesSkipped,
                lockedSkipped: result.lockedSkipped,
                accountsCreated: result.accountsCreated,
                skipDuplicates: input.skipDuplicates !== false,
            },
        },
    });
    result.batchId = batch.id;

    return result;
}

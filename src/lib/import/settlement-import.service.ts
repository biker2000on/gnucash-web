/**
 * Settlement import service (Stripe / Square / PayPal / Shopify → the
 * ACTIVE business book).
 *
 * previewSettlementImport() parses the payout CSV, resolves the four target
 * roles (income, processing-fee expense, processor clearing account, bank),
 * detects duplicates against previously imported settlements via the
 * '<source>:<reference>' stamp in transactions.num, and reports which rows
 * fall inside the book's period lock. No writes.
 *
 * commitSettlementImport() re-runs the same plan and applies it: the mapped
 * accounts via findOrCreateAccount (type fixed up), then chunked createMany
 * transactions built by buildSettlementSplits(). Period-locked rows are
 * SKIPPED (not fatal); a gnucash_web_import_batches row records the run with
 * source 'settlement_<source>'.
 *
 * Accounting per row (debit positive):
 *   sale/refund/fee_only/other: clearing +net / fees +fee / income -gross
 *   payout:                     clearing +net / bank -net
 * so the clearing account nets toward zero and bank deposits match payouts.
 */

import prisma from '@/lib/prisma';
import { generateGuid, fromDecimal } from '@/lib/gnucash';
import { invalidateBookAccountGuidsCache } from '@/lib/book-scope';
import { getCachedLockDate } from '@/lib/services/period-lock.service';
import { resolveImportLocale, type ImportLocaleId } from './parse-locale';
import {
    parseSettlementCsv,
    buildSettlementSplits,
    dedupeStamp,
    SETTLEMENT_SOURCE_LABELS,
    type SettlementKind,
    type SettlementParseResult,
    type SettlementRecord,
    type SettlementRole,
    type SettlementSource,
} from './settlements';
import { suggestCategoryAccount, type BookAccount } from './personal-import';
import {
    loadBookAccounts,
    resolveBookCurrency,
    createPlannedAccount,
    type AccountOption,
    type PersonalBookContext,
} from './personal-import.service';

/* ------------------------------------------------------------------ */
/* Input / context                                                      */
/* ------------------------------------------------------------------ */

/** Per-role target: an existing account guid, or 'new' for the default path. */
export type SettlementMappings = Partial<Record<SettlementRole, string>>;

export interface SettlementImportInput {
    content: string;
    locale?: ImportLocaleId | null;
    mappings?: SettlementMappings;
    skipDuplicates?: boolean;
    filename?: string | null;
}

export type SettlementBookContext = PersonalBookContext;

/** Account types each role may map onto. */
export const SETTLEMENT_ROLE_TYPES: Record<SettlementRole, ReadonlySet<string>> = {
    income: new Set(['INCOME']),
    fees: new Set(['EXPENSE']),
    clearing: new Set(['ASSET', 'BANK']),
    bank: new Set(['BANK', 'ASSET', 'CASH']),
};

export const SETTLEMENT_ROLE_LABELS: Record<SettlementRole, string> = {
    income: 'Income (gross sales)',
    fees: 'Processing fees (expense)',
    clearing: 'Processor clearing account',
    bank: 'Bank account (payouts)',
};

function defaultRolePath(role: SettlementRole, source: SettlementSource): {
    path: string;
    accountType: string;
} {
    const label = SETTLEMENT_SOURCE_LABELS[source];
    switch (role) {
        case 'income':
            return { path: 'Income:Sales', accountType: 'INCOME' };
        case 'fees':
            return { path: 'Expenses:Processing Fees', accountType: 'EXPENSE' };
        case 'clearing':
            return { path: `Assets:Payment Clearing:${label}`, accountType: 'ASSET' };
        case 'bank':
            return { path: 'Assets:Bank', accountType: 'BANK' };
    }
}

/* ------------------------------------------------------------------ */
/* Role resolution                                                      */
/* ------------------------------------------------------------------ */

export interface RoleResolution {
    role: SettlementRole;
    /** Resolved existing account, or null when a new account will be created */
    targetGuid: string | null;
    /** Display path (existing fullname or to-be-created path) */
    path: string;
    accountType: string;
    isNew: boolean;
    /** True when the target came from the caller's mapping (vs auto-suggest) */
    mapped: boolean;
    /** False when no importable row posts to this role */
    used: boolean;
}

function norm(s: string): string {
    return s.trim().toLowerCase();
}

function resolveRoles(
    source: SettlementSource,
    accounts: BookAccount[],
    mappings: SettlementMappings,
    usedRoles: Set<SettlementRole>,
    warnings: string[]
): Record<SettlementRole, RoleResolution> {
    const byGuid = new Map(accounts.map((a) => [a.guid, a]));

    const resolve = (role: SettlementRole): RoleResolution => {
        const def = defaultRolePath(role, source);
        const mapping = mappings[role];

        if (mapping && mapping !== 'new') {
            const acct = byGuid.get(mapping);
            if (acct && SETTLEMENT_ROLE_TYPES[role].has(acct.accountType) && !acct.placeholder) {
                return {
                    role,
                    targetGuid: acct.guid,
                    path: acct.fullname,
                    accountType: acct.accountType,
                    isNew: false,
                    mapped: true,
                    used: usedRoles.has(role),
                };
            }
            warnings.push(
                `The ${SETTLEMENT_ROLE_LABELS[role]} mapping is not a usable ` +
                    `${Array.from(SETTLEMENT_ROLE_TYPES[role]).join('/')} account in this book; using the default instead.`
            );
        }

        if (mapping !== 'new') {
            // Auto-suggestion per role.
            if (role === 'clearing') {
                const existing = accounts.find(
                    (a) =>
                        SETTLEMENT_ROLE_TYPES.clearing.has(a.accountType) &&
                        norm(a.fullname) === norm(def.path)
                );
                if (existing) {
                    return {
                        role,
                        targetGuid: existing.guid,
                        path: existing.fullname,
                        accountType: existing.accountType,
                        isNew: false,
                        mapped: false,
                        used: usedRoles.has(role),
                    };
                }
            } else if (role === 'income' || role === 'fees') {
                const suggestion = suggestCategoryAccount(
                    role === 'income' ? 'Sales' : 'Processing Fees',
                    accounts,
                    role === 'income'
                );
                if (suggestion && SETTLEMENT_ROLE_TYPES[role].has(suggestion.accountType)) {
                    return {
                        role,
                        targetGuid: suggestion.guid,
                        path: suggestion.fullname,
                        accountType: suggestion.accountType,
                        isNew: false,
                        mapped: false,
                        used: usedRoles.has(role),
                    };
                }
            } else if (role === 'bank') {
                const banks = accounts
                    .filter((a) => a.accountType === 'BANK' && !a.placeholder)
                    .sort((a, b) => a.fullname.localeCompare(b.fullname));
                if (banks.length > 0) {
                    if (banks.length > 1 && usedRoles.has('bank')) {
                        warnings.push(
                            `Multiple bank accounts exist — payouts default to "${banks[0].fullname}". Review the bank mapping.`
                        );
                    }
                    return {
                        role,
                        targetGuid: banks[0].guid,
                        path: banks[0].fullname,
                        accountType: banks[0].accountType,
                        isNew: false,
                        mapped: false,
                        used: usedRoles.has(role),
                    };
                }
                if (usedRoles.has('bank')) {
                    warnings.push(
                        `No bank account found in this book — payouts will post to a new "${def.path}" account. Review the bank mapping.`
                    );
                }
            }
        }

        return {
            role,
            targetGuid: null,
            path: def.path,
            accountType: def.accountType,
            isNew: true,
            mapped: mapping === 'new',
            used: usedRoles.has(role),
        };
    };

    return {
        income: resolve('income'),
        fees: resolve('fees'),
        clearing: resolve('clearing'),
        bank: resolve('bank'),
    };
}

/* ------------------------------------------------------------------ */
/* Plan preparation (shared by preview + commit)                        */
/* ------------------------------------------------------------------ */

interface PlannedSettlementTransaction {
    record: SettlementRecord;
    stamp: string | null;
    splits: Array<{ role: SettlementRole; amount: number }>;
}

interface PreparedSettlementPlan {
    parsed: SettlementParseResult;
    accounts: BookAccount[];
    roles: Record<SettlementRole, RoleResolution>;
    warnings: string[];
    lockDate: string | null;
    importable: PlannedSettlementTransaction[];
    duplicates: SettlementRecord[];
    locked: SettlementRecord[];
    /** Importable rows with no reference (duplicate detection unavailable) */
    unreferencedCount: number;
}

const STAMP_CHUNK = 1000;

/** Which stamps already exist on transactions inside this book? */
async function loadExistingStamps(
    stamps: string[],
    bookAccountGuids: string[]
): Promise<Set<string>> {
    const found = new Set<string>();
    if (stamps.length === 0 || bookAccountGuids.length === 0) return found;
    const unique = Array.from(new Set(stamps));
    for (let i = 0; i < unique.length; i += STAMP_CHUNK) {
        const chunk = unique.slice(i, i + STAMP_CHUNK);
        const rows = await prisma.transactions.findMany({
            where: {
                num: { in: chunk },
                splits: { some: { account_guid: { in: bookAccountGuids } } },
            },
            select: { num: true },
        });
        for (const r of rows) found.add(r.num);
    }
    return found;
}

async function prepareSettlementPlan(
    source: SettlementSource,
    input: SettlementImportInput,
    ctx: SettlementBookContext
): Promise<PreparedSettlementPlan> {
    const locale = resolveImportLocale(input.locale);
    const parsed = parseSettlementCsv(source, input.content, locale);
    const accounts = await loadBookAccounts(ctx.rootGuid, ctx.bookAccountGuids);
    const warnings = [...parsed.warnings];
    const skipDuplicates = input.skipDuplicates !== false;

    // Build split plans first so we know which roles are actually used.
    const planned: PlannedSettlementTransaction[] = [];
    for (const record of parsed.records) {
        const splits = buildSettlementSplits(record);
        if (splits.length === 0) continue; // zero-amount row
        planned.push({ record, stamp: dedupeStamp(source, record.reference), splits });
    }
    const usedRoles = new Set<SettlementRole>();
    for (const p of planned) for (const s of p.splits) usedRoles.add(s.role);

    const roles = resolveRoles(source, accounts, input.mappings ?? {}, usedRoles, warnings);

    // Duplicate detection: stamps already present in this book, plus repeats
    // of (stamp + net) within the file itself.
    const existingStamps = await loadExistingStamps(
        planned.map((p) => p.stamp).filter((s): s is string => s !== null),
        ctx.bookAccountGuids
    );
    const seenInFile = new Set<string>();
    const lockDate = await getCachedLockDate(ctx.bookGuid);

    const importable: PlannedSettlementTransaction[] = [];
    const duplicates: SettlementRecord[] = [];
    const locked: SettlementRecord[] = [];
    let unreferencedCount = 0;

    for (const p of planned) {
        if (p.stamp) {
            const fileKey = `${p.stamp}|${p.record.net.toFixed(2)}`;
            if (existingStamps.has(p.stamp) || seenInFile.has(fileKey)) {
                duplicates.push(p.record);
                if (skipDuplicates) continue;
            }
            seenInFile.add(fileKey);
        } else {
            unreferencedCount++;
        }
        if (lockDate && p.record.date <= lockDate) {
            locked.push(p.record);
            continue;
        }
        importable.push(p);
    }

    if (unreferencedCount > 0) {
        warnings.push(
            `${unreferencedCount} row${unreferencedCount === 1 ? ' has' : 's have'} no reference id — ` +
                'duplicate detection cannot protect against re-importing them.'
        );
    }
    if (parsed.ambiguousDateRows > 0) {
        warnings.push(
            `${parsed.ambiguousDateRows} row${parsed.ambiguousDateRows === 1 ? ' has a date' : 's have dates'} that could be read either month-first or day-first (e.g. 03/04/2025). ` +
                'Double-check the date format selector if the date range looks wrong.'
        );
    }
    if (locked.length > 0 && lockDate) {
        warnings.push(
            `${locked.length} transaction${locked.length === 1 ? '' : 's'} dated on or before the book's period lock (${lockDate}) will be skipped.`
        );
    }

    return { parsed, accounts, roles, warnings, lockDate, importable, duplicates, locked, unreferencedCount };
}

/* ------------------------------------------------------------------ */
/* Preview                                                              */
/* ------------------------------------------------------------------ */

export interface SettlementPreview {
    source: SettlementSource;
    transactionCount: number;
    rowsRead: number;
    errorCount: number;
    duplicateCount: number;
    lockedCount: number;
    lockDate: string | null;
    statusSkipped: number;
    ambiguousDateRows: number;
    dateRange: { start: string; end: string } | null;
    /** Importable rows per kind */
    kindCounts: Record<SettlementKind, number>;
    /** Over importable non-payout rows */
    totals: { gross: number; fees: number; net: number };
    /** Money moved to the bank by importable payout rows */
    payoutTotal: number;
    /** Net change to the clearing account across ALL importable rows */
    clearingProjection: number;
    accounts: RoleResolution[];
    /** Existing accounts pickable per role */
    accountOptions: Record<SettlementRole, AccountOption[]>;
    errors: Array<{ row: number; message: string }>;
    warnings: string[];
    sampleTransactions: Array<{
        date: string;
        kind: SettlementKind;
        description: string;
        gross: number;
        fee: number;
        net: number;
        reference: string;
    }>;
    skippedDuplicates: Array<{
        row: number;
        date: string;
        net: number;
        description: string;
        reference: string;
    }>;
}

function round2(n: number): number {
    return Math.round(n * 100) / 100;
}

export async function previewSettlementImport(
    source: SettlementSource,
    input: SettlementImportInput,
    ctx: SettlementBookContext
): Promise<SettlementPreview> {
    const { parsed, accounts, roles, warnings, lockDate, importable, duplicates, locked } =
        await prepareSettlementPlan(source, input, ctx);

    const kindCounts: Record<SettlementKind, number> = {
        sale: 0,
        refund: 0,
        fee_only: 0,
        payout: 0,
        other: 0,
    };
    let gross = 0;
    let fees = 0;
    let net = 0;
    let payoutTotal = 0;
    let clearingProjection = 0;
    for (const p of importable) {
        kindCounts[p.record.kind]++;
        if (p.record.kind === 'payout') {
            payoutTotal += -p.record.net;
        } else {
            gross += p.record.gross;
            fees += p.record.fee;
            net += p.record.net;
        }
        clearingProjection += p.record.net;
    }

    const optionList = (role: SettlementRole): AccountOption[] =>
        accounts
            .filter((a) => SETTLEMENT_ROLE_TYPES[role].has(a.accountType) && !a.placeholder)
            .map((a) => ({ guid: a.guid, path: a.fullname, type: a.accountType }))
            .sort((a, b) => a.path.localeCompare(b.path));

    return {
        source,
        transactionCount: importable.length,
        rowsRead: parsed.rowsRead,
        errorCount: parsed.errors.length,
        duplicateCount: duplicates.length,
        lockedCount: locked.length,
        lockDate,
        statusSkipped: parsed.statusSkipped,
        ambiguousDateRows: parsed.ambiguousDateRows,
        dateRange: parsed.dateRange,
        kindCounts,
        totals: { gross: round2(gross), fees: round2(fees), net: round2(net) },
        payoutTotal: round2(payoutTotal),
        clearingProjection: round2(clearingProjection),
        accounts: [roles.income, roles.fees, roles.clearing, roles.bank],
        accountOptions: {
            income: optionList('income'),
            fees: optionList('fees'),
            clearing: optionList('clearing'),
            bank: optionList('bank'),
        },
        errors: parsed.errors.slice(0, 200),
        warnings,
        sampleTransactions: importable.slice(0, 25).map((p) => ({
            date: p.record.date,
            kind: p.record.kind,
            description: p.record.description,
            gross: p.record.gross,
            fee: p.record.fee,
            net: p.record.net,
            reference: p.record.reference,
        })),
        skippedDuplicates: duplicates.slice(0, 100).map((r) => ({
            row: r.row,
            date: r.date,
            net: r.net,
            description: r.description,
            reference: r.reference,
        })),
    };
}

/* ------------------------------------------------------------------ */
/* Commit                                                               */
/* ------------------------------------------------------------------ */

export interface SettlementCommitResult {
    accountsCreated: number;
    transactionsCreated: number;
    splitsCreated: number;
    duplicatesSkipped: number;
    lockedSkipped: number;
    errorRows: number;
    warnings: string[];
    batchId: number;
    clearingAccountPath: string;
}

const CHUNK = 2000;

export async function commitSettlementImport(
    userId: number,
    source: SettlementSource,
    input: SettlementImportInput,
    ctx: SettlementBookContext
): Promise<SettlementCommitResult> {
    const { parsed, roles, warnings, lockDate, importable, duplicates, locked } =
        await prepareSettlementPlan(source, input, ctx);

    if (importable.length === 0) {
        const detail =
            parsed.errors[0]?.message ??
            (duplicates.length > 0
                ? 'every row was already imported (matching reference stamps found).'
                : locked.length > 0
                    ? `all rows fall on or before the period lock (${lockDate}).`
                    : undefined);
        throw new Error(`No importable transactions found in the upload${detail ? `: ${detail}` : '.'}`);
    }

    const currency = await resolveBookCurrency(ctx.rootGuid);
    if (!currency) throw new Error('No currency commodity available for this book.');

    const result: SettlementCommitResult = {
        accountsCreated: 0,
        transactionsCreated: 0,
        splitsCreated: 0,
        duplicatesSkipped: input.skipDuplicates !== false ? duplicates.length : 0,
        lockedSkipped: locked.length,
        errorRows: parsed.errors.length,
        warnings,
        batchId: 0,
        clearingAccountPath: roles.clearing.path,
    };

    const label = SETTLEMENT_SOURCE_LABELS[source];

    await prisma.$transaction(
        async (tx) => {
            // 1. Resolve/create the role accounts actually used
            const guidByRole = new Map<SettlementRole, string>();
            for (const role of ['income', 'fees', 'clearing', 'bank'] as const) {
                const res = roles[role];
                if (!res.used) continue;
                if (res.targetGuid) {
                    guidByRole.set(role, res.targetGuid);
                } else {
                    const { guid, created } = await createPlannedAccount(
                        tx,
                        { key: role, path: res.path, accountType: res.accountType, reason: 'category' },
                        ctx.rootGuid,
                        currency.guid
                    );
                    guidByRole.set(role, guid);
                    result.accountsCreated += created;
                }
            }

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

            for (const p of importable) {
                const txGuid = generateGuid();
                // Noon UTC, matching the QIF/QBO/personal importers.
                const postDate = new Date(`${p.record.date}T12:00:00Z`);
                const description =
                    p.record.description || `${label} ${p.record.kind.replace('_', ' ')}`;
                transactionRows.push({
                    guid: txGuid,
                    currency_guid: currency.guid,
                    num: (p.stamp ?? '').slice(0, 2048),
                    post_date: postDate,
                    enter_date: enterDate,
                    description: description.slice(0, 2048),
                });
                for (const split of p.splits) {
                    const { num, denom } = fromDecimal(split.amount, currency.fraction);
                    splitRows.push({
                        guid: generateGuid(),
                        tx_guid: txGuid,
                        account_guid: guidByRole.get(split.role)!,
                        memo: p.record.reference ? `${label} ref ${p.record.reference}` : '',
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
            source: `settlement_${source}`,
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
                statusSkipped: parsed.statusSkipped,
                accountsCreated: result.accountsCreated,
                skipDuplicates: input.skipDuplicates !== false,
                accounts: {
                    income: roles.income.path,
                    fees: roles.fees.path,
                    clearing: roles.clearing.path,
                    bank: roles.bank.path,
                },
            },
        },
    });
    result.batchId = batch.id;

    return result;
}

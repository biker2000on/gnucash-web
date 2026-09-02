/**
 * QuickBooks Online import service.
 *
 * previewQboImport() parses the upload — either the legacy Journal CSV
 * (+ optional Chart of Accounts CSV) or a QBO "Export data" ZIP / XLSX
 * workbook (auto-classified sheets; Journal preferred over General Ledger;
 * CoA merged automatically) — and returns a summary with resolved account
 * types. No writes.
 *
 * commitQboImport() rebuilds the QBO company as a brand-new book: book row +
 * ROOT + Template Root (mirroring src/lib/default-book.ts), the account tree
 * from the resolved account list, then chunked createMany for transactions
 * and splits. Afterwards it grants the importing user admin, saves the
 * entity profile, and records a gnucash_web_import_batches row with
 * source='quickbooks'.
 */

import prisma from '@/lib/prisma';
import { generateGuid, fromDecimal } from '@/lib/gnucash';
import { getCurrencyName } from '@/lib/currencies';
import { invalidateBookAccountGuidsCache } from '@/lib/book-scope';
import { grantRole } from '@/lib/services/permission.service';
import { saveEntityProfile, type EntityType } from '@/lib/services/entity.service';
import {
    splitCsvRows,
    parseQboJournalRows,
    parseQboCoaRows,
    resolveAccountTypes,
    round2,
    type QboCoaParseResult,
    type QboJournalParseResult,
    type QboParseError,
    type ResolvedAccount,
} from './qbo-journal';
import { parseQboGeneralLedgerRows, type QboGlStats } from './qbo-gl';
import { resolveImportLocale, type ImportLocale, type ImportLocaleId } from './parse-locale';
import {
    sheetsFromUpload,
    classifySheet,
    selectSourceSheets,
    MAX_SHEET_ROWS,
    type ClassifiedSheet,
    type SheetKind,
    type UploadSheet,
} from './qbo-workbook';
import { coaFromStatements, type StatementKind } from './qbo-statements';
import { buildScaffoldedTree, type AccountTree } from './qbo-tree';
import { MONEY_DISPLAY_EPSILON } from '@/lib/tolerances';
import {
    parseQboContactRows,
    planQboDocuments,
    summarizeDocumentPlan,
    type ContactKind,
    type DocumentPlan,
    type QboContact,
} from './qbo-business';
import { nextEntityId } from '@/lib/services/business.service';
import { OWNER_TYPE_CUSTOMER, OWNER_TYPE_VENDOR, SLOT_TIMESPEC } from '@/lib/business/invoice-engine';

/* ------------------------------------------------------------------ */
/* Preview                                                              */
/* ------------------------------------------------------------------ */

export type QboSourceFormat = 'journal' | 'general_ledger';

/** A raw uploaded .zip/.xlsx (the QBO "Export data" archive or a workbook). */
export interface QboArchiveUpload {
    filename: string;
    data: Uint8Array;
}

export interface QboSheetInfo {
    name: string;
    kind: SheetKind;
    /** Whether this sheet feeds the import (journal/GL source or CoA) */
    used: boolean;
}

export interface QboPreviewInput {
    /** Legacy path: Journal report CSV content */
    journalContent?: string | null;
    /** Legacy path: Chart of Accounts CSV content */
    coaContent?: string | null;
    /** New path: QBO Export-data ZIP or a single XLSX workbook */
    archive?: QboArchiveUpload | null;
    /** Chart of Accounts uploaded as an XLSX workbook */
    coaArchive?: QboArchiveUpload | null;
    /** Proposed book name (for the duplicate-import warning) */
    bookName?: string | null;
    /** Account path -> GnuCash type overrides from the UI */
    typeOverrides?: Record<string, string>;
    /** Number/date locale of the export ('us' default, 'eu' day-first) */
    locale?: ImportLocaleId | null;
}

export interface QboPreviewAccount extends ResolvedAccount {
    /** Number of journal lines posting to this account */
    lines: number;
    /** Full GnuCash path the account imports as (scaffold + chart nesting) */
    targetPath: string;
}

export interface QboTreePreview {
    /** Every account the import will create, parents before children */
    accounts: Array<{ path: string; accountType: string; placeholder: boolean; origin: 'scaffold' | 'coa' | 'journal' }>;
    /** Accounts taken from the chart (transacted on or not) */
    fromChart: number;
    /** Journal accounts missing from the chart and how they were placed */
    journalOnly: Array<{ path: string; placedAs: string; how: 'deleted-suffix' | 'parent' | 'type' }>;
}

export interface QboPreview {
    companyName: string | null;
    transactionCount: number;
    splitCount: number;
    errorCount: number;
    dateRange: { start: string; end: string } | null;
    accounts: QboPreviewAccount[];
    accountsByType: Record<string, number>;
    errors: QboParseError[];
    warnings: string[];
    coaLoaded: boolean;
    coaAccountCount: number;
    /** Where the account types came from when coaLoaded is true */
    coaSource: 'chart_of_accounts' | 'statements' | null;
    duplicateWarning: string | null;
    /** Where the transactions came from */
    sourceFormat: QboSourceFormat;
    /** GL reconstruction stats (null for the journal path) */
    glStats: QboGlStats | null;
    /** Sheets found in the archive and which were used (null for CSV path) */
    sheets: QboSheetInfo[] | null;
    /** The GnuCash account tree the import will create */
    tree: QboTreePreview;
    /** Contacts and invoices/bills/payments the import will create */
    business: QboBusinessPreview;
    sampleTransactions: Array<{
        date: string;
        description: string;
        amount: number;
        lines: number;
    }>;
}

/** Journal-shaped result carrying only a fatal error. */
function fatalJournalResult(message: string): QboJournalParseResult {
    return {
        transactions: [],
        accountsSeen: [],
        errors: [{ row: 1, message }],
        warnings: [],
        dateRange: null,
        companyName: null,
        rowsRead: 0,
    };
}

interface ParsedSource {
    journal: QboJournalParseResult;
    sourceFormat: QboSourceFormat;
    glStats: QboGlStats | null;
    sheets: QboSheetInfo[] | null;
    /** CoA parsed from a sheet inside the archive, if any */
    coaFromArchive: QboCoaParseResult | null;
    /** Customer / Vendor / Employee contact-list sheets inside the archive */
    contactSheets: ClassifiedSheet[];
}

export type QboContacts = Record<ContactKind, QboContact[]>;

export interface QboBusinessPreview {
    customers: number;
    vendors: number;
    employees: number;
    invoices: number;
    creditNotes: number;
    bills: number;
    customerPayments: number;
    billPayments: number;
    paidInFull: number;
    partiallyPaid: number;
    unallocatedPayments: number;
    unallocatedAmount: number;
    skipped: number;
    /** First few document-like transactions that could not be imported as documents */
    skippedSamples: Array<{ type: string; name: string; date: string; reason: string }>;
}

/**
 * Turn the upload (Export-data ZIP / XLSX archive, or legacy Journal CSV)
 * into a Journal-shaped parse result. A GL sheet is only used when no
 * Journal sheet exists; the CoA sheet is merged automatically.
 */
function parseSource(input: QboPreviewInput, locale: ImportLocale): ParsedSource {
    if (input.archive) {
        let uploadSheets: UploadSheet[];
        try {
            uploadSheets = sheetsFromUpload(input.archive.filename, input.archive.data);
        } catch (e) {
            const message = e instanceof Error ? e.message : 'Could not read the uploaded archive.';
            return {
                journal: fatalJournalResult(message),
                sourceFormat: 'journal',
                glStats: null,
                sheets: null,
                coaFromArchive: null,
                contactSheets: [],
            };
        }

        const classified: ClassifiedSheet[] = uploadSheets.map((s) => ({ ...s, kind: classifySheet(s.rows) }));
        const { source: sourceSheet, coa: coaSheet, statements, contacts } = selectSourceSheets(classified);
        const journalSheet = sourceSheet?.kind === 'journal' ? sourceSheet : null;
        const glSheet = sourceSheet?.kind === 'general_ledger' ? sourceSheet : null;

        // Account typing: an explicit Chart of Accounts sheet wins; otherwise
        // the Balance Sheet + Profit and Loss reports in the "Export data"
        // ZIP place every account under its QBO type section.
        let coaFromArchive: QboCoaParseResult | null = null;
        let typingSheets: ClassifiedSheet[] = [];
        if (coaSheet) {
            coaFromArchive = parseQboCoaRows(coaSheet.rows);
            typingSheets = [coaSheet];
        } else if (statements.length > 0) {
            coaFromArchive = coaFromStatements(
                statements.map((s) => ({ rows: s.rows, kind: s.kind as StatementKind }))
            );
            if (coaFromArchive) typingSheets = statements;
        }

        const sheets: QboSheetInfo[] = classified.map((s) => ({
            name: s.name,
            kind: s.kind,
            used: s === sourceSheet || typingSheets.includes(s) || contacts.includes(s),
        }));

        if (!sourceSheet) {
            const found = classified.length
                ? ` Sheets found: ${classified.map((s) => `"${s.name}"`).join(', ')}.`
                : ' The archive contained no readable sheets.';
            return {
                journal: fatalJournalResult(
                    `No Journal or General Ledger sheet found in "${input.archive.filename}".${found} ` +
                        'Use the QuickBooks "Export data" ZIP, or export the Journal report as CSV.'
                ),
                sourceFormat: 'journal',
                glStats: null,
                sheets,
                coaFromArchive,
                contactSheets: contacts,
            };
        }
        if (sourceSheet.rows.length > MAX_SHEET_ROWS) {
            return {
                journal: fatalJournalResult(
                    `The sheet "${sourceSheet.name}" has too many rows (${MAX_SHEET_ROWS.toLocaleString()} max). ` +
                        'Split the export into smaller date ranges.'
                ),
                sourceFormat: journalSheet ? 'journal' : 'general_ledger',
                glStats: null,
                sheets,
                coaFromArchive,
                contactSheets: contacts,
            };
        }

        if (journalSheet) {
            return {
                journal: parseQboJournalRows(journalSheet.rows, locale),
                sourceFormat: 'journal',
                glStats: null,
                sheets,
                coaFromArchive,
                contactSheets: contacts,
            };
        }
        const gl = parseQboGeneralLedgerRows(glSheet!.rows, locale);
        return {
            journal: gl,
            sourceFormat: 'general_ledger',
            glStats: gl.glStats,
            sheets,
            coaFromArchive,
            contactSheets: contacts,
        };
    }

    // Legacy CSV path. Classify the content so a General Ledger CSV pasted
    // into the Journal slot still works.
    if (!input.journalContent?.trim()) {
        return {
            journal: fatalJournalResult(
                'A Journal report CSV or a QuickBooks "Export data" ZIP is required.'
            ),
            sourceFormat: 'journal',
            glStats: null,
            sheets: null,
            coaFromArchive: null,
            contactSheets: [],
        };
    }
    const rows = splitCsvRows(input.journalContent);
    if (classifySheet(rows) === 'general_ledger') {
        const gl = parseQboGeneralLedgerRows(rows, locale);
        return { journal: gl, sourceFormat: 'general_ledger', glStats: gl.glStats, sheets: null, coaFromArchive: null, contactSheets: [] };
    }
    return {
        journal: parseQboJournalRows(rows, locale),
        sourceFormat: 'journal',
        glStats: null,
        sheets: null,
        coaFromArchive: null,
        contactSheets: [],
    };
}

function parseCoa(input: QboPreviewInput, coaFromArchive: QboCoaParseResult | null): QboCoaParseResult | null {
    // Explicit CSV upload wins, then an uploaded CoA workbook, then a CoA
    // sheet discovered inside the main archive.
    if (input.coaContent?.trim()) return parseQboCoaRows(splitCsvRows(input.coaContent));
    if (input.coaArchive) {
        try {
            const sheets = sheetsFromUpload(input.coaArchive.filename, input.coaArchive.data);
            const coaSheet =
                sheets.find((s) => classifySheet(s.rows) === 'chart_of_accounts') ?? sheets[0] ?? null;
            if (coaSheet) return parseQboCoaRows(coaSheet.rows);
        } catch {
            return {
                accounts: [],
                warnings: [],
                errors: [{ row: 1, message: `Could not read the Chart of Accounts file "${input.coaArchive.filename}"; it was ignored.` }],
            };
        }
    }
    return coaFromArchive;
}

function parseInputs(input: QboPreviewInput): {
    journal: QboJournalParseResult;
    coa: QboCoaParseResult | null;
    resolved: QboPreviewAccount[];
    warnings: string[];
    errors: QboParseError[];
    sourceFormat: QboSourceFormat;
    glStats: QboGlStats | null;
    sheets: QboSheetInfo[] | null;
    tree: AccountTree;
    contacts: QboContacts;
    plan: DocumentPlan;
    business: QboBusinessPreview;
} {
    const locale = resolveImportLocale(input.locale);
    const { journal, sourceFormat, glStats, sheets, coaFromArchive, contactSheets } = parseSource(input, locale);
    const coa = parseCoa(input, coaFromArchive);

    const warnings = [...journal.warnings];
    const errors = [...journal.errors];
    if (coa) {
        if (coa.derivedFrom === 'statements' && coa.accounts.length > 0) {
            warnings.push(
                'No Chart of Accounts in the export — account types were taken from the ' +
                'Balance Sheet and Profit and Loss reports instead (each account sits under ' +
                'its QuickBooks type section there).'
            );
        }
        warnings.push(...coa.warnings);
        // CoA problems are non-fatal: surface them as warnings.
        warnings.push(...coa.errors.map((e) => e.message));
    } else if (journal.accountsSeen.length > 0) {
        warnings.push(
            'No Chart of Accounts found — account types are inferred from names ' +
            'and default to ASSET/EXPENSE buckets. Review the account list below.'
        );
    }
    if (sourceFormat === 'general_ledger' && glStats && glStats.failed > 0) {
        warnings.push(
            `${glStats.failed} transaction group${glStats.failed === 1 ? '' : 's'} could not be reconstructed ` +
            'from the General Ledger. The Journal report (Reports → Journal → Export to CSV) is more reliable.'
        );
    }

    const lineCounts = new Map<string, number>();
    for (const t of journal.transactions) {
        for (const l of t.lines) {
            lineCounts.set(l.accountPath, (lineCounts.get(l.accountPath) ?? 0) + 1);
        }
    }

    const effectiveCoa = coa && coa.accounts.length > 0 ? coa : null;
    const resolvedTypes = resolveAccountTypes(
        journal.accountsSeen,
        effectiveCoa,
        input.typeOverrides ?? {}
    );

    // Scaffolded GnuCash tree: Assets/Liabilities/Equity/Income/Expenses on
    // top, QBO type groups beneath, every chart account nested under its
    // group, journal-only accounts slotted in by their resolved type.
    const tree = buildScaffoldedTree(resolvedTypes, effectiveCoa);
    const nodeByGuid = new Map(tree.nodes.map((n) => [n.guid, n]));
    const resolved: QboPreviewAccount[] = resolvedTypes.map((r) => {
        const node = nodeByGuid.get(tree.guidByJournalPath.get(r.path) ?? '');
        return {
            ...r,
            // The tree coerces types from the parent group (a deleted leaf under
            // an Expenses parent is an EXPENSE even if its name inferred nothing).
            gnucashType: r.source === 'override' ? r.gnucashType : node?.accountType ?? r.gnucashType,
            lines: lineCounts.get(r.path) ?? 0,
            targetPath: node?.path ?? r.path,
        };
    });
    if (effectiveCoa && tree.unmatched.length > 0) {
        const shown = tree.unmatched.slice(0, 8).map((u) => `"${u.path}" → ${u.placedAs}`);
        const more = tree.unmatched.length > 8 ? `, and ${tree.unmatched.length - 8} more` : '';
        warnings.push(
            `${tree.unmatched.length} journal account${tree.unmatched.length === 1 ? ' is' : 's are'} not in the Chart of Accounts ` +
            `(QuickBooks exports deleted accounts this way); placed by name and type: ${shown.join('; ')}${more}.`
        );
    }

    // Business records: contact lists from the archive, then invoices / bills
    // / payments planned from the journal's QBO transaction types.
    const contacts: QboContacts = { customers: [], vendors: [], employees: [] };
    for (const sheet of contactSheets) {
        const parsed = parseQboContactRows(sheet.rows);
        if (parsed) contacts[parsed.kind].push(...parsed.contacts);
    }
    const accountTypeByPath = new Map<string, string>();
    for (const r of resolved) accountTypeByPath.set(r.path, r.gnucashType);
    const plan = planQboDocuments({
        transactions: journal.transactions,
        accountTypeByPath,
        customerNames: contacts.customers.map((c) => c.name),
        vendorNames: contacts.vendors.map((v) => v.name),
    });
    const business: QboBusinessPreview = {
        customers: contacts.customers.length,
        vendors: contacts.vendors.length,
        employees: contacts.employees.length,
        ...summarizeDocumentPlan(plan),
        skippedSamples: plan.skipped.slice(0, 10).map(({ type, name, date, reason }) => ({ type, name, date, reason })),
    };
    if (plan.skipped.length > 0) {
        const byReason = new Map<string, number>();
        for (const s of plan.skipped) byReason.set(s.reason, (byReason.get(s.reason) ?? 0) + 1);
        warnings.push(
            `${plan.skipped.length} invoice/bill/payment transaction${plan.skipped.length === 1 ? '' : 's'} ` +
            'stay plain ledger transactions (no invoice record): ' +
            Array.from(byReason.entries()).map(([r, n]) => `${n} × ${r}`).join('; ') + '.'
        );
    }
    if (business.unallocatedPayments > 0) {
        warnings.push(
            `${business.unallocatedPayments} payment${business.unallocatedPayments === 1 ? '' : 's'} ` +
            `(${business.unallocatedAmount.toFixed(2)} total) exceed the owner's open invoices/bills at that date; ` +
            'the excess is left as an unapplied A/R–A/P split.'
        );
    }

    return { journal, coa, resolved, warnings, errors, sourceFormat, glStats, sheets, tree, contacts, plan, business };
}

export async function previewQboImport(input: QboPreviewInput): Promise<QboPreview> {
    const { journal, coa, resolved, warnings, errors, sourceFormat, glStats, sheets, tree, business } =
        parseInputs(input);

    const accountsByType: Record<string, number> = {};
    for (const a of resolved) {
        accountsByType[a.gnucashType] = (accountsByType[a.gnucashType] ?? 0) + 1;
    }

    // Duplicate warning: a prior 'quickbooks' batch already exists for a book
    // with the same (proposed) name.
    let duplicateWarning: string | null = null;
    const proposedName = (input.bookName ?? journal.companyName ?? '').trim();
    if (proposedName) {
        const existingBooks = await prisma.books.findMany({
            where: { name: { equals: proposedName, mode: 'insensitive' } },
            select: { guid: true, name: true },
        });
        if (existingBooks.length > 0) {
            const priorBatch = await prisma.gnucash_web_import_batches.findFirst({
                where: {
                    source: 'quickbooks',
                    book_guid: { in: existingBooks.map((b) => b.guid) },
                },
                select: { created_at: true },
            });
            duplicateWarning = priorBatch
                ? `A book named "${proposedName}" was already created by a QuickBooks import on ` +
                  `${priorBatch.created_at.toISOString().slice(0, 10)}. Importing again will create a second, separate book.`
                : `A book named "${proposedName}" already exists. Importing will create a second, separate book with the same name.`;
        }
    }

    return {
        companyName: journal.companyName,
        transactionCount: journal.transactions.length,
        splitCount: journal.transactions.reduce((s, t) => s + t.lines.length, 0),
        errorCount: errors.length,
        dateRange: journal.dateRange,
        accounts: resolved,
        accountsByType,
        errors: errors.slice(0, 200),
        warnings,
        coaLoaded: Boolean(coa && coa.accounts.length > 0),
        coaAccountCount: coa?.accounts.length ?? 0,
        coaSource:
            coa && coa.accounts.length > 0
                ? coa.derivedFrom === 'statements'
                    ? 'statements'
                    : 'chart_of_accounts'
                : null,
        duplicateWarning,
        sourceFormat,
        glStats,
        sheets,
        tree: {
            accounts: tree.nodes.map((n) => ({
                path: n.path,
                accountType: n.accountType,
                placeholder: n.placeholder,
                origin: n.origin,
            })),
            fromChart: tree.coaAccountCount,
            journalOnly: tree.unmatched,
        },
        business,
        sampleTransactions: journal.transactions.slice(0, 25).map((t) => ({
            date: t.date,
            description: t.name || t.memo || t.type || 'QuickBooks import',
            amount: t.lines.reduce((s, l) => s + Math.max(l.amount, 0), 0),
            lines: t.lines.length,
        })),
    };
}

/* ------------------------------------------------------------------ */
/* Commit                                                               */
/* ------------------------------------------------------------------ */

export interface QboCommitInput extends QboPreviewInput {
    bookName: string;
    currency?: string;
    entityType: EntityType;
    filename?: string | null;
}

export interface QboCommitResult {
    bookGuid: string;
    accountsCreated: number;
    transactionsCreated: number;
    splitsCreated: number;
    customersCreated: number;
    vendorsCreated: number;
    employeesCreated: number;
    invoicesCreated: number;
    billsCreated: number;
    /** Payment transactions whose A/R–A/P split was applied to invoice/bill lots */
    paymentsApplied: number;
    skippedErrors: number;
    warnings: string[];
}

const CHUNK = 2000;

export interface AccountNode {
    guid: string;
    name: string;
    path: string;
    parentPath: string | null;
    accountType: string;
    placeholder: boolean;
}

/**
 * Build the account tree rows for every path segment referenced by the
 * journal. Intermediate segments become placeholder parents unless they are
 * transacted on directly. Types: resolved type for journal accounts, CoA
 * type for known intermediates, else the first child's type.
 */
export function buildAccountNodes(
    resolved: ResolvedAccount[],
    coa: QboCoaParseResult | null
): AccountNode[] {
    const resolvedByPath = new Map(resolved.map((r) => [r.path, r]));
    const coaByPath = new Map(
        (coa?.accounts ?? []).map((a) => [a.fullName.toLowerCase(), a])
    );

    // Insertion order guarantees parents precede children.
    const nodes = new Map<string, AccountNode>();

    for (const r of resolved) {
        const segments = r.path.split(':').map((s) => s.trim()).filter((s) => s !== '');
        let pathSoFar = '';
        for (let i = 0; i < segments.length; i++) {
            const parentPath = pathSoFar || null;
            pathSoFar = pathSoFar ? `${pathSoFar}:${segments[i]}` : segments[i];
            const isLeaf = i === segments.length - 1;
            const existing = nodes.get(pathSoFar);
            if (existing) {
                if (isLeaf) {
                    // Previously created as an intermediate; it is transacted on too.
                    existing.placeholder = false;
                    existing.accountType = r.gnucashType;
                }
                continue;
            }

            let accountType: string;
            if (isLeaf) {
                accountType = r.gnucashType;
            } else {
                const direct = resolvedByPath.get(pathSoFar);
                const fromCoa = coaByPath.get(pathSoFar.toLowerCase());
                accountType =
                    direct?.gnucashType ?? fromCoa?.gnucashType ?? r.gnucashType;
            }

            nodes.set(pathSoFar, {
                guid: generateGuid(),
                name: segments[i],
                path: pathSoFar,
                parentPath,
                accountType,
                placeholder: !isLeaf && !resolvedByPath.has(pathSoFar),
            });
        }
    }

    return Array.from(nodes.values());
}

export async function commitQboImport(
    userId: number,
    input: QboCommitInput
): Promise<QboCommitResult> {
    const bookName = input.bookName.trim();
    if (!bookName) throw new Error('Book name is required');

    const { journal, coa, warnings, sourceFormat, glStats, tree, contacts, plan, business } = parseInputs(input);
    if (journal.transactions.length === 0) {
        const detail = journal.errors[0]?.message;
        throw new Error(
            `No importable transactions found in the upload${detail ? `: ${detail}` : '.'}`
        );
    }

    // Currency commodity lookup/create (mirrors default-book.ts)
    const mnemonic = (input.currency ?? 'USD').trim().toUpperCase() || 'USD';
    let currencyCommodity = await prisma.commodities.findFirst({
        where: { namespace: 'CURRENCY', mnemonic },
    });
    if (!currencyCommodity) {
        currencyCommodity = await prisma.commodities.create({
            data: {
                guid: generateGuid(),
                namespace: 'CURRENCY',
                mnemonic,
                fullname: getCurrencyName(mnemonic),
                cusip: '',
                fraction: 100,
                quote_flag: 1,
                quote_source: 'currency',
                quote_tz: '',
            },
        });
    }
    const currencyGuid = currencyCommodity.guid;
    const commodityScu = Number(currencyCommodity.fraction) || 100;

    // Scaffolded tree (see qbo-tree.ts); journal lines map through the
    // journal-path → guid table because their target path differs from the
    // QBO path ("Payroll Liabilities:401K" lives under Liabilities:Current
    // Liabilities).
    const accountNodes = tree.nodes;
    const guidByPath = tree.guidByJournalPath;
    const guidByTreePath = new Map(accountNodes.map((n) => [n.path, n.guid]));

    const bookGuid = generateGuid();
    const rootGuid = generateGuid();
    const templateRootGuid = generateGuid();

    const result: QboCommitResult = {
        bookGuid,
        accountsCreated: 0,
        transactionsCreated: 0,
        splitsCreated: 0,
        customersCreated: 0,
        vendorsCreated: 0,
        employeesCreated: 0,
        invoicesCreated: 0,
        billsCreated: 0,
        paymentsApplied: 0,
        skippedErrors: journal.errors.length,
        warnings,
    };

    await prisma.$transaction(
        async (tx) => {
            // 1. Root + template root + book row
            for (const [guid, name] of [
                [rootGuid, bookName],
                [templateRootGuid, 'Template Root'],
            ] as const) {
                await tx.accounts.create({
                    data: {
                        guid,
                        name,
                        account_type: 'ROOT',
                        commodity_guid: currencyGuid,
                        commodity_scu: commodityScu,
                        non_std_scu: 0,
                        parent_guid: null,
                        code: '',
                        description: '',
                        hidden: 0,
                        placeholder: 0,
                    },
                });
            }
            await tx.books.create({
                data: {
                    guid: bookGuid,
                    root_account_guid: rootGuid,
                    root_template_guid: templateRootGuid,
                    name: bookName,
                    description: `Imported from QuickBooks Online${journal.companyName ? ` (${journal.companyName})` : ''}`,
                },
            });

            // 2. Account tree (parents precede children in accountNodes)
            const accountRows = accountNodes.map((n) => ({
                guid: n.guid,
                name: n.name,
                account_type: n.accountType,
                commodity_guid: currencyGuid,
                commodity_scu: commodityScu,
                non_std_scu: 0,
                parent_guid: n.parentPath ? guidByTreePath.get(n.parentPath)! : rootGuid,
                code: '',
                description: '',
                hidden: 0,
                placeholder: n.placeholder ? 1 : 0,
            }));
            for (let i = 0; i < accountRows.length; i += CHUNK) {
                await tx.accounts.createMany({ data: accountRows.slice(i, i + CHUNK) });
            }
            result.accountsCreated = accountRows.length;

            // 3. Transactions + splits (chunked createMany; txns before splits — FK)
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
                lot_guid: string | null;
            }> = [];

            // Business records (see qbo-business.ts). Documents post against
            // the journal transaction itself: its A/R–A/P split carries the
            // invoice lot; a payment's A/R–A/P split is divided across the
            // lots it settles. Everything is planned before any row exists.
            const txGuids = journal.transactions.map(() => generateGuid());
            const docByTx = new Map<number, (typeof plan.documents)[number] & { guid: string; lotGuid: string }>();
            const docLots = plan.documents.map((d) => ({ ...d, guid: generateGuid(), lotGuid: generateGuid() }));
            for (const d of docLots) docByTx.set(d.txIndex, d);
            const paymentsByTx = new Map<number, Array<(typeof plan.payments)[number]>>();
            for (const p of plan.payments) {
                const arr = paymentsByTx.get(p.txIndex) ?? [];
                arr.push(p);
                paymentsByTx.set(p.txIndex, arr);
            }
            const lotRows = docLots.map((d) => ({
                guid: d.lotGuid,
                account_guid: guidByPath.get(d.postAccountPath)!,
                is_closed: Math.abs(d.total - d.paid) <= MONEY_DISPLAY_EPSILON ? 1 : 0,
            }));

            const pushSplit = (
                txGuid: string,
                accountGuid: string,
                amount: number,
                memo: string,
                lotGuid: string | null
            ) => {
                const { num, denom } = fromDecimal(amount, commodityScu);
                splitRows.push({
                    guid: generateGuid(),
                    tx_guid: txGuid,
                    account_guid: accountGuid,
                    memo: memo.slice(0, 2048),
                    action: '',
                    reconcile_state: 'n',
                    reconcile_date: null,
                    value_num: num,
                    value_denom: denom,
                    quantity_num: num,
                    quantity_denom: denom,
                    lot_guid: lotGuid,
                });
            };

            journal.transactions.forEach((txn, txIndex) => {
                const txGuid = txGuids[txIndex];
                // Noon UTC, matching the QIF importer's post_date convention.
                const postDate = new Date(`${txn.date}T12:00:00Z`);
                const description =
                    txn.name || txn.memo || txn.type || 'QuickBooks import';
                const doc = docByTx.get(txIndex);
                transactionRows.push({
                    guid: txGuid,
                    currency_guid: currencyGuid,
                    num: doc ? doc.id : txn.num || '',
                    post_date: postDate,
                    enter_date: enterDate,
                    description: description.slice(0, 2048),
                });
                const paymentLines = new Map((paymentsByTx.get(txIndex) ?? []).map((p) => [p.lineIndex, p]));
                txn.lines.forEach((line, lineIndex) => {
                    const accountGuid = guidByPath.get(line.accountPath)!;
                    const memo = line.memo || '';
                    if (doc && lineIndex === doc.postLineIndex) {
                        pushSplit(txGuid, accountGuid, line.amount, memo, doc.lotGuid);
                        return;
                    }
                    const payment = paymentLines.get(lineIndex);
                    if (payment && (payment.allocations.length > 0 || payment.creditLinks.length > 0)) {
                        // Customer side: settling an invoice credits A/R (−) and
                        // consuming a credit note debits it (+); vendor side flips.
                        const settle = payment.kind === 'invoice' ? -1 : 1;
                        for (const link of payment.creditLinks) {
                            pushSplit(txGuid, accountGuid, -settle * link.amount, memo, docLots[link.creditDocIndex].lotGuid);
                            pushSplit(txGuid, accountGuid, settle * link.amount, memo, docLots[link.docIndex].lotGuid);
                        }
                        for (const alloc of payment.allocations) {
                            pushSplit(txGuid, accountGuid, settle * alloc.amount, memo, docLots[alloc.docIndex].lotGuid);
                        }
                        const rest = round2(Math.abs(line.amount) - payment.allocations.reduce((s, a) => s + a.amount, 0));
                        if (rest > MONEY_DISPLAY_EPSILON) {
                            pushSplit(txGuid, accountGuid, Math.sign(line.amount) * rest, memo, null);
                        }
                        return;
                    }
                    pushSplit(txGuid, accountGuid, line.amount, memo, null);
                });
            });

            // Lots before splits (FK), transactions before splits (FK).
            for (let i = 0; i < lotRows.length; i += CHUNK) {
                await tx.lots.createMany({ data: lotRows.slice(i, i + CHUNK) });
            }
            for (let i = 0; i < transactionRows.length; i += CHUNK) {
                await tx.transactions.createMany({ data: transactionRows.slice(i, i + CHUNK) });
            }
            for (let i = 0; i < splitRows.length; i += CHUNK) {
                await tx.splits.createMany({ data: splitRows.slice(i, i + CHUNK) });
            }
            result.transactionsCreated = transactionRows.length;
            result.splitsCreated = splitRows.length;

            // 4. Contacts. The native tables are shared across books, so ids
            //    continue the database-wide sequence; ownership rows scope them.
            const ownershipRows: Array<{ entity_type: string; entity_guid: string; book_guid: string }> = [];
            const customerGuidByName = new Map<string, string>();
            const vendorGuidByName = new Map<string, string>();
            const addr = (lines: string[]) => ({
                addr1: lines[0] ?? null,
                addr2: lines[1] ?? null,
                addr3: lines[2] ?? null,
                addr4: lines[3] ?? null,
            });

            if (contacts.customers.length > 0) {
                const existing = await tx.customers.findMany({ select: { id: true } });
                let nextId = parseInt(nextEntityId(existing.map((r) => r.id)), 10);
                const rows = contacts.customers.map((c) => {
                    const guid = generateGuid();
                    customerGuidByName.set(c.name.toLowerCase(), guid);
                    ownershipRows.push({ entity_type: 'customer', entity_guid: guid, book_guid: bookGuid });
                    const a = addr(c.address);
                    const s = addr(c.shipAddress);
                    return {
                        guid,
                        id: String(nextId++).padStart(6, '0'),
                        name: c.name.slice(0, 2048),
                        notes: '',
                        active: 1,
                        discount_num: 0n,
                        discount_denom: 10000n,
                        credit_num: 0n,
                        credit_denom: 100n,
                        currency: currencyGuid,
                        tax_override: 0,
                        tax_included: 0,
                        terms: null,
                        taxtable: null,
                        addr_name: c.contactName || null,
                        addr_addr1: a.addr1,
                        addr_addr2: a.addr2,
                        addr_addr3: a.addr3,
                        addr_addr4: a.addr4,
                        addr_phone: c.phone.slice(0, 128) || null,
                        addr_fax: null,
                        addr_email: c.email.slice(0, 256) || null,
                        shipaddr_name: c.contactName || null,
                        shipaddr_addr1: s.addr1,
                        shipaddr_addr2: s.addr2,
                        shipaddr_addr3: s.addr3,
                        shipaddr_addr4: s.addr4,
                        shipaddr_phone: null,
                        shipaddr_fax: null,
                        shipaddr_email: null,
                    };
                });
                for (let i = 0; i < rows.length; i += CHUNK) {
                    await tx.customers.createMany({ data: rows.slice(i, i + CHUNK) });
                }
                result.customersCreated = rows.length;
            }
            if (contacts.vendors.length > 0) {
                const existing = await tx.vendors.findMany({ select: { id: true } });
                let nextId = parseInt(nextEntityId(existing.map((r) => r.id)), 10);
                const rows = contacts.vendors.map((v) => {
                    const guid = generateGuid();
                    vendorGuidByName.set(v.name.toLowerCase(), guid);
                    ownershipRows.push({ entity_type: 'vendor', entity_guid: guid, book_guid: bookGuid });
                    const a = addr(v.address);
                    return {
                        guid,
                        id: String(nextId++).padStart(6, '0'),
                        name: v.name.slice(0, 2048),
                        notes: v.accountNumber ? `Account #: ${v.accountNumber}` : '',
                        currency: currencyGuid,
                        active: 1,
                        tax_override: 0,
                        addr_name: v.contactName || null,
                        addr_addr1: a.addr1,
                        addr_addr2: a.addr2,
                        addr_addr3: a.addr3,
                        addr_addr4: a.addr4,
                        addr_phone: v.phone.slice(0, 128) || null,
                        addr_fax: null,
                        addr_email: v.email.slice(0, 256) || null,
                        terms: null,
                        tax_inc: null,
                        tax_table: null,
                    };
                });
                for (let i = 0; i < rows.length; i += CHUNK) {
                    await tx.vendors.createMany({ data: rows.slice(i, i + CHUNK) });
                }
                result.vendorsCreated = rows.length;
            }
            if (contacts.employees.length > 0) {
                const existing = await tx.employees.findMany({ select: { id: true } });
                let nextId = parseInt(nextEntityId(existing.map((r) => r.id)), 10);
                const rows = contacts.employees.map((e) => {
                    const guid = generateGuid();
                    ownershipRows.push({ entity_type: 'employee', entity_guid: guid, book_guid: bookGuid });
                    const a = addr(e.address);
                    return {
                        guid,
                        id: String(nextId++).padStart(6, '0'),
                        username: e.name.slice(0, 2048),
                        language: '',
                        acl: '',
                        active: 1,
                        currency: currencyGuid,
                        ccard_guid: null,
                        workday_num: 0n,
                        workday_denom: 1n,
                        rate_num: 0n,
                        rate_denom: 1n,
                        addr_name: e.name.slice(0, 1024),
                        addr_addr1: a.addr1,
                        addr_addr2: a.addr2,
                        addr_addr3: a.addr3,
                        addr_addr4: a.addr4,
                        addr_phone: e.phone.slice(0, 128) || null,
                        addr_fax: null,
                        addr_email: e.email.slice(0, 256) || null,
                    };
                });
                for (let i = 0; i < rows.length; i += CHUNK) {
                    await tx.employees.createMany({ data: rows.slice(i, i + CHUNK) });
                }
                result.employeesCreated = rows.length;
            }

            // 5. Invoices / bills: rows, entries, and the GnuCash posting
            //    slots (gncInvoice frames on lot + txn, trans-txn-type,
            //    trans-date-due, trans-read-only, date-posted) so desktop
            //    GnuCash and the invoice engine both recognise the posting.
            const SLOT_STRING = 4;
            const SLOT_GUID = 5;
            const SLOT_FRAME = 9;
            const SLOT_GDATE = 10;
            const TXN_READONLY_REASON = 'Generated from an invoice. Try unposting the invoice.';
            const invoiceRows: Array<Record<string, unknown>> = [];
            const entryRows: Array<Record<string, unknown>> = [];
            const slotRows: Array<Record<string, unknown>> = [];
            const guidFrame = (objGuid: string, invoiceGuid: string) => {
                const frame = generateGuid();
                slotRows.push({ obj_guid: objGuid, name: 'gncInvoice', slot_type: SLOT_FRAME, guid_val: frame });
                slotRows.push({ obj_guid: frame, name: 'gncInvoice/invoice-guid', slot_type: SLOT_GUID, guid_val: invoiceGuid });
            };
            for (const d of docLots) {
                const ownerGuid =
                    d.kind === 'invoice'
                        ? customerGuidByName.get(d.ownerName.toLowerCase())
                        : vendorGuidByName.get(d.ownerName.toLowerCase());
                if (!ownerGuid) continue; // planner only emits documents for listed owners
                const txGuid = txGuids[d.txIndex];
                const postDate = new Date(`${d.date}T12:00:00Z`);
                const gdate = new Date(`${d.date}T00:00:00Z`);
                ownershipRows.push({ entity_type: 'invoice', entity_guid: d.guid, book_guid: bookGuid });
                invoiceRows.push({
                    guid: d.guid,
                    id: d.id.slice(0, 2048),
                    date_opened: postDate,
                    date_posted: postDate,
                    notes: d.notes.slice(0, 2048),
                    active: 1,
                    currency: currencyGuid,
                    owner_type: d.kind === 'invoice' ? OWNER_TYPE_CUSTOMER : OWNER_TYPE_VENDOR,
                    owner_guid: ownerGuid,
                    terms: null,
                    billing_id: '',
                    post_txn: txGuid,
                    post_lot: d.lotGuid,
                    post_acc: guidByPath.get(d.postAccountPath)!,
                    billto_type: null,
                    billto_guid: null,
                    charge_amt_num: 0n,
                    charge_amt_denom: 1n,
                });
                for (const e of d.entries) {
                    const price = fromDecimal(e.price, 1_000_000);
                    const common = {
                        guid: generateGuid(),
                        date: postDate,
                        date_entered: enterDate,
                        description: e.description.slice(0, 2048),
                        action: '',
                        notes: '',
                        quantity_num: 100n,
                        quantity_denom: 100n,
                    };
                    entryRows.push(
                        d.kind === 'invoice'
                            ? {
                                  ...common,
                                  invoice: d.guid,
                                  i_acct: guidByPath.get(e.accountPath)!,
                                  i_price_num: price.num,
                                  i_price_denom: price.denom,
                                  i_discount_num: 0n,
                                  i_discount_denom: 100n,
                                  i_disc_type: 'VALUE',
                                  i_disc_how: 'PRETAX',
                                  i_taxable: 0,
                                  i_taxincluded: 0,
                                  i_taxtable: null,
                              }
                            : {
                                  ...common,
                                  bill: d.guid,
                                  b_acct: guidByPath.get(e.accountPath)!,
                                  b_price_num: price.num,
                                  b_price_denom: price.denom,
                                  b_taxable: 0,
                                  b_taxincluded: 0,
                                  b_taxtable: null,
                                  b_paytype: 1,
                                  billable: 0,
                              }
                    );
                }
                guidFrame(d.lotGuid, d.guid);
                guidFrame(txGuid, d.guid);
                slotRows.push({ obj_guid: txGuid, name: 'trans-txn-type', slot_type: SLOT_STRING, string_val: 'I' });
                slotRows.push({ obj_guid: txGuid, name: 'trans-date-due', slot_type: SLOT_TIMESPEC, timespec_val: postDate });
                slotRows.push({ obj_guid: txGuid, name: 'trans-read-only', slot_type: SLOT_STRING, string_val: TXN_READONLY_REASON });
                slotRows.push({ obj_guid: txGuid, name: 'date-posted', slot_type: SLOT_GDATE, gdate_val: gdate });
            }
            const paymentTxs = new Set(plan.payments.filter((p) => p.allocations.length > 0 || p.creditLinks.length > 0).map((p) => p.txIndex));
            for (const txIndex of paymentTxs) {
                const txGuid = txGuids[txIndex];
                slotRows.push({ obj_guid: txGuid, name: 'trans-txn-type', slot_type: SLOT_STRING, string_val: 'P' });
                slotRows.push({
                    obj_guid: txGuid,
                    name: 'date-posted',
                    slot_type: SLOT_GDATE,
                    gdate_val: new Date(`${journal.transactions[txIndex].date}T00:00:00Z`),
                });
            }
            for (let i = 0; i < invoiceRows.length; i += CHUNK) {
                await tx.invoices.createMany({ data: invoiceRows.slice(i, i + CHUNK) as never });
            }
            for (let i = 0; i < entryRows.length; i += CHUNK) {
                await tx.entries.createMany({ data: entryRows.slice(i, i + CHUNK) as never });
            }
            for (let i = 0; i < slotRows.length; i += CHUNK) {
                await tx.slots.createMany({ data: slotRows.slice(i, i + CHUNK) as never });
            }
            for (let i = 0; i < ownershipRows.length; i += CHUNK) {
                await tx.gnucash_web_business_entity_ownership.createMany({ data: ownershipRows.slice(i, i + CHUNK) });
            }
            result.invoicesCreated = invoiceRows.filter((r) => r.owner_type === OWNER_TYPE_CUSTOMER).length;
            result.billsCreated = invoiceRows.length - result.invoicesCreated;
            result.paymentsApplied = paymentTxs.size;
        },
        { maxWait: 10_000, timeout: 300_000 }
    );

    // New accounts exist now — invalidate the book-scope cache.
    invalidateBookAccountGuidsCache();

    // 4. Grant the importing user admin on the new book
    await grantRole(userId, bookGuid, 'admin', userId);

    // 5. Entity profile (entityName = bookName). Household books get a
    //    default 'self' member, mirroring /api/books/default.
    await saveEntityProfile(bookGuid, {
        entityType: input.entityType,
        entityName: bookName,
        members:
            input.entityType === 'household'
                ? [{ role: 'self', coveredByEmployerPlan: true, sortOrder: 0 }]
                : [],
    });

    // 6. Import batch record
    await prisma.gnucash_web_import_batches.create({
        data: {
            book_guid: bookGuid,
            source: 'quickbooks',
            filename: input.filename ?? null,
            total_items: journal.transactions.length + journal.errors.length,
            matched_items: result.transactionsCreated,
            user_id: userId,
            status: 'completed',
            completed_at: new Date(),
            settings: {
                dateRange: journal.dateRange,
                errorCount: journal.errors.length,
                entityType: input.entityType,
                currency: mnemonic,
                coaLoaded: Boolean(coa && coa.accounts.length > 0),
                coaSource: coa && coa.accounts.length > 0 ? (coa.derivedFrom ?? 'chart_of_accounts') : null,
                sourceFormat,
                locale: input.locale ?? 'us',
                business: {
                    customers: business.customers,
                    vendors: business.vendors,
                    employees: business.employees,
                    invoices: business.invoices,
                    bills: business.bills,
                    paymentsApplied: result.paymentsApplied,
                    skippedDocuments: business.skipped,
                },
                ...(glStats ? { glStats } : {}),
            },
        },
    });

    return result;
}

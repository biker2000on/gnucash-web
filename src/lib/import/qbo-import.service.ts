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
    MAX_SHEET_ROWS,
    type SheetKind,
    type UploadSheet,
} from './qbo-workbook';

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
    duplicateWarning: string | null;
    /** Where the transactions came from */
    sourceFormat: QboSourceFormat;
    /** GL reconstruction stats (null for the journal path) */
    glStats: QboGlStats | null;
    /** Sheets found in the archive and which were used (null for CSV path) */
    sheets: QboSheetInfo[] | null;
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
            };
        }

        const classified = uploadSheets.map((s) => ({ ...s, kind: classifySheet(s.rows) }));
        const journalSheet = classified.find((s) => s.kind === 'journal');
        const glSheet = classified.find((s) => s.kind === 'general_ledger');
        const coaSheet = classified.find((s) => s.kind === 'chart_of_accounts');
        const sourceSheet = journalSheet ?? glSheet ?? null;
        const sheets: QboSheetInfo[] = classified.map((s) => ({
            name: s.name,
            kind: s.kind,
            used: s === sourceSheet || s === coaSheet,
        }));
        const coaFromArchive = coaSheet ? parseQboCoaRows(coaSheet.rows) : null;

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
            };
        }

        if (journalSheet) {
            return {
                journal: parseQboJournalRows(journalSheet.rows, locale),
                sourceFormat: 'journal',
                glStats: null,
                sheets,
                coaFromArchive,
            };
        }
        const gl = parseQboGeneralLedgerRows(glSheet!.rows, locale);
        return {
            journal: gl,
            sourceFormat: 'general_ledger',
            glStats: gl.glStats,
            sheets,
            coaFromArchive,
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
        };
    }
    const rows = splitCsvRows(input.journalContent);
    if (classifySheet(rows) === 'general_ledger') {
        const gl = parseQboGeneralLedgerRows(rows, locale);
        return { journal: gl, sourceFormat: 'general_ledger', glStats: gl.glStats, sheets: null, coaFromArchive: null };
    }
    return {
        journal: parseQboJournalRows(rows, locale),
        sourceFormat: 'journal',
        glStats: null,
        sheets: null,
        coaFromArchive: null,
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
} {
    const locale = resolveImportLocale(input.locale);
    const { journal, sourceFormat, glStats, sheets, coaFromArchive } = parseSource(input, locale);
    const coa = parseCoa(input, coaFromArchive);

    const warnings = [...journal.warnings];
    const errors = [...journal.errors];
    if (coa) {
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

    const resolved = resolveAccountTypes(
        journal.accountsSeen,
        coa && coa.accounts.length > 0 ? coa : null,
        input.typeOverrides ?? {}
    ).map((r) => ({ ...r, lines: lineCounts.get(r.path) ?? 0 }));

    return { journal, coa, resolved, warnings, errors, sourceFormat, glStats, sheets };
}

export async function previewQboImport(input: QboPreviewInput): Promise<QboPreview> {
    const { journal, coa, resolved, warnings, errors, sourceFormat, glStats, sheets } =
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
        duplicateWarning,
        sourceFormat,
        glStats,
        sheets,
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

    const { journal, coa, resolved, warnings, sourceFormat, glStats } = parseInputs(input);
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

    const accountNodes = buildAccountNodes(resolved, coa);
    const guidByPath = new Map(accountNodes.map((n) => [n.path, n.guid]));

    const bookGuid = generateGuid();
    const rootGuid = generateGuid();
    const templateRootGuid = generateGuid();

    const result: QboCommitResult = {
        bookGuid,
        accountsCreated: 0,
        transactionsCreated: 0,
        splitsCreated: 0,
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
                parent_guid: n.parentPath ? guidByPath.get(n.parentPath)! : rootGuid,
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
                lot_guid: null;
            }> = [];

            for (const txn of journal.transactions) {
                const txGuid = generateGuid();
                // Noon UTC, matching the QIF importer's post_date convention.
                const postDate = new Date(`${txn.date}T12:00:00Z`);
                const description =
                    txn.name || txn.memo || txn.type || 'QuickBooks import';
                transactionRows.push({
                    guid: txGuid,
                    currency_guid: currencyGuid,
                    num: txn.num || '',
                    post_date: postDate,
                    enter_date: enterDate,
                    description: description.slice(0, 2048),
                });
                for (const line of txn.lines) {
                    const { num, denom } = fromDecimal(line.amount, commodityScu);
                    splitRows.push({
                        guid: generateGuid(),
                        tx_guid: txGuid,
                        account_guid: guidByPath.get(line.accountPath)!,
                        memo: (line.memo || '').slice(0, 2048),
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
                sourceFormat,
                locale: input.locale ?? 'us',
                ...(glStats ? { glStats } : {}),
            },
        },
    });

    return result;
}

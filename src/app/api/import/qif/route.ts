import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import prisma from '@/lib/prisma';
import { toDecimalNumber } from '@/lib/gnucash';
import {
    getActiveBookRootGuid,
    getBookAccountGuids,
    invalidateBookAccountGuidsCache,
} from '@/lib/book-scope';
import { parseQif, type QifDateFormat } from '@/lib/qif/parser';
import {
    planQifImport,
    executeQifImport,
    type ExistingAccountInfo,
    type ExistingTransactionKey,
    type PlannedAccountRef,
    type QifImportPlan,
} from '@/lib/qif/importer';

const MAX_CONTENT_BYTES = 15 * 1024 * 1024; // 15 MB

interface QifImportRequest {
    content: string;
    dateFormat: QifDateFormat;
    dryRun: boolean;
    accountMappings: Record<string, string>;
    categoryMappings: Record<string, string>;
    newAccountParentGuid?: string;
    defaultCurrencyGuid?: string;
}

/** Read the request body from either multipart form data or JSON. */
async function readRequest(request: NextRequest): Promise<QifImportRequest | NextResponse> {
    const contentType = request.headers.get('content-type') ?? '';
    let content = '';
    let dateFormat: QifDateFormat = 'auto';
    let dryRun = true;
    let accountMappings: Record<string, string> = {};
    let categoryMappings: Record<string, string> = {};
    let newAccountParentGuid: string | undefined;
    let defaultCurrencyGuid: string | undefined;

    const parseJsonField = (raw: unknown): Record<string, string> => {
        if (!raw) return {};
        if (typeof raw === 'object') return raw as Record<string, string>;
        try {
            const parsed = JSON.parse(String(raw));
            return typeof parsed === 'object' && parsed !== null ? parsed : {};
        } catch {
            return {};
        }
    };

    if (contentType.includes('multipart/form-data')) {
        const formData = await request.formData();
        const file = formData.get('file');
        if (file instanceof File) {
            if (file.size > MAX_CONTENT_BYTES) {
                return NextResponse.json({ error: 'File too large (15 MB max)' }, { status: 413 });
            }
            content = await file.text();
        } else {
            content = String(formData.get('content') ?? '');
        }
        const df = String(formData.get('dateFormat') ?? 'auto');
        if (df === 'us' || df === 'eu' || df === 'auto') dateFormat = df;
        dryRun = String(formData.get('dryRun') ?? 'true') !== 'false';
        accountMappings = parseJsonField(formData.get('accountMappings'));
        categoryMappings = parseJsonField(formData.get('categoryMappings'));
        newAccountParentGuid = String(formData.get('newAccountParentGuid') ?? '') || undefined;
        defaultCurrencyGuid = String(formData.get('defaultCurrencyGuid') ?? '') || undefined;
    } else {
        let body: Record<string, unknown>;
        try {
            body = await request.json();
        } catch {
            return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
        }
        content = typeof body.content === 'string' ? body.content : '';
        const df = body.dateFormat;
        if (df === 'us' || df === 'eu' || df === 'auto') dateFormat = df;
        dryRun = body.dryRun !== false;
        accountMappings = parseJsonField(body.accountMappings);
        categoryMappings = parseJsonField(body.categoryMappings);
        newAccountParentGuid =
            typeof body.newAccountParentGuid === 'string' && body.newAccountParentGuid
                ? body.newAccountParentGuid
                : undefined;
        defaultCurrencyGuid =
            typeof body.defaultCurrencyGuid === 'string' && body.defaultCurrencyGuid
                ? body.defaultCurrencyGuid
                : undefined;
    }

    if (!content.trim()) {
        return NextResponse.json({ error: 'No QIF content provided' }, { status: 400 });
    }
    if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) {
        return NextResponse.json({ error: 'Content too large (15 MB max)' }, { status: 413 });
    }

    return { content, dateFormat, dryRun, accountMappings, categoryMappings, newAccountParentGuid, defaultCurrencyGuid };
}

/**
 * Load every account in the active book with its fullname (colon path
 * relative to — and excluding — the book root).
 */
async function loadBookAccounts(
    rootGuid: string,
    bookGuids: string[]
): Promise<ExistingAccountInfo[]> {
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
        const parentPath = row.parent_guid && row.parent_guid !== rootGuid ? fullnameOf(row.parent_guid) : '';
        const full = parentPath ? `${parentPath}:${row.name}` : row.name;
        fullnameCache.set(guid, full);
        return full;
    }

    return rows
        .filter((r) => r.guid !== rootGuid)
        .map((r) => ({
            guid: r.guid,
            name: r.name,
            fullname: fullnameOf(r.guid),
            accountType: r.account_type,
            placeholder: r.placeholder === 1,
        }));
}

/** Fetch existing transactions in the candidate target accounts for duplicate detection. */
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

/** Human-readable label for a planned account ref (used in the preview). */
function refLabel(ref: PlannedAccountRef, plan: QifImportPlan, accounts: ExistingAccountInfo[]): string {
    if (ref.kind === 'existing') {
        return accounts.find((a) => a.guid === ref.guid)?.fullname ?? ref.guid;
    }
    const created = plan.accountsToCreate.find((a) => a.key === ref.key);
    return created ? `${created.displayPath} (new)` : ref.key;
}

/**
 * POST /api/import/qif
 *
 * Import a QIF file into the active book (edit role).
 *
 * Body (JSON or multipart):
 *   content | file          — QIF text
 *   dateFormat              — 'auto' | 'us' | 'eu' (default 'auto')
 *   dryRun                  — true (default) returns the plan preview only
 *   accountMappings         — { [qifAccountName]: accountGuid } overrides
 *   categoryMappings        — { [qifCategory]: accountGuid } overrides
 *   newAccountParentGuid    — parent for created QIF accounts (default: book root)
 *   defaultCurrencyGuid     — commodity guid (default: book root's commodity)
 *
 * dryRun response: { dryRun, counts, accountMappings, categoryMappings,
 *                    accountsToCreate, sampleTransactions, skippedDuplicates, warnings }
 * import response: { success, accountsCreated, transactionsCreated, splitsCreated,
 *                    duplicatesSkipped, transferPairsDeduped, warnings }
 */
export async function POST(request: NextRequest) {
    try {
        const roleResult = await requireRole('edit');
        if (roleResult instanceof NextResponse) return roleResult;

        const parsedRequest = await readRequest(request);
        if (parsedRequest instanceof NextResponse) return parsedRequest;
        const {
            content,
            dateFormat,
            dryRun,
            accountMappings,
            categoryMappings,
            newAccountParentGuid,
            defaultCurrencyGuid,
        } = parsedRequest;

        const parsed = parseQif(content, { dateFormat });
        const totalTxns = parsed.accounts.reduce((sum, a) => sum + a.transactions.length, 0);
        if (totalTxns === 0) {
            return NextResponse.json(
                { error: 'No transactions found in the QIF file.', warnings: parsed.warnings },
                { status: 400 }
            );
        }

        const rootGuid = await getActiveBookRootGuid();
        const bookGuids = await getBookAccountGuids();
        const bookGuidSet = new Set(bookGuids);

        // Validate caller-supplied guids against the active book
        for (const [label, mapping] of [
            ['accountMappings', accountMappings],
            ['categoryMappings', categoryMappings],
        ] as const) {
            for (const guid of Object.values(mapping)) {
                if (guid && !bookGuidSet.has(guid)) {
                    return NextResponse.json(
                        { error: `${label} contains an account outside the active book` },
                        { status: 400 }
                    );
                }
            }
        }
        if (newAccountParentGuid && !bookGuidSet.has(newAccountParentGuid)) {
            return NextResponse.json(
                { error: 'newAccountParentGuid is not in the active book' },
                { status: 400 }
            );
        }

        // Resolve the currency: explicit > book root commodity > CURRENCY:USD
        let currencyGuid: string | null = null;
        let currencyMnemonic: string | undefined;
        if (defaultCurrencyGuid) {
            const commodity = await prisma.commodities.findUnique({
                where: { guid: defaultCurrencyGuid },
                select: { guid: true, mnemonic: true, namespace: true },
            });
            if (!commodity || commodity.namespace !== 'CURRENCY') {
                return NextResponse.json({ error: 'defaultCurrencyGuid is not a currency' }, { status: 400 });
            }
            currencyGuid = commodity.guid;
            currencyMnemonic = commodity.mnemonic;
        } else {
            const root = await prisma.accounts.findUnique({
                where: { guid: rootGuid },
                select: { commodity: { select: { guid: true, mnemonic: true, namespace: true } } },
            });
            if (root?.commodity && root.commodity.namespace === 'CURRENCY') {
                currencyGuid = root.commodity.guid;
                currencyMnemonic = root.commodity.mnemonic;
            } else {
                const usd = await prisma.commodities.findFirst({
                    where: { namespace: 'CURRENCY', mnemonic: 'USD' },
                    select: { guid: true, mnemonic: true },
                });
                if (usd) {
                    currencyGuid = usd.guid;
                    currencyMnemonic = usd.mnemonic;
                }
            }
        }
        if (!currencyGuid) {
            return NextResponse.json(
                { error: 'No currency available; pass defaultCurrencyGuid.' },
                { status: 400 }
            );
        }

        const accounts = await loadBookAccounts(rootGuid, bookGuids);
        const planOptions = {
            currencyGuid,
            currencyMnemonic,
            accountMappings,
            categoryMappings,
            newAccountParentGuid,
        };
        const baseContext = {
            bookRootGuid: rootGuid,
            bookAccountGuids: bookGuids,
            accounts,
            existingTransactions: [] as ExistingTransactionKey[],
        };

        // Phase 1: resolve targets (no duplicate data yet), then load the
        // existing transactions for those targets and re-plan with them.
        const prePlan = planQifImport(parsed, planOptions, baseContext);
        const targetGuids = prePlan.accountMappings
            .map((m) => m.guid)
            .filter((g): g is string => Boolean(g));
        const allDates = parsed.accounts.flatMap((a) => a.transactions.map((t) => t.date));
        const existingTransactions = await loadExistingTransactions(targetGuids, allDates);
        const plan = planQifImport(parsed, planOptions, { ...baseContext, existingTransactions });

        const warnings = [...parsed.warnings, ...plan.warnings];

        if (dryRun) {
            const sampleTransactions = plan.transactions.slice(0, 25).map((t) => ({
                date: t.date,
                description: t.description,
                amount: t.splits[0]?.amount ?? 0,
                source: refLabel(t.splits[0]?.account, plan, accounts),
                counterparts: t.splits.slice(1).map((s) => refLabel(s.account, plan, accounts)),
            }));
            return NextResponse.json({
                dryRun: true,
                counts: {
                    qifAccounts: parsed.accounts.length,
                    qifTransactions: totalTxns,
                    qifCategories: parsed.categories.length,
                    transactionsToCreate: plan.transactions.length,
                    splitsToCreate: plan.transactions.reduce((sum, t) => sum + t.splits.length, 0),
                    accountsToCreate: plan.accountsToCreate.length,
                    duplicatesSkipped: plan.skippedDuplicates.length,
                    transferPairsDeduped: plan.transferPairsDeduped,
                },
                accountMappings: plan.accountMappings,
                categoryMappings: plan.categoryMappings,
                accountsToCreate: plan.accountsToCreate.map((a) => ({
                    displayPath: a.displayPath,
                    accountType: a.accountType,
                    reason: a.reason,
                })),
                sampleTransactions,
                skippedDuplicates: plan.skippedDuplicates.slice(0, 100),
                warnings,
            });
        }

        const result = await executeQifImport(plan);
        invalidateBookAccountGuidsCache();

        return NextResponse.json({
            success: true,
            accountsCreated: result.accountsCreated,
            transactionsCreated: result.transactionsCreated,
            splitsCreated: result.splitsCreated,
            duplicatesSkipped: plan.skippedDuplicates.length,
            transferPairsDeduped: plan.transferPairsDeduped,
            warnings,
        });
    } catch (error) {
        console.error('QIF import failed:', error);
        const message = error instanceof Error ? error.message : 'QIF import failed';
        if (message === 'NO_BOOKS') {
            return NextResponse.json({ error: 'No books exist yet; create or import a book first.' }, { status: 400 });
        }
        return NextResponse.json({ error: 'QIF import failed' }, { status: 500 });
    }
}

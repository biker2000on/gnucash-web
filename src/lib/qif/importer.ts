/**
 * QIF Import Planner + Executor
 *
 * planQifImport() is pure (no database access): it resolves QIF accounts,
 * categories, and [transfers] against the active book's account tree and
 * produces a full import plan (accounts to create, balanced transactions,
 * skipped duplicates, deduplicated transfer pairs).
 *
 * executeQifImport() applies a plan inside a prisma.$transaction:
 * account creation via findOrCreateAccount, then chunked createMany for
 * transactions and splits with fromDecimal(amount, 100) fractions.
 *
 * Prisma is imported lazily inside executeQifImport so this module stays
 * importable in pure unit tests.
 */

import type { QifParseResult, QifTransactionRecord } from './parser';

/* ------------------------------------------------------------------ */
/* Types                                                                */
/* ------------------------------------------------------------------ */

export interface ExistingAccountInfo {
    guid: string;
    name: string;
    /** Colon path relative to the book root, e.g. "Expenses:Food:Dining" */
    fullname: string;
    accountType: string;
    placeholder?: boolean;
}

export interface ExistingTransactionKey {
    accountGuid: string;
    /** ISO date YYYY-MM-DD */
    date: string;
    /** Decimal split value in the account */
    amount: number;
    description: string;
}

export interface QifPlanOptions {
    /** Commodity guid used for created accounts and transaction currency */
    currencyGuid: string;
    /** Commodity mnemonic (e.g. "USD") — used to name the Imbalance account */
    currencyMnemonic?: string;
    /** QIF account name -> existing account guid override */
    accountMappings?: Record<string, string>;
    /** QIF category name -> existing account guid override */
    categoryMappings?: Record<string, string>;
    /** Parent under which newly created QIF accounts are placed (default: book root) */
    newAccountParentGuid?: string;
}

export interface QifPlanContext {
    bookRootGuid: string;
    /** All account guids belonging to the active book (membership validation) */
    bookAccountGuids: string[];
    accounts: ExistingAccountInfo[];
    /** Existing transactions in candidate target accounts, for duplicate detection */
    existingTransactions: ExistingTransactionKey[];
}

export type PlannedAccountRef =
    | { kind: 'existing'; guid: string }
    | { kind: 'new'; key: string };

export interface PlannedAccountCreate {
    key: string;
    /** Colon path relative to the anchor account */
    path: string;
    /** Guid of the account the path is anchored at (book root or chosen parent) */
    anchorGuid: string;
    /** Full path for display, including the anchor's own path when not root */
    displayPath: string;
    accountType: string;
    reason: 'account' | 'category' | 'transfer' | 'imbalance' | 'equity';
}

export interface PlannedSplit {
    account: PlannedAccountRef;
    memo: string;
    amount: number;
    reconcile: 'n' | 'c' | 'y';
}

export interface PlannedTransaction {
    date: string;
    description: string;
    num: string;
    splits: PlannedSplit[];
    /** QIF account the entry came from (for reporting) */
    sourceAccount: string;
}

export interface SkippedDuplicate {
    qifAccount: string;
    date: string;
    amount: number;
    description: string;
}

export interface QifAccountMapping {
    qifName: string;
    qifType: string;
    /** Resolved existing account guid, when mapped to an existing account */
    guid?: string;
    /** Display path of the target (existing fullname or to-be-created path) */
    path: string;
    isNew: boolean;
    transactions: number;
}

export interface QifCategoryMapping {
    category: string;
    guid?: string;
    path: string;
    isNew: boolean;
    uses: number;
}

export interface QifImportPlan {
    currencyGuid: string;
    accountsToCreate: PlannedAccountCreate[];
    transactions: PlannedTransaction[];
    skippedDuplicates: SkippedDuplicate[];
    transferPairsDeduped: number;
    accountMappings: QifAccountMapping[];
    categoryMappings: QifCategoryMapping[];
    warnings: string[];
}

export interface QifImportResult {
    accountsCreated: number;
    transactionsCreated: number;
    splitsCreated: number;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

const QIF_TYPE_TO_GNUCASH: Record<string, string> = {
    bank: 'BANK',
    cash: 'CASH',
    ccard: 'CREDIT',
    'oth a': 'ASSET',
    'oth l': 'LIABILITY',
};

const TARGET_ACCOUNT_TYPES = new Set(['BANK', 'CASH', 'CREDIT', 'ASSET', 'LIABILITY']);

export function qifTypeToAccountType(qifType: string): string {
    return QIF_TYPE_TO_GNUCASH[qifType.trim().toLowerCase()] ?? 'ASSET';
}

function norm(s: string): string {
    return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

function round2(n: number): number {
    return Math.round(n * 100) / 100;
}

function dupKey(accountGuid: string, date: string, amount: number, description: string): string {
    return `${accountGuid}|${date}|${round2(amount).toFixed(2)}|${norm(description)}`;
}

function transferPairKey(nameA: string, nameB: string, date: string, amount: number): string {
    const [lo, hi] = [norm(nameA), norm(nameB)].sort();
    return `${lo}|${hi}|${date}|${Math.abs(round2(amount)).toFixed(2)}`;
}

/* ------------------------------------------------------------------ */
/* Planner                                                              */
/* ------------------------------------------------------------------ */

export function planQifImport(
    parsed: QifParseResult,
    options: QifPlanOptions,
    context: QifPlanContext
): QifImportPlan {
    const warnings: string[] = [];
    const bookGuidSet = new Set(context.bookAccountGuids);
    const anchorGuid =
        options.newAccountParentGuid && bookGuidSet.has(options.newAccountParentGuid)
            ? options.newAccountParentGuid
            : context.bookRootGuid;
    if (options.newAccountParentGuid && anchorGuid !== options.newAccountParentGuid) {
        warnings.push('Requested parent account is not in the active book; new accounts will be created under the book root.');
    }

    // Lookup structures for existing accounts
    const byGuid = new Map<string, ExistingAccountInfo>();
    const byFullname = new Map<string, ExistingAccountInfo>();
    const byLeaf = new Map<string, ExistingAccountInfo[]>();
    for (const a of context.accounts) {
        if (!bookGuidSet.has(a.guid)) continue;
        if (a.accountType === 'ROOT') continue;
        byGuid.set(a.guid, a);
        if (!byFullname.has(norm(a.fullname))) byFullname.set(norm(a.fullname), a);
        const leafKey = norm(a.name);
        const arr = byLeaf.get(leafKey);
        if (arr) arr.push(a);
        else byLeaf.set(leafKey, [a]);
    }
    const anchorInfo = byGuid.get(anchorGuid);
    const anchorPrefix = anchorGuid === context.bookRootGuid ? '' : anchorInfo ? `${anchorInfo.fullname}:` : '';

    // Category income/expense hints from the !Type:Cat list
    const categoryIncomeHint = new Map<string, boolean>();
    for (const c of parsed.categories) categoryIncomeHint.set(norm(c.name), c.isIncome);

    const accountsToCreate = new Map<string, PlannedAccountCreate>();

    function planCreate(
        key: string,
        path: string,
        anchor: string,
        accountType: string,
        reason: PlannedAccountCreate['reason']
    ): PlannedAccountRef {
        if (!accountsToCreate.has(key)) {
            const prefix = anchor === context.bookRootGuid ? '' : anchorPrefix;
            accountsToCreate.set(key, {
                key,
                path,
                anchorGuid: anchor,
                displayPath: `${prefix}${path}`,
                accountType,
                reason,
            });
        }
        return { kind: 'new', key };
    }

    /* ---------------- QIF account -> target account ---------------- */

    const qifAccountNames = new Set(parsed.accounts.map((a) => norm(a.name)).filter((n) => n !== ''));
    const accountRefByQifName = new Map<string, PlannedAccountRef>();
    const accountMappings: QifAccountMapping[] = [];

    function pickByLeaf(name: string, preferredType: string, allowedTypes: Set<string> | null): ExistingAccountInfo | null {
        const candidates = (byLeaf.get(norm(name)) ?? []).filter(
            (a) => !allowedTypes || allowedTypes.has(a.accountType)
        );
        if (candidates.length === 0) return null;
        const nonPlaceholder = candidates.filter((a) => !a.placeholder);
        const pool = nonPlaceholder.length > 0 ? nonPlaceholder : candidates;
        return pool.find((a) => a.accountType === preferredType) ?? pool[0];
    }

    for (const qifAccount of parsed.accounts) {
        const gnucashType = qifTypeToAccountType(qifAccount.type);
        const displayName = qifAccount.name || 'QIF Import';
        let ref: PlannedAccountRef | null = null;
        let mappedPath = '';

        const override = options.accountMappings?.[qifAccount.name];
        if (override) {
            if (bookGuidSet.has(override) && byGuid.has(override)) {
                ref = { kind: 'existing', guid: override };
                mappedPath = byGuid.get(override)!.fullname;
            } else {
                warnings.push(`Account mapping for "${displayName}" points outside the active book; ignored.`);
            }
        }

        if (!ref && qifAccount.name) {
            const exact = byFullname.get(norm(qifAccount.name));
            const match =
                (exact && !exact.placeholder ? exact : null) ??
                pickByLeaf(qifAccount.name, gnucashType, TARGET_ACCOUNT_TYPES);
            if (match) {
                ref = { kind: 'existing', guid: match.guid };
                mappedPath = match.fullname;
                if (match.placeholder) {
                    warnings.push(`Account "${displayName}" matched placeholder account "${match.fullname}".`);
                }
            }
        }

        if (!ref) {
            const key = `acct:${norm(displayName)}`;
            ref = planCreate(key, displayName, anchorGuid, gnucashType, 'account');
            mappedPath = accountsToCreate.get(key)!.displayPath;
        }

        accountRefByQifName.set(norm(qifAccount.name), ref);
        accountMappings.push({
            qifName: qifAccount.name,
            qifType: qifAccount.type,
            guid: ref.kind === 'existing' ? ref.guid : undefined,
            path: mappedPath,
            isNew: ref.kind === 'new',
            transactions: qifAccount.transactions.length,
        });
    }

    /* ---------------- Category resolution ---------------- */

    const categoryRefCache = new Map<string, PlannedAccountRef>();
    const categoryUse = new Map<string, QifCategoryMapping>();

    function resolveCategory(category: string, amountSign: number): PlannedAccountRef {
        const hint = categoryIncomeHint.get(norm(category));
        const isIncome = hint ?? amountSign > 0;
        const cacheKey = `${isIncome ? 'I' : 'E'}:${norm(category)}`;
        const cached = categoryRefCache.get(cacheKey);
        if (cached) {
            const use = categoryUse.get(cacheKey);
            if (use) use.uses++;
            return cached;
        }

        let ref: PlannedAccountRef | null = null;
        let path = '';

        const override = options.categoryMappings?.[category];
        if (override) {
            if (bookGuidSet.has(override) && byGuid.has(override)) {
                ref = { kind: 'existing', guid: override };
                path = byGuid.get(override)!.fullname;
            } else {
                warnings.push(`Category mapping for "${category}" points outside the active book; ignored.`);
            }
        }

        if (!ref) {
            // 1. Exact fullname match ("Expenses:Food:Dining" === "Expenses:Food:Dining")
            const exact = byFullname.get(norm(category));
            // 2. Suffix match — a QIF "Food:Dining" matches "Expenses:Food:Dining"
            let suffix: ExistingAccountInfo | null = null;
            if (!exact) {
                const target = `:${norm(category)}`;
                const typeWanted = isIncome ? 'INCOME' : 'EXPENSE';
                const suffixMatches: ExistingAccountInfo[] = [];
                for (const [full, acct] of byFullname) {
                    if (full.endsWith(target) && !acct.placeholder) suffixMatches.push(acct);
                }
                suffix =
                    suffixMatches.find((a) => a.accountType === typeWanted) ??
                    suffixMatches.find((a) => a.accountType === 'INCOME' || a.accountType === 'EXPENSE') ??
                    null;
            }
            // 3. Leaf name match among income/expense accounts
            const leaf =
                exact || suffix || category.includes(':')
                    ? null
                    : pickByLeaf(category, isIncome ? 'INCOME' : 'EXPENSE', new Set(['INCOME', 'EXPENSE']));
            const match = (exact && !exact.placeholder ? exact : null) ?? suffix ?? leaf;
            if (match) {
                ref = { kind: 'existing', guid: match.guid };
                path = match.fullname;
            }
        }

        if (!ref) {
            const prefix = isIncome ? 'Income' : 'Expenses';
            const fullPath = `${prefix}:${category}`;
            const key = `cat:${cacheKey}`;
            ref = planCreate(key, fullPath, context.bookRootGuid, isIncome ? 'INCOME' : 'EXPENSE', 'category');
            path = fullPath;
        }

        categoryRefCache.set(cacheKey, ref);
        categoryUse.set(cacheKey, {
            category,
            guid: ref.kind === 'existing' ? ref.guid : undefined,
            path,
            isNew: ref.kind === 'new',
            uses: 1,
        });
        return ref;
    }

    /* ---------------- Transfer + special account resolution ---------------- */

    function resolveOpeningBalances(): PlannedAccountRef {
        const exact = byFullname.get(norm('Equity:Opening Balances'));
        if (exact) return { kind: 'existing', guid: exact.guid };
        const leaf = pickByLeaf('Opening Balances', 'EQUITY', new Set(['EQUITY']));
        if (leaf) return { kind: 'existing', guid: leaf.guid };
        return planCreate('equity:opening', 'Equity:Opening Balances', context.bookRootGuid, 'EQUITY', 'equity');
    }

    function resolveImbalance(): PlannedAccountRef {
        const mnemonic = options.currencyMnemonic;
        const names = mnemonic ? [`Imbalance-${mnemonic}`, 'Imbalance'] : ['Imbalance'];
        for (const name of names) {
            const exact = byFullname.get(norm(name)) ?? pickByLeaf(name, 'BANK', null);
            if (exact) return { kind: 'existing', guid: exact.guid };
        }
        return planCreate('imbalance', names[0], context.bookRootGuid, 'BANK', 'imbalance');
    }

    function resolveTransfer(targetName: string, sourceQifName: string): PlannedAccountRef {
        // Self-transfer ([Checking] inside Checking) — Quicken's opening balance idiom
        if (norm(targetName) === norm(sourceQifName)) {
            return resolveOpeningBalances();
        }
        // Another account in this QIF file
        const inFile = accountRefByQifName.get(norm(targetName));
        if (inFile) return inFile;
        // An existing GnuCash account (fullname first, then unique-ish leaf)
        const exact = byFullname.get(norm(targetName));
        if (exact) return { kind: 'existing', guid: exact.guid };
        const leaf = pickByLeaf(targetName, 'BANK', null);
        if (leaf) return { kind: 'existing', guid: leaf.guid };
        // Unknown — create it under the chosen parent
        warnings.push(`Transfer target "[${targetName}]" not found; a new ASSET account will be created.`);
        return planCreate(`xfer:${norm(targetName)}`, targetName, anchorGuid, 'ASSET', 'transfer');
    }

    /* ---------------- Duplicate detection ---------------- */

    const existingCounter = new Map<string, number>();
    for (const t of context.existingTransactions) {
        const key = dupKey(t.accountGuid, t.date, t.amount, t.description);
        existingCounter.set(key, (existingCounter.get(key) ?? 0) + 1);
    }

    /* ---------------- Build transactions ---------------- */

    const transactions: PlannedTransaction[] = [];
    const skippedDuplicates: SkippedDuplicate[] = [];
    let transferPairsDeduped = 0;
    // key -> counterpart splits awaiting their mirror entry from the OTHER
    // account (which is skipped, after donating its cleared flag).
    interface PendingMirror {
        sourceNorm: string;
        split: PlannedSplit;
    }
    const pendingMirrors = new Map<string, PendingMirror[]>();

    function registerMirror(key: string, sourceName: string, split: PlannedSplit) {
        const arr = pendingMirrors.get(key);
        const entry = { sourceNorm: norm(sourceName), split };
        if (arr) arr.push(entry);
        else pendingMirrors.set(key, [entry]);
    }

    /** Consume a pending mirror registered by a DIFFERENT account, if any. */
    function takeMirror(key: string, currentAccountName: string): PlannedSplit | null {
        const arr = pendingMirrors.get(key);
        if (!arr) return null;
        const idx = arr.findIndex((e) => e.sourceNorm !== norm(currentAccountName));
        if (idx < 0) return null;
        const [entry] = arr.splice(idx, 1);
        return entry.split;
    }

    function isInFileTransfer(txn: QifTransactionRecord, sourceName: string): boolean {
        return (
            txn.transfer !== null &&
            txn.splits.length === 0 &&
            norm(txn.transfer) !== norm(sourceName) &&
            qifAccountNames.has(norm(txn.transfer))
        );
    }

    for (const qifAccount of parsed.accounts) {
        const sourceRef = accountRefByQifName.get(norm(qifAccount.name))!;
        const sourceLabel = qifAccount.name || 'QIF Import';

        for (const txn of qifAccount.transactions) {
            const description = txn.payee || txn.memo || 'QIF import';

            // Duplicate detection: same date + amount + normalized description
            // already present in the (existing) target account.
            if (sourceRef.kind === 'existing') {
                const key = dupKey(sourceRef.guid, txn.date, txn.amount, description);
                const count = existingCounter.get(key) ?? 0;
                if (count > 0) {
                    existingCounter.set(key, count - 1);
                    skippedDuplicates.push({
                        qifAccount: sourceLabel,
                        date: txn.date,
                        amount: txn.amount,
                        description,
                    });
                    continue;
                }
            }

            // Transfer pair dedup: the mirrored entry in the other account's
            // list is skipped — one transaction per transfer pair.
            if (isInFileTransfer(txn, qifAccount.name)) {
                const key = transferPairKey(qifAccount.name, txn.transfer!, txn.date, txn.amount);
                const counterpartSplit = takeMirror(key, qifAccount.name);
                if (counterpartSplit) {
                    // This entry is the mirror of a transaction we already planned.
                    counterpartSplit.reconcile = txn.cleared;
                    if (txn.memo && !counterpartSplit.memo) counterpartSplit.memo = txn.memo;
                    transferPairsDeduped++;
                    continue;
                }
            }

            const targetSplit: PlannedSplit = {
                account: sourceRef,
                memo: txn.memo,
                amount: round2(txn.amount),
                reconcile: txn.cleared,
            };
            const counterparts: PlannedSplit[] = [];

            if (txn.splits.length > 0) {
                for (const s of txn.splits) {
                    let ref: PlannedAccountRef;
                    if (s.transfer) {
                        ref = resolveTransfer(s.transfer, qifAccount.name);
                        // Register split-level transfers between in-file accounts
                        // so the mirrored simple entry on the other side dedupes.
                        if (
                            norm(s.transfer) !== norm(qifAccount.name) &&
                            qifAccountNames.has(norm(s.transfer))
                        ) {
                            const counterpartSplit: PlannedSplit = {
                                account: ref,
                                memo: s.memo,
                                amount: round2(-s.amount),
                                reconcile: 'n',
                            };
                            counterparts.push(counterpartSplit);
                            const key = transferPairKey(qifAccount.name, s.transfer, txn.date, s.amount);
                            registerMirror(key, qifAccount.name, counterpartSplit);
                            continue;
                        }
                    } else if (s.category) {
                        ref = resolveCategory(s.category, s.amount > 0 ? 1 : -1);
                    } else {
                        ref = resolveImbalance();
                    }
                    counterparts.push({
                        account: ref,
                        memo: s.memo,
                        amount: round2(-s.amount),
                        reconcile: 'n',
                    });
                }
                // Balance check: counterparts must sum to -amount
                const counterpartSum = counterparts.reduce((sum, s) => sum + s.amount, 0);
                const gap = round2(-txn.amount - counterpartSum);
                if (Math.abs(gap) > 0.005) {
                    counterparts.push({
                        account: resolveImbalance(),
                        memo: 'QIF split imbalance',
                        amount: gap,
                        reconcile: 'n',
                    });
                    warnings.push(
                        `Splits for "${description}" (${txn.date}) did not balance; ${gap.toFixed(2)} posted to Imbalance.`
                    );
                }
            } else {
                let ref: PlannedAccountRef;
                if (txn.transfer) {
                    ref = resolveTransfer(txn.transfer, qifAccount.name);
                } else if (txn.category) {
                    ref = resolveCategory(txn.category, txn.amount > 0 ? 1 : -1);
                } else {
                    ref = resolveImbalance();
                }
                const counterpartSplit: PlannedSplit = {
                    account: ref,
                    memo: '',
                    amount: round2(-txn.amount),
                    reconcile: 'n',
                };
                counterparts.push(counterpartSplit);

                // Register in-file transfers so the mirror entry dedupes.
                if (isInFileTransfer(txn, qifAccount.name)) {
                    const key = transferPairKey(qifAccount.name, txn.transfer!, txn.date, txn.amount);
                    registerMirror(key, qifAccount.name, counterpartSplit);
                }
            }

            transactions.push({
                date: txn.date,
                description,
                num: txn.num,
                splits: [targetSplit, ...counterparts],
                sourceAccount: sourceLabel,
            });
        }
    }

    return {
        currencyGuid: options.currencyGuid,
        accountsToCreate: Array.from(accountsToCreate.values()),
        transactions,
        skippedDuplicates,
        transferPairsDeduped,
        accountMappings,
        categoryMappings: Array.from(categoryUse.values()),
        warnings,
    };
}

/* ------------------------------------------------------------------ */
/* Executor                                                             */
/* ------------------------------------------------------------------ */

const CHUNK = 2000;

/**
 * Create an account path via findOrCreateAccount, then fix the account_type
 * of any segments that were newly created (findOrCreateAccount defaults
 * them to INCOME).
 */
async function createPlannedAccount(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tx: any,
    planned: PlannedAccountCreate,
    currencyGuid: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findOrCreateAccount: (path: string, root: string, currency: string, tx?: any) => Promise<string>
): Promise<{ guid: string; created: number }> {
    const segments = planned.path.split(':');

    // Walk the existing chain to find which segments already exist.
    let parentGuid = planned.anchorGuid;
    let existingDepth = 0;
    for (const segment of segments) {
        const existing = await tx.accounts.findFirst({
            where: { name: segment, parent_guid: parentGuid },
            select: { guid: true },
        });
        if (!existing) break;
        parentGuid = existing.guid;
        existingDepth++;
    }

    const leafGuid = await findOrCreateAccount(planned.path, planned.anchorGuid, currencyGuid, tx);

    // Re-walk to collect the guids of newly created segments and set their type.
    if (existingDepth < segments.length) {
        let walkGuid = planned.anchorGuid;
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

export async function executeQifImport(plan: QifImportPlan): Promise<QifImportResult> {
    // Lazy imports keep this module DB-free for unit tests of the planner.
    const { default: prisma } = await import('@/lib/prisma');
    const { generateGuid, fromDecimal, findOrCreateAccount } = await import('@/lib/gnucash');

    const result: QifImportResult = {
        accountsCreated: 0,
        transactionsCreated: 0,
        splitsCreated: 0,
    };

    await prisma.$transaction(
        async (tx) => {
            // 1. Create accounts (few of them; sequential is fine)
            const newAccountGuids = new Map<string, string>();
            for (const planned of plan.accountsToCreate) {
                const { guid, created } = await createPlannedAccount(
                    tx,
                    planned,
                    plan.currencyGuid,
                    findOrCreateAccount
                );
                newAccountGuids.set(planned.key, guid);
                result.accountsCreated += created;
            }

            const resolveRef = (ref: PlannedAccountRef): string => {
                if (ref.kind === 'existing') return ref.guid;
                const guid = newAccountGuids.get(ref.key);
                if (!guid) throw new Error(`QIF import plan references unknown account key "${ref.key}"`);
                return guid;
            };

            // 2. Build rows, then chunked createMany (transactions before splits — FK)
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

            for (const txn of plan.transactions) {
                const txGuid = generateGuid();
                const postDate = new Date(`${txn.date}T12:00:00Z`);
                transactionRows.push({
                    guid: txGuid,
                    currency_guid: plan.currencyGuid,
                    num: txn.num || '',
                    post_date: postDate,
                    enter_date: enterDate,
                    description: txn.description,
                });
                for (const split of txn.splits) {
                    const { num, denom } = fromDecimal(split.amount, 100);
                    splitRows.push({
                        guid: generateGuid(),
                        tx_guid: txGuid,
                        account_guid: resolveRef(split.account),
                        memo: split.memo || '',
                        action: '',
                        reconcile_state: split.reconcile,
                        reconcile_date: split.reconcile === 'y' ? postDate : null,
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
        {
            maxWait: 10_000,
            timeout: 300_000,
        }
    );

    return result;
}

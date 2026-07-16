/**
 * Personal-finance import framework (pure — no database access).
 *
 * Mint, YNAB, and Monarch Money exports all reduce to the same shape: one
 * CSV row per transaction on a single source account, with a category. This
 * module defines that normalized record, shared header detection, target
 * account / category auto-suggestion against an EXISTING book's account
 * tree, duplicate detection, and the two-split import plan builder.
 *
 * Per-source row parsers live in ./mint.ts, ./ynab.ts, ./monarch.ts; the
 * database preview/commit lives in ./personal-import.service.ts.
 *
 * Sign convention: `amount` is from the SOURCE ACCOUNT's perspective —
 * positive = money into the account (deposit), negative = money out
 * (spending). The bank/credit split carries `amount`; the category split
 * carries `-amount`, so expenses debit the expense account (positive
 * EXPENSE split) per GnuCash convention.
 */

import { couldBeDayFirst } from './parse-locale';
import { normHeader } from './qbo-journal';

/* ------------------------------------------------------------------ */
/* Types                                                                */
/* ------------------------------------------------------------------ */

export type PersonalSource = 'mint' | 'ynab' | 'monarch';

export interface PersonalRecord {
    /** ISO YYYY-MM-DD */
    date: string;
    description: string;
    memo: string;
    /** Signed, account perspective: positive = money in, negative = money out */
    amount: number;
    /** Source category label ('' = uncategorized) */
    category: string;
    /** Source account name ('' when the export has none) */
    account: string;
    /** 1-based row number in the original file */
    row: number;
}

export interface PersonalParseError {
    row: number;
    message: string;
}

export interface PersonalParseResult {
    records: PersonalRecord[];
    errors: PersonalParseError[];
    warnings: string[];
    dateRange: { start: string; end: string } | null;
    /** Data rows examined (excludes header and blank rows) */
    rowsRead: number;
    /** Rows whose numeric date parses differently day-first vs month-first */
    ambiguousDateRows: number;
}

/** Existing account in the target book (relative colon path, like QIF). */
export interface BookAccount {
    guid: string;
    name: string;
    /** Colon path relative to the book root, e.g. "Assets:Chase Checking" */
    fullname: string;
    accountType: string;
    placeholder?: boolean;
}

export interface ExistingTransactionKey {
    accountGuid: string;
    /** ISO YYYY-MM-DD */
    date: string;
    /** Decimal split value in the account */
    amount: number;
    description: string;
}

/* ------------------------------------------------------------------ */
/* Header detection                                                     */
/* ------------------------------------------------------------------ */

export interface ColumnSpec {
    key: string;
    /** Acceptable normalized header names, in preference order */
    names: string[];
    required?: boolean;
}

export interface DetectedHeader {
    headerIdx: number;
    /** spec key -> column index (-1 when an optional column is absent) */
    cols: Record<string, number>;
}

export const MAX_HEADER_SCAN_ROWS = 25;

/**
 * Scan the first rows for a header matching the column specs. A row matches
 * when every REQUIRED spec resolves. Matching is tolerant: exact normalized
 * equality first, then substring containment (for names of 4+ characters,
 * so "amount" matches "amount (usd)").
 */
export function detectHeaderRow(
    rows: string[][],
    specs: ColumnSpec[],
    maxScan: number = MAX_HEADER_SCAN_ROWS
): DetectedHeader | null {
    for (let i = 0; i < Math.min(rows.length, maxScan); i++) {
        const norm = rows[i].map(normHeader);
        const cols: Record<string, number> = {};
        let ok = true;
        for (const spec of specs) {
            let idx = -1;
            for (const name of spec.names) {
                idx = norm.findIndex((c) => c === name);
                if (idx >= 0) break;
            }
            if (idx < 0) {
                for (const name of spec.names) {
                    if (name.length < 4) continue;
                    idx = norm.findIndex((c) => c !== '' && c.includes(name));
                    if (idx >= 0) break;
                }
            }
            cols[spec.key] = idx;
            if (idx < 0 && spec.required) {
                ok = false;
                break;
            }
        }
        if (ok) return { headerIdx: i, cols };
    }
    return null;
}

/** Safe cell accessor shared by the row parsers. */
export function cellAt(row: string[], idx: number): string {
    return idx >= 0 && idx < row.length ? row[idx] : '';
}

/** Compute dateRange + assemble the final parse result. */
export function finalizeParseResult(
    records: PersonalRecord[],
    errors: PersonalParseError[],
    warnings: string[],
    rowsRead: number,
    ambiguousDateRows: number
): PersonalParseResult {
    let dateRange: PersonalParseResult['dateRange'] = null;
    if (records.length > 0) {
        let start = records[0].date;
        let end = records[0].date;
        for (const r of records) {
            if (r.date < start) start = r.date;
            if (r.date > end) end = r.date;
        }
        dateRange = { start, end };
    }
    return { records, errors, warnings, dateRange, rowsRead, ambiguousDateRows };
}

/** True when the raw date string is day/month ambiguous (preview warning). */
export function isAmbiguousDate(raw: string): boolean {
    return couldBeDayFirst(raw);
}

/* ------------------------------------------------------------------ */
/* Normalization helpers                                                */
/* ------------------------------------------------------------------ */

function norm(s: string): string {
    return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

function round2(n: number): number {
    return Math.round(n * 100) / 100;
}

/** Lowercase, strip punctuation to spaces, collapse whitespace. */
export function normalizeDescription(s: string): string {
    return s
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .replace(/\s+/g, ' ');
}

/**
 * "Similar description" for duplicate detection: normalized equality, or one
 * side contains the other (banks truncate/decorate payee names). Containment
 * only counts when the shorter side has some substance (4+ characters), so
 * "a" does not match everything.
 */
export function isSimilarDescription(a: string, b: string): boolean {
    const na = normalizeDescription(a);
    const nb = normalizeDescription(b);
    if (na === nb) return true;
    const [short, long] = na.length <= nb.length ? [na, nb] : [nb, na];
    return short.length >= 4 && long.includes(short);
}

/** Label used for records with no category. */
export const UNCATEGORIZED = 'Uncategorized';

export function categoryLabel(category: string): string {
    return category.trim() === '' ? UNCATEGORIZED : category.trim();
}

/* ------------------------------------------------------------------ */
/* Target suggestion                                                    */
/* ------------------------------------------------------------------ */

/** Account types a source (bank-side) account may map onto. */
export const SOURCE_TARGET_TYPES = new Set(['BANK', 'CASH', 'CREDIT', 'ASSET', 'LIABILITY']);
/** Account types a category may map onto. */
export const CATEGORY_TARGET_TYPES = new Set(['INCOME', 'EXPENSE']);

function pickPreferred(candidates: BookAccount[], preferredTypes: string[]): BookAccount | null {
    if (candidates.length === 0) return null;
    const nonPlaceholder = candidates.filter((a) => !a.placeholder);
    const pool = nonPlaceholder.length > 0 ? nonPlaceholder : candidates;
    for (const t of preferredTypes) {
        const hit = pool.find((a) => a.accountType === t);
        if (hit) return hit;
    }
    return pool[0];
}

/**
 * Suggest an existing BANK/CREDIT-side account for a source account name.
 * Precedence: exact fullname → exact leaf name → unique substring match
 * (either direction), all restricted to SOURCE_TARGET_TYPES.
 */
export function suggestSourceAccount(
    sourceName: string,
    accounts: BookAccount[]
): BookAccount | null {
    const target = norm(sourceName);
    if (!target) return null;
    const eligible = accounts.filter((a) => SOURCE_TARGET_TYPES.has(a.accountType));

    const exactFull = eligible.filter((a) => norm(a.fullname) === target);
    if (exactFull.length > 0) return pickPreferred(exactFull, ['BANK', 'CREDIT', 'CASH']);

    const exactLeaf = eligible.filter((a) => norm(a.name) === target);
    if (exactLeaf.length > 0) return pickPreferred(exactLeaf, ['BANK', 'CREDIT', 'CASH']);

    // Unique containment either way: "Chase Checking (…1234)" ⊇ "Chase Checking".
    // The shorter name must carry at least half the longer one, so a generic
    // leaf like "Savings" does not claim "Ally Savings 9999".
    if (target.length >= 4) {
        const contains = eligible.filter((a) => {
            const leaf = norm(a.name);
            if (leaf.length < 4) return false;
            const [short, long] = leaf.length <= target.length ? [leaf, target] : [target, leaf];
            return long.includes(short) && short.length >= long.length / 2;
        });
        if (contains.length === 1) return contains[0];
    }
    return null;
}

/**
 * Suggest an existing income/expense account for a category label.
 * Precedence: exact fullname → path-suffix match ("Food:Dining" matches
 * "Expenses:Food:Dining") → exact leaf name (also for the "Group: Category"
 * form, matching the part after the last colon).
 */
export function suggestCategoryAccount(
    category: string,
    accounts: BookAccount[],
    preferIncome: boolean = false
): BookAccount | null {
    const label = categoryLabel(category);
    const target = norm(label.replace(/\s*:\s*/g, ':'));
    if (!target) return null;
    const eligible = accounts.filter((a) => CATEGORY_TARGET_TYPES.has(a.accountType));
    const preferred = preferIncome ? ['INCOME', 'EXPENSE'] : ['EXPENSE', 'INCOME'];

    const exactFull = eligible.filter((a) => norm(a.fullname.replace(/\s*:\s*/g, ':')) === target);
    if (exactFull.length > 0) return pickPreferred(exactFull, preferred);

    const suffix = eligible.filter((a) =>
        norm(a.fullname.replace(/\s*:\s*/g, ':')).endsWith(`:${target}`)
    );
    if (suffix.length > 0) return pickPreferred(suffix, preferred);

    const leafTarget = target.includes(':')
        ? target.slice(target.lastIndexOf(':') + 1)
        : target;
    const exactLeaf = eligible.filter((a) => norm(a.name) === leafTarget);
    if (exactLeaf.length > 0) return pickPreferred(exactLeaf, preferred);

    return null;
}

/**
 * Default GnuCash type for a source account created from scratch: credit
 * card-ish names become CREDIT, everything else BANK.
 */
export function defaultSourceAccountType(sourceName: string): 'BANK' | 'CREDIT' {
    const n = norm(sourceName);
    return /credit|card|visa|mastercard|amex|american express|discover/.test(n)
        ? 'CREDIT'
        : 'BANK';
}

/**
 * Path for a category account created from scratch. Default per spec is
 * Expenses:Imported:<Category>; when the category's records are majority
 * inflows it becomes Income:Imported:<Category> instead. "Group: Category"
 * labels nest ("Expenses:Imported:Group:Category").
 */
export function defaultCategoryPath(category: string, majorityInflow: boolean): {
    path: string;
    accountType: 'INCOME' | 'EXPENSE';
} {
    const label = categoryLabel(category);
    const segments = label
        .split(':')
        .map((s) => s.trim())
        .filter((s) => s !== '');
    const tail = segments.length > 0 ? segments.join(':') : UNCATEGORIZED;
    return majorityInflow
        ? { path: `Income:Imported:${tail}`, accountType: 'INCOME' }
        : { path: `Expenses:Imported:${tail}`, accountType: 'EXPENSE' };
}

/* ------------------------------------------------------------------ */
/* Plan                                                                 */
/* ------------------------------------------------------------------ */

export type PlannedAccountRef =
    | { kind: 'existing'; guid: string }
    | { kind: 'new'; key: string };

export interface PlannedAccountCreate {
    key: string;
    /** Colon path relative to the book root */
    path: string;
    accountType: string;
    reason: 'source' | 'category';
}

export interface PlannedPersonalTransaction {
    date: string;
    description: string;
    sourceAccount: string;
    category: string;
    row: number;
    splits: Array<{ account: PlannedAccountRef; memo: string; amount: number }>;
}

export interface SourceAccountResolution {
    /** Source account name as it appears in the file */
    name: string;
    records: number;
    target: PlannedAccountRef;
    /** Display path of the target (existing fullname or to-be-created path) */
    path: string;
    accountType: string;
    isNew: boolean;
    /** True when the target came from the caller's mapping (vs auto-suggest) */
    mapped: boolean;
}

export interface CategoryResolution {
    /** Category label (UNCATEGORIZED for blank) */
    name: string;
    records: number;
    /** Net signed total across the category's records */
    total: number;
    target: PlannedAccountRef;
    path: string;
    accountType: string;
    isNew: boolean;
    mapped: boolean;
}

export interface SkippedDuplicate {
    row: number;
    date: string;
    amount: number;
    description: string;
    account: string;
}

export interface PersonalPlanOptions {
    /**
     * Source account name -> target: an existing account guid, or
     * 'new:BANK' / 'new:CREDIT' to force creation. Unmapped names fall back
     * to auto-suggestion, then to a new account of the default type.
     */
    accountMappings?: Record<string, string>;
    /**
     * Category label -> target: an existing account guid, or 'new' to force
     * the default Imported path. Unmapped labels auto-suggest, then default.
     */
    categoryMappings?: Record<string, string>;
    /** Skip records already present in the target account (default true) */
    skipDuplicates?: boolean;
}

export interface PersonalImportPlan {
    accountsToCreate: PlannedAccountCreate[];
    transactions: PlannedPersonalTransaction[];
    duplicates: SkippedDuplicate[];
    sourceAccounts: SourceAccountResolution[];
    categories: CategoryResolution[];
    warnings: string[];
}

const NEW_MAPPING = /^new(?::(BANK|CREDIT))?$/;

/**
 * Resolve source accounts + categories and build two-split transactions.
 * Duplicate detection runs against `existing` (same target account + date +
 * amount + similar description, multiset semantics so N file copies only
 * skip against N existing copies).
 */
export function buildPersonalPlan(
    records: PersonalRecord[],
    accounts: BookAccount[],
    existing: ExistingTransactionKey[],
    options: PersonalPlanOptions = {}
): PersonalImportPlan {
    const warnings: string[] = [];
    const skipDuplicates = options.skipDuplicates !== false;
    const byGuid = new Map(accounts.map((a) => [a.guid, a]));

    /* ---------------- Source account resolution ---------------- */

    const recordsByAccount = new Map<string, PersonalRecord[]>();
    for (const r of records) {
        const key = r.account.trim() || '(no account)';
        const arr = recordsByAccount.get(key);
        if (arr) arr.push(r);
        else recordsByAccount.set(key, [r]);
    }

    const accountsToCreate = new Map<string, PlannedAccountCreate>();
    const sourceAccounts: SourceAccountResolution[] = [];
    const sourceRefByName = new Map<string, PlannedAccountRef>();

    const planCreate = (
        key: string,
        path: string,
        accountType: string,
        reason: PlannedAccountCreate['reason']
    ): PlannedAccountRef => {
        if (!accountsToCreate.has(key)) {
            accountsToCreate.set(key, { key, path, accountType, reason });
        }
        return { kind: 'new', key };
    };

    for (const [name, recs] of recordsByAccount) {
        const mapping = options.accountMappings?.[name];
        let target: PlannedAccountRef | null = null;
        let path = '';
        let accountType = '';
        let mapped = false;

        if (mapping) {
            const newMatch = mapping.match(NEW_MAPPING);
            if (newMatch) {
                const type = (newMatch[1] as 'BANK' | 'CREDIT') ?? defaultSourceAccountType(name);
                target = planCreate(`src:${norm(name)}`, name, type, 'source');
                path = name;
                accountType = type;
                mapped = true;
            } else if (byGuid.has(mapping) && SOURCE_TARGET_TYPES.has(byGuid.get(mapping)!.accountType)) {
                const acct = byGuid.get(mapping)!;
                target = { kind: 'existing', guid: acct.guid };
                path = acct.fullname;
                accountType = acct.accountType;
                mapped = true;
            } else {
                warnings.push(
                    `Account mapping for "${name}" is not a bank/credit-type account in this book; using auto-suggestion instead.`
                );
            }
        }

        if (!target) {
            const suggestion = suggestSourceAccount(name, accounts);
            if (suggestion) {
                target = { kind: 'existing', guid: suggestion.guid };
                path = suggestion.fullname;
                accountType = suggestion.accountType;
            } else {
                const type = defaultSourceAccountType(name);
                target = planCreate(`src:${norm(name)}`, name, type, 'source');
                path = name;
                accountType = type;
            }
        }

        sourceRefByName.set(name, target);
        sourceAccounts.push({
            name,
            records: recs.length,
            target,
            path,
            accountType,
            isNew: target.kind === 'new',
            mapped,
        });
    }

    /* ---------------- Category resolution ---------------- */

    const recordsByCategory = new Map<string, PersonalRecord[]>();
    for (const r of records) {
        const label = categoryLabel(r.category);
        const arr = recordsByCategory.get(label);
        if (arr) arr.push(r);
        else recordsByCategory.set(label, [r]);
    }

    const categories: CategoryResolution[] = [];
    const categoryRefByLabel = new Map<string, PlannedAccountRef>();

    for (const [label, recs] of recordsByCategory) {
        const total = round2(recs.reduce((s, r) => s + r.amount, 0));
        const inflows = recs.filter((r) => r.amount > 0).length;
        const majorityInflow = inflows * 2 > recs.length;

        const mapping = options.categoryMappings?.[label];
        let target: PlannedAccountRef | null = null;
        let path = '';
        let accountType = '';
        let mapped = false;

        if (mapping) {
            if (NEW_MAPPING.test(mapping)) {
                const def = defaultCategoryPath(label, majorityInflow);
                target = planCreate(`cat:${norm(label)}`, def.path, def.accountType, 'category');
                path = def.path;
                accountType = def.accountType;
                mapped = true;
            } else if (byGuid.has(mapping) && CATEGORY_TARGET_TYPES.has(byGuid.get(mapping)!.accountType)) {
                const acct = byGuid.get(mapping)!;
                target = { kind: 'existing', guid: acct.guid };
                path = acct.fullname;
                accountType = acct.accountType;
                mapped = true;
            } else {
                warnings.push(
                    `Category mapping for "${label}" is not an income/expense account in this book; using auto-suggestion instead.`
                );
            }
        }

        if (!target) {
            const suggestion = suggestCategoryAccount(label, accounts, majorityInflow);
            if (suggestion) {
                target = { kind: 'existing', guid: suggestion.guid };
                path = suggestion.fullname;
                accountType = suggestion.accountType;
            } else {
                const def = defaultCategoryPath(label, majorityInflow);
                target = planCreate(`cat:${norm(label)}`, def.path, def.accountType, 'category');
                path = def.path;
                accountType = def.accountType;
            }
        }

        categoryRefByLabel.set(label, target);
        categories.push({
            name: label,
            records: recs.length,
            total,
            target,
            path,
            accountType,
            isNew: target.kind === 'new',
            mapped,
        });
    }

    /* ---------------- Duplicate detection ---------------- */

    // Bucket existing transactions by account|date|amount; descriptions are a
    // consumable multiset so N identical file rows only skip N existing rows.
    const existingBuckets = new Map<string, string[]>();
    const bucketKey = (guid: string, date: string, amount: number) =>
        `${guid}|${date}|${round2(amount).toFixed(2)}`;
    for (const t of existing) {
        const key = bucketKey(t.accountGuid, t.date, t.amount);
        const arr = existingBuckets.get(key);
        if (arr) arr.push(t.description);
        else existingBuckets.set(key, [t.description]);
    }

    const isDuplicate = (record: PersonalRecord, targetGuid: string): boolean => {
        const bucket = existingBuckets.get(bucketKey(targetGuid, record.date, record.amount));
        if (!bucket || bucket.length === 0) return false;
        const idx = bucket.findIndex((desc) => isSimilarDescription(desc, record.description));
        if (idx < 0) return false;
        bucket.splice(idx, 1); // consume the match
        return true;
    };

    /* ---------------- Transactions ---------------- */

    const transactions: PlannedPersonalTransaction[] = [];
    const duplicates: SkippedDuplicate[] = [];

    for (const r of records) {
        const accountName = r.account.trim() || '(no account)';
        const sourceRef = sourceRefByName.get(accountName)!;
        const categoryRef = categoryRefByLabel.get(categoryLabel(r.category))!;

        if (sourceRef.kind === 'existing' && isDuplicate(r, sourceRef.guid)) {
            duplicates.push({
                row: r.row,
                date: r.date,
                amount: r.amount,
                description: r.description,
                account: accountName,
            });
            if (skipDuplicates) continue;
        }

        transactions.push({
            date: r.date,
            description: r.description,
            sourceAccount: accountName,
            category: categoryLabel(r.category),
            row: r.row,
            splits: [
                { account: sourceRef, memo: r.memo, amount: round2(r.amount) },
                { account: categoryRef, memo: '', amount: round2(-r.amount) },
            ],
        });
    }

    return {
        accountsToCreate: Array.from(accountsToCreate.values()),
        transactions,
        duplicates,
        sourceAccounts: sourceAccounts.sort((a, b) => a.name.localeCompare(b.name)),
        categories: categories.sort((a, b) => a.name.localeCompare(b.name)),
        warnings,
    };
}

/**
 * Budget Auto-Funding Rules
 *
 * A funding rule watches a bank account for incoming deposits (paychecks,
 * client payments) and, when a new deposit matches, sweeps fixed amounts
 * into envelope accounts — real asset sub-accounts (e.g.
 * Assets:Savings:Vacation). The sweep is one double-entry GnuCash transfer
 * dated the same day as the deposit: debit each envelope, credit the bank
 * account for the total.
 *
 * Matching (pure, unit-tested):
 *   - rule is active
 *   - the deposit credits the trigger account (positive value splits)
 *   - description contains trigger_description_match, case-insensitive
 *     (empty/null match = any description)
 *   - deposit amount >= min_amount (null = no minimum)
 *
 * Dedupe design — the sweep transaction IS the dedupe record:
 *   The created transfer's `transactions.num` field is stamped with
 *   `autofund:<ruleId>:<triggerTxnGuid>`. Before applying, the engine checks
 *   for an existing transaction with that exact num. This is more robust than
 *   a cursor or a side-table log because:
 *     - it survives worker restarts, redeploys, and DB restores (the marker
 *       lives in the same ledger as the sweep itself — they can never drift)
 *     - deleting the sweep transaction naturally re-arms the rule for that
 *       deposit, which is the intuitive behavior
 *     - `last_applied_txn_guid` only holds ONE txn, so it can't dedupe a
 *       rule that matches several deposits inside the scan window
 *   The scan window is a rolling `sinceDays` (default 3) of post dates, so
 *   the 30-minute worker sweep re-scans recent history safely — re-runs are
 *   no-ops thanks to the num stamp. `last_applied_txn_guid` is still updated,
 *   purely for display ("last applied") in the UI.
 */

import prisma from '@/lib/prisma';
import { generateGuid, fromDecimal } from '@/lib/gnucash';
import { getCachedLockDate, findLockedDate, toIsoDateString } from '@/lib/services/period-lock.service';
import { getAccountGuidsForBook } from '@/lib/book-scope';

/* ------------------------------------------------------------------ */
/* Types                                                                */
/* ------------------------------------------------------------------ */

export interface FundingAllocation {
    /** Envelope (asset) account receiving the money. */
    accountGuid: string;
    /** Fixed amount to sweep, in account currency. */
    amount: number;
}

export interface FundingRule {
    id: number;
    bookGuid: string;
    name: string;
    triggerAccountGuid: string | null;
    triggerDescriptionMatch: string | null;
    minAmount: number | null;
    allocations: FundingAllocation[];
    active: boolean;
    lastAppliedTxnGuid: string | null;
    createdAt: string;
    updatedAt: string;
    /** Resolved display names (list queries only). */
    triggerAccountName?: string | null;
    allocationNames?: Array<FundingAllocation & { accountName: string }>;
}

export interface FundingRuleInput {
    name: string;
    triggerAccountGuid: string;
    triggerDescriptionMatch?: string | null;
    minAmount?: number | null;
    allocations: FundingAllocation[];
    active?: boolean;
}

export interface DepositCandidate {
    txGuid: string;
    postDate: Date;
    description: string;
    /** Total credited into the trigger account by this transaction. */
    amount: number;
}

export interface FundingRunResult {
    rulesScanned: number;
    depositsMatched: number;
    applied: number;
    skippedAlreadyApplied: number;
    skippedLocked: number;
    errors: string[];
}

export interface FundingApplication {
    txGuid: string;
    ruleId: number | null;
    ruleName: string | null;
    triggerTxnGuid: string | null;
    postDate: string;
    description: string;
    amount: number;
}

export class FundingRuleError extends Error {
    constructor(message: string, public status: number = 400) {
        super(message);
        this.name = 'FundingRuleError';
    }
}

/** Account types allowed as a deposit trigger (cash-like accounts). */
export const TRIGGER_ACCOUNT_TYPES = ['BANK', 'CASH', 'ASSET'];
/** Account types allowed as envelope targets (real asset sub-accounts). */
export const ENVELOPE_ACCOUNT_TYPES = ['ASSET', 'BANK', 'CASH'];

const MAX_ALLOCATIONS = 20;
const DEDUPE_PREFIX = 'autofund:';

/* ------------------------------------------------------------------ */
/* Pure helpers (exported for tests)                                    */
/* ------------------------------------------------------------------ */

/** Case-insensitive substring match; empty/null pattern matches anything. */
export function descriptionMatches(pattern: string | null | undefined, description: string | null | undefined): boolean {
    const p = (pattern ?? '').trim().toLowerCase();
    if (p === '') return true;
    return (description ?? '').toLowerCase().includes(p);
}

/** Dedupe key stamped into the sweep transaction's `num` column. */
export function fundingDedupeKey(ruleId: number, triggerTxnGuid: string): string {
    return `${DEDUPE_PREFIX}${ruleId}:${triggerTxnGuid}`;
}

/** Parse a dedupe key back into its parts (null when not an autofund num). */
export function parseFundingDedupeKey(num: string | null | undefined): { ruleId: number; triggerTxnGuid: string } | null {
    if (!num || !num.startsWith(DEDUPE_PREFIX)) return null;
    const rest = num.slice(DEDUPE_PREFIX.length);
    const sep = rest.indexOf(':');
    if (sep <= 0) return null;
    const ruleId = parseInt(rest.slice(0, sep), 10);
    const triggerTxnGuid = rest.slice(sep + 1);
    if (!Number.isInteger(ruleId) || ruleId <= 0 || triggerTxnGuid.length === 0) return null;
    return { ruleId, triggerTxnGuid };
}

/**
 * Core matching rule: does this deposit fire this rule?
 * (Trigger-account scoping happens in the SQL that loads candidates;
 * this checks the remaining conditions.)
 */
export function ruleMatchesDeposit(
    rule: { active: boolean; triggerDescriptionMatch: string | null; minAmount: number | null },
    deposit: { description: string | null; amount: number },
): boolean {
    if (!rule.active) return false;
    if (!(deposit.amount > 0)) return false;
    if (!descriptionMatches(rule.triggerDescriptionMatch, deposit.description)) return false;
    if (rule.minAmount != null && deposit.amount < rule.minAmount) return false;
    return true;
}

/** Validate and normalize an allocations payload (throws FundingRuleError). */
export function parseAllocations(value: unknown): FundingAllocation[] {
    if (!Array.isArray(value) || value.length === 0) {
        throw new FundingRuleError('At least one allocation is required');
    }
    if (value.length > MAX_ALLOCATIONS) {
        throw new FundingRuleError(`At most ${MAX_ALLOCATIONS} allocations per rule`);
    }
    const seen = new Set<string>();
    return value.map((raw, i) => {
        const entry = raw as { accountGuid?: unknown; amount?: unknown };
        const accountGuid = typeof entry.accountGuid === 'string' ? entry.accountGuid : '';
        const amount = typeof entry.amount === 'number' ? entry.amount : NaN;
        if (!/^[0-9a-f]{32}$/i.test(accountGuid)) {
            throw new FundingRuleError(`Allocation ${i + 1}: invalid account`);
        }
        if (!Number.isFinite(amount) || amount <= 0) {
            throw new FundingRuleError(`Allocation ${i + 1}: amount must be greater than zero`);
        }
        if (seen.has(accountGuid)) {
            throw new FundingRuleError(`Allocation ${i + 1}: duplicate envelope account`);
        }
        seen.add(accountGuid);
        return { accountGuid, amount: Math.round(amount * 100) / 100 };
    });
}

/** Sum of a rule's allocations, rounded to cents. */
export function allocationsTotal(allocations: FundingAllocation[]): number {
    return Math.round(allocations.reduce((sum, a) => sum + a.amount, 0) * 100) / 100;
}

/* ------------------------------------------------------------------ */
/* Row mapping                                                          */
/* ------------------------------------------------------------------ */

type RuleRow = {
    id: number;
    book_guid: string;
    name: string;
    trigger_account_guid: string | null;
    trigger_description_match: string | null;
    min_amount: unknown;
    allocations: unknown;
    active: boolean;
    last_applied_txn_guid: string | null;
    created_at: Date;
    updated_at: Date;
};

function toNumberOrNull(value: unknown): number | null {
    if (value == null) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function rowAllocations(value: unknown): FundingAllocation[] {
    if (!Array.isArray(value)) return [];
    return value
        .filter((a): a is { accountGuid: string; amount: number } =>
            !!a && typeof (a as { accountGuid?: unknown }).accountGuid === 'string' &&
            typeof (a as { amount?: unknown }).amount === 'number')
        .map(a => ({ accountGuid: a.accountGuid, amount: a.amount }));
}

function mapRule(row: RuleRow): FundingRule {
    return {
        id: row.id,
        bookGuid: row.book_guid,
        name: row.name,
        triggerAccountGuid: row.trigger_account_guid,
        triggerDescriptionMatch: row.trigger_description_match,
        minAmount: toNumberOrNull(row.min_amount),
        allocations: rowAllocations(row.allocations),
        active: row.active,
        lastAppliedTxnGuid: row.last_applied_txn_guid,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
    };
}

/* ------------------------------------------------------------------ */
/* CRUD                                                                 */
/* ------------------------------------------------------------------ */

async function accountNames(guids: string[]): Promise<Map<string, string>> {
    if (guids.length === 0) return new Map();
    const rows = await prisma.$queryRaw<Array<{ guid: string; fullname: string | null; name: string }>>`
        SELECT ah.guid, ah.fullname, ah.name
        FROM account_hierarchy ah
        WHERE ah.guid = ANY(${guids})
    `;
    return new Map(rows.map(r => [r.guid, r.fullname ?? r.name]));
}

export async function listFundingRules(bookGuid: string): Promise<FundingRule[]> {
    const rows = await prisma.gnucash_web_budget_funding_rules.findMany({
        where: { book_guid: bookGuid },
        orderBy: [{ active: 'desc' }, { name: 'asc' }],
    });
    const rules = rows.map(r => mapRule(r as unknown as RuleRow));

    const guids = new Set<string>();
    for (const r of rules) {
        if (r.triggerAccountGuid) guids.add(r.triggerAccountGuid);
        for (const a of r.allocations) guids.add(a.accountGuid);
    }
    const names = await accountNames([...guids]);
    for (const r of rules) {
        r.triggerAccountName = r.triggerAccountGuid ? names.get(r.triggerAccountGuid) ?? null : null;
        r.allocationNames = r.allocations.map(a => ({
            ...a,
            accountName: names.get(a.accountGuid) ?? a.accountGuid,
        }));
    }
    return rules;
}

/**
 * Validate rule input against the book: trigger must be a currency
 * bank/cash/asset account in the book; every envelope must be a currency
 * asset-style account in the book, distinct from the trigger, and share the
 * trigger's currency (single-currency transfers only).
 */
async function validateRuleAccounts(bookGuid: string, input: { triggerAccountGuid: string; allocations: FundingAllocation[] }): Promise<void> {
    const bookGuids = new Set(await getAccountGuidsForBook(bookGuid));
    if (!bookGuids.has(input.triggerAccountGuid)) {
        throw new FundingRuleError('Trigger account is not in this book');
    }
    const allGuids = [input.triggerAccountGuid, ...input.allocations.map(a => a.accountGuid)];
    const accounts = await prisma.accounts.findMany({
        where: { guid: { in: allGuids } },
        select: {
            guid: true,
            account_type: true,
            placeholder: true,
            commodity_guid: true,
            commodity: { select: { namespace: true } },
        },
    });
    const byGuid = new Map(accounts.map(a => [a.guid, a]));

    const trigger = byGuid.get(input.triggerAccountGuid);
    if (!trigger || !TRIGGER_ACCOUNT_TYPES.includes(trigger.account_type)) {
        throw new FundingRuleError('Trigger must be a bank, cash, or asset account');
    }
    if (trigger.commodity?.namespace !== 'CURRENCY' || !trigger.commodity_guid) {
        throw new FundingRuleError('Trigger account must be a currency account');
    }

    for (const alloc of input.allocations) {
        if (alloc.accountGuid === input.triggerAccountGuid) {
            throw new FundingRuleError('An envelope cannot be the trigger account itself');
        }
        if (!bookGuids.has(alloc.accountGuid)) {
            throw new FundingRuleError('An envelope account is not in this book');
        }
        const acct = byGuid.get(alloc.accountGuid);
        if (!acct || !ENVELOPE_ACCOUNT_TYPES.includes(acct.account_type)) {
            throw new FundingRuleError('Envelopes must be asset, bank, or cash accounts');
        }
        if (acct.placeholder === 1) {
            throw new FundingRuleError('Envelopes cannot be placeholder accounts');
        }
        if (acct.commodity_guid !== trigger.commodity_guid) {
            throw new FundingRuleError('Envelopes must use the same currency as the trigger account');
        }
    }
}

export function parseFundingRuleInput(body: unknown): FundingRuleInput {
    const b = (body ?? {}) as Record<string, unknown>;
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (name.length === 0 || name.length > 255) {
        throw new FundingRuleError('Name is required (max 255 chars)');
    }
    const triggerAccountGuid = typeof b.triggerAccountGuid === 'string' ? b.triggerAccountGuid : '';
    if (!/^[0-9a-f]{32}$/i.test(triggerAccountGuid)) {
        throw new FundingRuleError('A trigger account is required');
    }
    const match = typeof b.triggerDescriptionMatch === 'string' ? b.triggerDescriptionMatch.trim() : '';
    if (match.length > 255) throw new FundingRuleError('Description match is too long (max 255 chars)');

    let minAmount: number | null = null;
    if (b.minAmount != null && b.minAmount !== '') {
        const n = Number(b.minAmount);
        if (!Number.isFinite(n) || n < 0) throw new FundingRuleError('Minimum amount must be zero or more');
        minAmount = Math.round(n * 100) / 100;
    }
    const allocations = parseAllocations(b.allocations);
    const active = b.active === undefined ? true : Boolean(b.active);
    return { name, triggerAccountGuid, triggerDescriptionMatch: match || null, minAmount, allocations, active };
}

export async function createFundingRule(bookGuid: string, input: FundingRuleInput): Promise<FundingRule> {
    await validateRuleAccounts(bookGuid, input);
    const row = await prisma.gnucash_web_budget_funding_rules.create({
        data: {
            book_guid: bookGuid,
            name: input.name,
            trigger_account_guid: input.triggerAccountGuid,
            trigger_description_match: input.triggerDescriptionMatch,
            min_amount: input.minAmount,
            allocations: input.allocations as unknown as object,
            active: input.active ?? true,
        },
    });
    return mapRule(row as unknown as RuleRow);
}

export async function updateFundingRule(bookGuid: string, id: number, input: FundingRuleInput): Promise<FundingRule | null> {
    const existing = await prisma.gnucash_web_budget_funding_rules.findFirst({
        where: { id, book_guid: bookGuid },
    });
    if (!existing) return null;
    await validateRuleAccounts(bookGuid, input);
    const row = await prisma.gnucash_web_budget_funding_rules.update({
        where: { id },
        data: {
            name: input.name,
            trigger_account_guid: input.triggerAccountGuid,
            trigger_description_match: input.triggerDescriptionMatch,
            min_amount: input.minAmount,
            allocations: input.allocations as unknown as object,
            active: input.active ?? existing.active,
            updated_at: new Date(),
        },
    });
    return mapRule(row as unknown as RuleRow);
}

export async function setFundingRuleActive(bookGuid: string, id: number, active: boolean): Promise<FundingRule | null> {
    const existing = await prisma.gnucash_web_budget_funding_rules.findFirst({
        where: { id, book_guid: bookGuid },
    });
    if (!existing) return null;
    const row = await prisma.gnucash_web_budget_funding_rules.update({
        where: { id },
        data: { active, updated_at: new Date() },
    });
    return mapRule(row as unknown as RuleRow);
}

export async function deleteFundingRule(bookGuid: string, id: number): Promise<boolean> {
    const deleted = await prisma.gnucash_web_budget_funding_rules.deleteMany({
        where: { id, book_guid: bookGuid },
    });
    return deleted.count > 0;
}

/* ------------------------------------------------------------------ */
/* Engine                                                               */
/* ------------------------------------------------------------------ */

/**
 * Recent deposits into the trigger account: positive-value splits grouped by
 * transaction, excluding our own sweep transactions (num starts 'autofund:').
 */
async function loadRecentDeposits(triggerAccountGuid: string, cutoff: Date): Promise<DepositCandidate[]> {
    const rows = await prisma.$queryRaw<Array<{
        guid: string;
        post_date: Date;
        description: string | null;
        amount: number | null;
    }>>`
        SELECT t.guid, t.post_date, t.description,
               SUM(s.value_num::numeric / NULLIF(s.value_denom, 0))::float8 AS amount
        FROM splits s
        JOIN transactions t ON t.guid = s.tx_guid
        WHERE s.account_guid = ${triggerAccountGuid}
          AND s.value_num > 0
          AND t.post_date >= ${cutoff}
          AND t.num NOT LIKE 'autofund:%'
        GROUP BY t.guid, t.post_date, t.description
        ORDER BY t.post_date ASC
    `;
    return rows
        .filter(r => r.post_date != null && (r.amount ?? 0) > 0)
        .map(r => ({
            txGuid: r.guid,
            postDate: r.post_date,
            description: r.description ?? '',
            amount: Math.round((r.amount ?? 0) * 100) / 100,
        }));
}

async function notifyBookEditors(bookGuid: string, opts: {
    title: string;
    message: string;
    href: string;
    sourceId: string;
}): Promise<void> {
    const { createNotification, ensureNotificationsTable } = await import('@/lib/notifications');
    await ensureNotificationsTable();
    const permissions = await prisma.gnucash_web_book_permissions.findMany({
        where: { book_guid: bookGuid },
        include: { role: true },
    });
    const userIds = [...new Set(
        permissions.filter(p => p.role.name === 'edit' || p.role.name === 'admin').map(p => p.user_id),
    )];
    for (const userId of userIds) {
        const exists = await prisma.$queryRaw<Array<{ id: number }>>`
            SELECT id FROM gnucash_web_notifications
            WHERE user_id = ${userId} AND source = 'funding-rules' AND source_id = ${opts.sourceId}
            LIMIT 1
        `;
        if (exists.length > 0) continue;
        await createNotification({
            userId,
            bookGuid,
            type: 'funding_rule_applied',
            severity: 'info',
            title: opts.title,
            message: opts.message,
            href: opts.href,
            source: 'funding-rules',
            sourceId: opts.sourceId,
        });
    }
}

/**
 * Scan recent deposits and apply matching rules. Used by both the worker's
 * 30-minute sweep (all books) and the page's "Run now" button (one book).
 * Idempotent: already-applied (rule, deposit) pairs are skipped via the
 * `autofund:<ruleId>:<txGuid>` num stamp; period-locked dates are skipped.
 */
export async function runFundingRules(options: {
    bookGuid?: string;
    sinceDays?: number;
    notify?: boolean;
} = {}): Promise<FundingRunResult> {
    const sinceDays = Math.min(31, Math.max(1, options.sinceDays ?? 3));
    const cutoff = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);
    cutoff.setUTCHours(0, 0, 0, 0);

    const result: FundingRunResult = {
        rulesScanned: 0,
        depositsMatched: 0,
        applied: 0,
        skippedAlreadyApplied: 0,
        skippedLocked: 0,
        errors: [],
    };

    const rows = await prisma.gnucash_web_budget_funding_rules.findMany({
        where: { active: true, ...(options.bookGuid ? { book_guid: options.bookGuid } : {}) },
        orderBy: { id: 'asc' },
    });
    const rules = rows.map(r => mapRule(r as unknown as RuleRow));
    result.rulesScanned = rules.length;

    for (const rule of rules) {
        if (!rule.triggerAccountGuid || rule.allocations.length === 0) continue;
        try {
            const deposits = await loadRecentDeposits(rule.triggerAccountGuid, cutoff);
            for (const deposit of deposits) {
                if (!ruleMatchesDeposit(rule, deposit)) continue;
                result.depositsMatched++;

                const dedupeKey = fundingDedupeKey(rule.id, deposit.txGuid);
                const already = await prisma.transactions.findFirst({
                    where: { num: dedupeKey },
                    select: { guid: true },
                });
                if (already) {
                    result.skippedAlreadyApplied++;
                    continue;
                }

                // Period lock: never post into a closed period.
                const lockDate = await getCachedLockDate(rule.bookGuid);
                if (findLockedDate(lockDate, [deposit.postDate]) !== null) {
                    result.skippedLocked++;
                    continue;
                }

                await applySweep(rule, deposit, dedupeKey);
                result.applied++;

                if (options.notify !== false) {
                    const total = allocationsTotal(rule.allocations);
                    await notifyBookEditors(rule.bookGuid, {
                        title: `Auto-funded ${rule.name}`,
                        message: `Swept ${total.toFixed(2)} into ${rule.allocations.length} envelope${rule.allocations.length === 1 ? '' : 's'} after "${deposit.description}" (${deposit.amount.toFixed(2)}) landed.`,
                        href: '/budgets/funding-rules',
                        sourceId: dedupeKey,
                    });
                }
            }
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            result.errors.push(`Rule "${rule.name}" (#${rule.id}): ${msg}`);
        }
    }

    return result;
}

/** Create the sweep transfer for one (rule, deposit) pair. Returns the txn guid. */
async function applySweep(rule: FundingRule, deposit: DepositCandidate, dedupeKey: string): Promise<string> {
    // Re-validate currencies at apply time (accounts may have changed since
    // the rule was saved).
    const allGuids = [rule.triggerAccountGuid!, ...rule.allocations.map(a => a.accountGuid)];
    const accounts = await prisma.accounts.findMany({
        where: { guid: { in: allGuids } },
        select: { guid: true, commodity_guid: true, commodity: { select: { namespace: true } } },
    });
    const byGuid = new Map(accounts.map(a => [a.guid, a]));
    const trigger = byGuid.get(rule.triggerAccountGuid!);
    if (!trigger?.commodity_guid || trigger.commodity?.namespace !== 'CURRENCY') {
        throw new FundingRuleError('Trigger account is no longer a currency account');
    }
    for (const alloc of rule.allocations) {
        const acct = byGuid.get(alloc.accountGuid);
        if (!acct) throw new FundingRuleError('An envelope account no longer exists');
        if (acct.commodity_guid !== trigger.commodity_guid) {
            throw new FundingRuleError('An envelope account no longer matches the trigger currency');
        }
    }

    const total = allocationsTotal(rule.allocations);
    const txnGuid = generateGuid();
    const enterDate = new Date();
    const description = `Auto-fund: ${rule.name}`;
    const currencyGuid = trigger.commodity_guid;
    const { num: totalNum, denom } = fromDecimal(total);

    await prisma.$transaction(async tx => {
        await tx.$executeRaw`
            INSERT INTO transactions (guid, currency_guid, num, post_date, enter_date, description)
            VALUES (${txnGuid}, ${currencyGuid}, ${dedupeKey}, ${deposit.postDate}, ${enterDate}, ${description})
        `;

        // Debit each envelope for its allocation.
        for (const alloc of rule.allocations) {
            const splitGuid = generateGuid();
            const { num } = fromDecimal(alloc.amount);
            await tx.$executeRaw`
                INSERT INTO splits (guid, tx_guid, account_guid, memo, action, reconcile_state, reconcile_date, value_num, value_denom, quantity_num, quantity_denom, lot_guid)
                VALUES (${splitGuid}, ${txnGuid}, ${alloc.accountGuid}, ${description}, '', 'n', NULL, ${num}, ${denom}, ${num}, ${denom}, NULL)
            `;
        }

        // Credit the bank account for the total.
        const bankSplitGuid = generateGuid();
        await tx.$executeRaw`
            INSERT INTO splits (guid, tx_guid, account_guid, memo, action, reconcile_state, reconcile_date, value_num, value_denom, quantity_num, quantity_denom, lot_guid)
            VALUES (${bankSplitGuid}, ${txnGuid}, ${rule.triggerAccountGuid}, ${description}, '', 'n', NULL, ${-totalNum}, ${denom}, ${-totalNum}, ${denom}, NULL)
        `;

        await tx.gnucash_web_budget_funding_rules.update({
            where: { id: rule.id },
            data: { last_applied_txn_guid: deposit.txGuid, updated_at: new Date() },
        });
    });

    return txnGuid;
}

/* ------------------------------------------------------------------ */
/* Application history                                                  */
/* ------------------------------------------------------------------ */

/**
 * Recent sweep transactions for a book — found by their `autofund:` num
 * stamp on transactions whose splits touch the book's accounts.
 */
export async function listFundingApplications(bookGuid: string, limit = 50): Promise<FundingApplication[]> {
    const bookGuids = await getAccountGuidsForBook(bookGuid);
    if (bookGuids.length === 0) return [];

    const rows = await prisma.$queryRaw<Array<{
        guid: string;
        num: string;
        post_date: Date | null;
        description: string | null;
        amount: number | null;
    }>>`
        SELECT t.guid, t.num, t.post_date, t.description,
               SUM(CASE WHEN s.value_num > 0 THEN s.value_num::numeric / NULLIF(s.value_denom, 0) ELSE 0 END)::float8 AS amount
        FROM transactions t
        JOIN splits s ON s.tx_guid = t.guid
        WHERE t.num LIKE 'autofund:%'
          AND s.account_guid = ANY(${bookGuids})
        GROUP BY t.guid, t.num, t.post_date, t.description
        ORDER BY t.post_date DESC, t.guid DESC
        LIMIT ${Math.min(200, Math.max(1, limit))}
    `;

    const ruleIds = new Set<number>();
    const parsed = rows.map(r => {
        const key = parseFundingDedupeKey(r.num);
        if (key) ruleIds.add(key.ruleId);
        return { row: r, key };
    });
    const ruleRows = ruleIds.size > 0
        ? await prisma.gnucash_web_budget_funding_rules.findMany({
            where: { id: { in: [...ruleIds] } },
            select: { id: true, name: true },
        })
        : [];
    const ruleNames = new Map(ruleRows.map(r => [r.id, r.name]));

    return parsed.map(({ row, key }) => ({
        txGuid: row.guid,
        ruleId: key?.ruleId ?? null,
        ruleName: key ? ruleNames.get(key.ruleId) ?? null : null,
        triggerTxnGuid: key?.triggerTxnGuid ?? null,
        postDate: row.post_date ? toIsoDateString(row.post_date) : '',
        description: row.description ?? '',
        amount: Math.round((row.amount ?? 0) * 100) / 100,
    }));
}

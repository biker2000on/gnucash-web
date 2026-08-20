/**
 * Transaction change history — the pure diff renderer.
 *
 * `gnucash_web_audit` already records every book mutation with a full
 * before/after snapshot (see `src/lib/services/audit.service.ts`). Nothing
 * surfaced it per transaction, so this module turns those rows into the
 * human-readable timeline the transaction activity feed renders:
 *
 *     Justin changed amount $120.00 → $102.00 and account
 *     Expenses:Food → Expenses:Groceries
 *
 * Deliberately pure: no prisma, no `next/headers`, no I/O. Account paths and
 * user display names arrive as resolver callbacks so the renderer can be unit
 * tested exhaustively and reused from a client component if that is ever
 * wanted. The route in `src/app/api/transactions/[guid]/history` does the
 * book-scoped fetching and builds the resolvers.
 */

import { formatCurrency } from '@/lib/format';
import { toDecimalNumber } from '@/lib/gnucash';

/** The subset of an audit row this renderer needs. */
export interface AuditRowLike {
    id: number;
    action: string;
    entity_type: string;
    entity_guid: string;
    old_values: unknown;
    new_values: unknown;
    created_at: Date | string;
    user_id: number | null;
    undone_at?: Date | string | null;
}

/** Who (or what) performed a change. */
export interface HistoryActor {
    kind: 'user' | 'automation' | 'system';
    /** User id as a string, or the automation key. Null for the bare system actor. */
    id: string | null;
    label: string;
}

/** One field-level before/after pair. */
export interface HistoryChange {
    /** Machine key: `amount`, `account`, `description`, `reconcile_state`, … */
    field: string;
    /** Human label used in the sentence ("amount", "account", "memo"). */
    label: string;
    before: string | null;
    after: string | null;
    /** Set when the change belongs to one split of a multi-split transaction. */
    splitGuid?: string;
}

export type HistoryEventKind = 'created' | 'updated' | 'deleted' | 'other';

export interface HistoryEvent {
    auditId: number;
    /** ISO timestamp — the feed sorts on this. */
    at: string;
    actor: HistoryActor;
    kind: HistoryEventKind;
    entityType: string;
    entityGuid: string;
    /** The rendered sentence, actor included. */
    summary: string;
    changes: HistoryChange[];
    /** True when this entry has been undone (audit.undone_at is set). */
    undone: boolean;
}

export interface HistoryResolvers {
    /** Account guid → book-relative full path, or undefined when unknown. */
    accountPath?: (guid: string) => string | undefined;
    /** User id → display name, or undefined when unknown. */
    userName?: (id: number) => string | undefined;
    /**
     * Currency mnemonic for money formatting — the *transaction's* currency,
     * which is what `split.value` is denominated in. Defaults to USD only
     * because a caller that supplies nothing has told us nothing; the route
     * always resolves the real one.
     */
    currency?: string;
    /**
     * Account guid → its commodity namespace (`CURRENCY`, `NASDAQ`, `FUND`, …).
     *
     * This is how a share leg is identified. It cannot be inferred from the
     * split alone: `split.value` is in the transaction's currency while
     * `split.quantity` is in the account's, so on any cross-currency
     * transaction every *cash* split has value ≠ quantity too.
     */
    accountNamespace?: (guid: string) => string | undefined;
}

/**
 * Automation actors we can name honestly from the audit payload.
 *
 * The audit table has one `user_id` column and no actor column, so a change
 * made by a background job lands with `user_id = NULL`. Several writers stamp
 * a `source` into the payload; where they do, that is the actor's real name
 * and the timeline says so rather than shrugging at "System".
 */
const AUTOMATION_LABELS: Record<string, string> = {
    simplefin: 'SimpleFIN sync',
    simplefin_sync: 'SimpleFIN sync',
    inbound_webhook: 'Inbound webhook',
    webhook: 'Inbound webhook',
    scheduled_transaction: 'Scheduled transaction',
    scheduled: 'Scheduled transaction',
    scrub: 'Lot scrub',
    lot_scrub: 'Lot scrub',
    lot_assignment: 'Lot assignment',
    rule: 'Categorization rule',
    categorization_rule: 'Categorization rule',
    import: 'Import',
    csv_import: 'CSV import',
    ofx_import: 'OFX import',
    email_ingest: 'Email ingest',
    close_book: 'Book close',
    equity_comp: 'Equity compensation tool',
    asset_tool: 'Asset tool',
};

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

function isoOf(value: Date | string): string {
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** The `source`-ish key stamped into either side of an audit payload. */
function payloadSource(row: AuditRowLike): string | null {
    for (const side of [row.new_values, row.old_values]) {
        const record = asRecord(side);
        if (!record) continue;
        for (const key of ['source', 'actor', 'automation', 'origin']) {
            const raw = record[key];
            if (typeof raw === 'string' && raw.trim() !== '') return raw.trim().toLowerCase();
        }
    }
    return null;
}

/**
 * Resolve the actor for one audit row.
 *
 * A named user always wins: automation that runs on a user's behalf (executing
 * a scheduled transaction from the UI, say) records that user, and claiming
 * otherwise would misattribute a real person's action. Only an unattributed
 * row falls through to the automation name, then to the bare system actor.
 */
export function resolveActor(row: AuditRowLike, resolvers: HistoryResolvers = {}): HistoryActor {
    if (row.user_id !== null && row.user_id !== undefined) {
        const name = resolvers.userName?.(row.user_id);
        return {
            kind: 'user',
            id: String(row.user_id),
            label: name && name.trim() !== '' ? name : `User #${row.user_id}`,
        };
    }
    const source = payloadSource(row);
    if (source && source !== 'manual') {
        return {
            kind: 'automation',
            id: source,
            label: AUTOMATION_LABELS[source] ?? source.replace(/[_-]+/g, ' '),
        };
    }
    return { kind: 'system', id: null, label: 'System' };
}

// ---------------------------------------------------------------------------
// Value formatting
// ---------------------------------------------------------------------------

function formatAccount(guid: string | null | undefined, resolvers: HistoryResolvers): string | null {
    if (!guid) return null;
    return resolvers.accountPath?.(guid) ?? `account ${guid.slice(0, 8)}…`;
}

function formatMoney(
    num: unknown,
    denom: unknown,
    resolvers: HistoryResolvers,
): string | null {
    const value = decimalOf(num, denom);
    return value === null ? null : formatCurrency(value, resolvers.currency ?? 'USD');
}

/** Decimal value of a fraction pair, or null when either side is missing/unusable. */
function decimalOf(num: unknown, denom: unknown): number | null {
    if (num === null || num === undefined || denom === null || denom === undefined) return null;
    try {
        return toDecimalNumber(num as string | number, denom as string | number);
    } catch {
        return null;
    }
}

/** Denominators a currency plausibly uses: JPY 1, most 100, a few 1000. */
const CURRENCY_DENOMS = new Set([1, 5, 10, 100, 1000]);

/**
 * Heuristic used only when no `accountNamespace` resolver is supplied.
 *
 * A share quantity is either whole units (denom 1) or carried at a precision
 * finer than any currency's minor unit (denom > 100 — brokerages store
 * fractional shares at 1e6/1e8). A cross-currency *cash* split is a currency
 * amount on both sides, so its quantity denominator is a currency denominator
 * and it is rejected here. The one shape this cannot separate is a
 * whole-unit currency (JPY) against a cents currency, which is why the route
 * supplies the resolver rather than relying on this.
 */
function looksLikeShareQuantity(split: SplitLike): boolean {
    const quantityDenom = Number(split.quantity_denom);
    const valueDenom = Number(split.value_denom);
    if (!Number.isFinite(quantityDenom) || quantityDenom <= 0) return false;
    if (quantityDenom === valueDenom) return false;
    return quantityDenom === 1 || !CURRENCY_DENOMS.has(quantityDenom);
}

/**
 * A split whose quantity is a share count, not a mirror of its cash value.
 *
 * Keyed off the split's *account commodity* whenever the caller can resolve
 * one: a non-CURRENCY commodity is a share (or unit) holding and nothing else.
 */
function isShareLeg(split: SplitLike | undefined, resolvers: HistoryResolvers): boolean {
    if (!split) return false;
    const value = decimalOf(split.value_num, split.value_denom);
    const quantity = decimalOf(split.quantity_num, split.quantity_denom);
    if (value === null || quantity === null) return false;
    if (value === quantity) return false;

    const accountGuid = typeof split.account_guid === 'string' ? split.account_guid : null;
    const namespace = accountGuid ? resolvers.accountNamespace?.(accountGuid) : undefined;
    if (namespace !== undefined) return namespace.toUpperCase() !== 'CURRENCY';
    return looksLikeShareQuantity(split);
}

function formatQuantity(num: unknown, denom: unknown): string | null {
    const value = decimalOf(num, denom);
    return value === null ? null : value.toLocaleString('en-US', { maximumFractionDigits: 6 });
}

/** GnuCash single-letter reconcile flags, spelled out. */
const RECONCILE_LABELS: Record<string, string> = { n: 'not reconciled', c: 'cleared', y: 'reconciled', f: 'frozen', v: 'voided' };

function formatReconcile(state: unknown): string | null {
    if (typeof state !== 'string' || state === '') return null;
    return RECONCILE_LABELS[state.toLowerCase()] ?? state;
}

/** `2026-08-01`, optionally followed by a time — the shapes audit payloads hold. */
const LEADING_DATE = /^(\d{4}-\d{2}-\d{2})(?:[T ].*)?$/;

/**
 * A post date rendered as its calendar day.
 *
 * The day is read off the string when the string already starts with one.
 * Parsing first would be wrong: `new Date('2026-08-01 00:00:00')` is parsed as
 * *local* time, and `toISOString()` then shifts it back a day for every viewer
 * east of Greenwich — turning "no change" into "date 2026-07-31 → 2026-08-01".
 */
function formatDateish(value: unknown): string | null {
    if (value === null || value === undefined || value === '') return null;
    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
    }
    const text = String(value).trim();
    const leading = LEADING_DATE.exec(text);
    if (leading) return leading[1];
    const parsed = new Date(text);
    if (Number.isNaN(parsed.getTime())) return text;
    return parsed.toISOString().slice(0, 10);
}

/** Last-resort rendering for a value in a payload we have no special rule for. */
function formatScalar(value: unknown): string | null {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'boolean') return value ? 'yes' : 'no';
    if (typeof value === 'number' || typeof value === 'bigint') return String(value);
    if (typeof value === 'string') return value;
    return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// Snapshot diffing
// ---------------------------------------------------------------------------

interface SplitLike {
    guid?: unknown;
    account_guid?: unknown;
    memo?: unknown;
    action?: unknown;
    reconcile_state?: unknown;
    value_num?: unknown;
    value_denom?: unknown;
    quantity_num?: unknown;
    quantity_denom?: unknown;
    lot_guid?: unknown;
}

function splitsOf(payload: Record<string, unknown> | null): SplitLike[] {
    if (!payload || !Array.isArray(payload.splits)) return [];
    return payload.splits.filter((s): s is SplitLike => !!s && typeof s === 'object');
}

/** True for the undo-capable snapshot shape written by `snapshotTransactionByGuid`. */
export function looksLikeTransactionSnapshot(value: unknown): boolean {
    const record = asRecord(value);
    return !!record && typeof record.guid === 'string' && Array.isArray(record.splits);
}

/** Transaction-level fields worth naming, in the order a sentence reads best. */
const TRANSACTION_FIELDS: Array<{ key: string; label: string; format: (v: unknown) => string | null }> = [
    { key: 'description', label: 'description', format: formatScalar },
    { key: 'num', label: 'number', format: formatScalar },
    { key: 'post_date', label: 'date', format: formatDateish },
];

function diffTransactionFields(
    before: Record<string, unknown> | null,
    after: Record<string, unknown> | null,
): HistoryChange[] {
    const changes: HistoryChange[] = [];
    for (const field of TRANSACTION_FIELDS) {
        const from = field.format(before?.[field.key]);
        const to = field.format(after?.[field.key]);
        if (from === to) continue;
        changes.push({ field: field.key, label: field.label, before: from, after: to });
    }
    return changes;
}

function diffOneSplit(
    before: SplitLike | undefined,
    after: SplitLike | undefined,
    resolvers: HistoryResolvers,
): HistoryChange[] {
    const guid = splitGuidOf(after) ?? splitGuidOf(before);
    const changes: HistoryChange[] = [];
    const push = (field: string, label: string, from: string | null, to: string | null) => {
        if (from === to) return;
        changes.push({ field, label, before: from, after: to, splitGuid: guid });
    };

    push(
        'account',
        'account',
        formatAccount(before?.account_guid as string | undefined, resolvers),
        formatAccount(after?.account_guid as string | undefined, resolvers),
    );
    push(
        'amount',
        'amount',
        formatMoney(before?.value_num, before?.value_denom, resolvers),
        formatMoney(after?.value_num, after?.value_denom, resolvers),
    );
    // Share counts only matter on an investment leg, where the quantity is a
    // share count rather than a mirror of the cash value. Naming "shares" on a
    // plain currency split would say the same number twice in every sentence.
    if (isShareLeg(before, resolvers) || isShareLeg(after, resolvers)) {
        push(
            'quantity',
            'shares',
            formatQuantity(before?.quantity_num, before?.quantity_denom),
            formatQuantity(after?.quantity_num, after?.quantity_denom),
        );
    }
    push('memo', 'memo', formatScalar(before?.memo), formatScalar(after?.memo));
    push('action', 'action', formatScalar(before?.action), formatScalar(after?.action));
    push(
        'reconcile_state',
        'reconcile state',
        formatReconcile(before?.reconcile_state),
        formatReconcile(after?.reconcile_state),
    );
    push('lot', 'lot', formatScalar(before?.lot_guid), formatScalar(after?.lot_guid));
    return changes;
}

/**
 * The map key for one split.
 *
 * A guid when there is one; otherwise a positional key, because a snapshot
 * written before split guids were carried (or a hand-built payload) has
 * several guid-less splits and collapsing them all onto `''` would diff only
 * the last one and silently drop the rest.
 */
function splitKey(split: SplitLike, index: number): string {
    const guid = split.guid;
    return typeof guid === 'string' && guid !== '' ? guid : `idx:${index}`;
}

/** The real guid of a split, for `HistoryChange.splitGuid` — never a positional key. */
function splitGuidOf(split: SplitLike | undefined): string | undefined {
    const guid = split?.guid;
    return typeof guid === 'string' && guid !== '' ? guid : undefined;
}

function diffSplits(
    before: SplitLike[],
    after: SplitLike[],
    resolvers: HistoryResolvers,
): HistoryChange[] {
    const beforeByKey = new Map(before.map((s, i) => [splitKey(s, i), s]));
    const afterByKey = new Map(after.map((s, i) => [splitKey(s, i), s]));
    const changes: HistoryChange[] = [];

    // Key order: everything present after, then anything only present before.
    const keys = [...afterByKey.keys(), ...[...beforeByKey.keys()].filter(k => !afterByKey.has(k))];

    for (const key of keys) {
        const from = beforeByKey.get(key);
        const to = afterByKey.get(key);
        if (from && !to) {
            changes.push({
                field: 'split_removed',
                label: 'removed line',
                before: describeSplit(from, resolvers),
                after: null,
                splitGuid: splitGuidOf(from),
            });
            continue;
        }
        if (!from && to) {
            changes.push({
                field: 'split_added',
                label: 'added line',
                before: null,
                after: describeSplit(to, resolvers),
                splitGuid: splitGuidOf(to),
            });
            continue;
        }
        changes.push(...diffOneSplit(from, to, resolvers));
    }
    return changes;
}

/** "Expenses:Groceries $102.00" — a whole split rendered as one phrase. */
function describeSplit(split: SplitLike, resolvers: HistoryResolvers): string {
    const account = formatAccount(split.account_guid as string | undefined, resolvers) ?? 'unknown account';
    const amount = formatMoney(split.value_num, split.value_denom, resolvers);
    return amount ? `${account} ${amount}` : account;
}

/**
 * Generic key-by-key diff for payloads that are not transaction snapshots
 * (webhook/tool writers that stamp a small object).
 */
function diffGenericPayload(
    before: Record<string, unknown> | null,
    after: Record<string, unknown> | null,
): HistoryChange[] {
    const skip = new Set(['snapshotVersion', 'splits', 'guid', 'undo_of_audit_id', 'source', 'actor', 'automation', 'origin']);
    const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})].filter(k => !skip.has(k)));
    const changes: HistoryChange[] = [];
    for (const key of [...keys].sort()) {
        const from = formatScalar(before?.[key]);
        const to = formatScalar(after?.[key]);
        if (from === to) continue;
        changes.push({ field: key, label: key.replace(/_guid$/, '').replace(/[_-]+/g, ' '), before: from, after: to });
    }
    return changes;
}

// ---------------------------------------------------------------------------
// Sentence rendering
// ---------------------------------------------------------------------------

/** "a, b and c" — an Oxford-comma-free list, which is how the sentence reads. */
export function joinPhrases(phrases: string[]): string {
    if (phrases.length === 0) return '';
    if (phrases.length === 1) return phrases[0];
    return `${phrases.slice(0, -1).join(', ')} and ${phrases[phrases.length - 1]}`;
}

/**
 * One change as a phrase, plus whether it needs the leading verb "changed".
 *
 * A before→after pair does ("changed amount $120.00 → $102.00"); setting,
 * clearing, adding and removing carry their own verb and would read as
 * "changed set memo to …" if they borrowed it.
 */
function changePhrase(change: HistoryChange): { text: string; needsVerb: boolean } {
    if (change.before === null && change.after !== null) {
        return {
            text: change.field === 'split_added' ? `added ${change.after}` : `set ${change.label} to ${change.after}`,
            needsVerb: false,
        };
    }
    if (change.before !== null && change.after === null) {
        return {
            text: change.field === 'split_removed'
                ? `removed ${change.before}`
                : `cleared ${change.label} (was ${change.before})`,
            needsVerb: false,
        };
    }
    return { text: `${change.label} ${change.before} → ${change.after}`, needsVerb: true };
}

/** Max field changes named in a summary before it says "and N more changes". */
const MAX_SUMMARY_CHANGES = 4;

function summarize(actor: HistoryActor, kind: HistoryEventKind, changes: HistoryChange[]): string {
    if (kind === 'created') {
        const noteworthy = changes.filter(c => c.field === 'split_added' || c.after !== null).slice(0, MAX_SUMMARY_CHANGES);
        const detail = joinPhrases(noteworthy.map(c => (c.field === 'split_added' ? String(c.after) : `${c.label} ${c.after}`)));
        return detail ? `${actor.label} created this transaction — ${detail}` : `${actor.label} created this transaction`;
    }
    if (kind === 'deleted') return `${actor.label} deleted this transaction`;
    if (changes.length === 0) return `${actor.label} saved this transaction with no field changes`;

    const named = changes.slice(0, MAX_SUMMARY_CHANGES).map(changePhrase);
    const remaining = changes.length - named.length;
    const changed = named.filter(phrase => phrase.needsVerb).map(phrase => phrase.text);
    const standalone = named.filter(phrase => !phrase.needsVerb).map(phrase => phrase.text);

    const clauses: string[] = [];
    if (changed.length > 0) clauses.push(`changed ${joinPhrases(changed)}`);
    clauses.push(...standalone);
    if (remaining > 0) clauses.push(`${remaining} more change${remaining === 1 ? '' : 's'}`);
    return `${actor.label} ${joinPhrases(clauses)}`;
}

function eventKind(action: string): HistoryEventKind {
    switch (action.toUpperCase()) {
        case 'CREATE': return 'created';
        case 'UPDATE': return 'updated';
        case 'DELETE': return 'deleted';
        default: return 'other';
    }
}

/** Render one audit row as a timeline event. */
export function renderAuditRow(row: AuditRowLike, resolvers: HistoryResolvers = {}): HistoryEvent {
    const actor = resolveActor(row, resolvers);
    const kind = eventKind(row.action);
    const before = asRecord(row.old_values);
    const after = asRecord(row.new_values);

    let changes: HistoryChange[];
    if (looksLikeTransactionSnapshot(before) || looksLikeTransactionSnapshot(after)) {
        changes = [
            ...diffTransactionFields(before, after),
            ...diffSplits(splitsOf(before), splitsOf(after), resolvers),
        ];
    } else {
        changes = diffGenericPayload(before, after);
    }

    // A DELETE names nothing field by field — the whole record went away, and
    // listing every field as "cleared" is noise, not history.
    if (kind === 'deleted') changes = [];

    return {
        auditId: row.id,
        at: isoOf(row.created_at),
        actor,
        kind,
        entityType: row.entity_type,
        entityGuid: row.entity_guid,
        summary: summarize(actor, kind, changes),
        changes,
        undone: !!row.undone_at,
    };
}

/**
 * Render a transaction's audit rows (its own and its splits') as one
 * chronological timeline, oldest first.
 */
export function buildTransactionHistory(
    rows: AuditRowLike[],
    resolvers: HistoryResolvers = {},
): HistoryEvent[] {
    return rows
        .map(row => renderAuditRow(row, resolvers))
        .sort((a, b) => (a.at === b.at ? a.auditId - b.auditId : a.at.localeCompare(b.at)));
}

/**
 * The transaction change-history diff renderer.
 *
 * Every payload shape here is one that production actually writes: the
 * undo-capable transaction snapshot from `snapshotTransactionByGuid`, the
 * small object the inbound-webhook route stamps, and the legacy shallow
 * payload from before snapshots existed.
 */

import { describe, expect, it } from 'vitest';
import {
    buildTransactionHistory,
    joinPhrases,
    renderAuditRow,
    resolveActor,
    type AuditRowLike,
} from '@/lib/transaction-history';

const TX = 't'.repeat(32);
const SPLIT_A = 'a'.repeat(32);
const SPLIT_B = 'b'.repeat(32);
const ACCT_CHECKING = '1'.repeat(32);
const ACCT_FOOD = '2'.repeat(32);
const ACCT_GROCERIES = '3'.repeat(32);

const RESOLVERS = {
    accountPath: (guid: string) => ({
        [ACCT_CHECKING]: 'Assets:Checking',
        [ACCT_FOOD]: 'Expenses:Food',
        [ACCT_GROCERIES]: 'Expenses:Groceries',
    }[guid]),
    userName: (id: number) => ({ 7: 'Justin', 9: 'Dana' }[id]),
};

function split(overrides: Record<string, unknown> = {}) {
    return {
        guid: SPLIT_A,
        account_guid: ACCT_FOOD,
        memo: '',
        action: '',
        reconcile_state: 'n',
        reconcile_date: null,
        value_num: '12000',
        value_denom: '100',
        quantity_num: '12000',
        quantity_denom: '100',
        lot_guid: null,
        ...overrides,
    };
}

function snapshot(overrides: Record<string, unknown> = {}) {
    return {
        snapshotVersion: 1,
        guid: TX,
        currency_guid: 'c'.repeat(32),
        num: '',
        post_date: '2026-08-01T00:00:00.000Z',
        enter_date: '2026-08-01T12:00:00.000Z',
        description: 'Corner Market',
        splits: [
            split(),
            split({ guid: SPLIT_B, account_guid: ACCT_CHECKING, value_num: '-12000', quantity_num: '-12000' }),
        ],
        ...overrides,
    };
}

function row(overrides: Partial<AuditRowLike> = {}): AuditRowLike {
    return {
        id: 1,
        action: 'UPDATE',
        entity_type: 'TRANSACTION',
        entity_guid: TX,
        old_values: null,
        new_values: null,
        created_at: new Date('2026-08-19T14:02:00.000Z'),
        user_id: 7,
        undone_at: null,
        ...overrides,
    };
}

describe('resolveActor', () => {
    it('names the user who made the change', () => {
        expect(resolveActor(row(), RESOLVERS)).toEqual({ kind: 'user', id: '7', label: 'Justin' });
    });

    it('falls back to the user id when the name is unknown', () => {
        expect(resolveActor(row({ user_id: 42 }), RESOLVERS).label).toBe('User #42');
    });

    it('attributes an unattributed change to the automation that stamped it', () => {
        const actor = resolveActor(
            row({ user_id: null, new_values: { source: 'inbound_webhook', description: 'x' } }),
            RESOLVERS,
        );
        expect(actor).toEqual({ kind: 'automation', id: 'inbound_webhook', label: 'Inbound webhook' });
    });

    it('names an unknown automation source rather than hiding it', () => {
        const actor = resolveActor(row({ user_id: null, new_values: { source: 'nightly_reindex' } }), RESOLVERS);
        expect(actor).toEqual({ kind: 'automation', id: 'nightly_reindex', label: 'nightly reindex' });
    });

    it('does not claim automation for a manually sourced row', () => {
        const actor = resolveActor(row({ user_id: null, new_values: { source: 'manual' } }), RESOLVERS);
        expect(actor.kind).toBe('system');
    });

    it('prefers the real user over the automation label', () => {
        // Executing a scheduled transaction from the UI records the person who
        // clicked; saying "Scheduled transaction" there would misattribute it.
        const actor = resolveActor(row({ user_id: 9, new_values: { source: 'scheduled' } }), RESOLVERS);
        expect(actor).toEqual({ kind: 'user', id: '9', label: 'Dana' });
    });
});

describe('renderAuditRow — transaction snapshots', () => {
    it('renders the canonical amount + account change sentence', () => {
        const before = snapshot();
        const after = snapshot({
            splits: [
                split({ account_guid: ACCT_GROCERIES, value_num: '10200', quantity_num: '10200' }),
                split({ guid: SPLIT_B, account_guid: ACCT_CHECKING, value_num: '-10200', quantity_num: '-10200' }),
            ],
        });
        const event = renderAuditRow(row({ old_values: before, new_values: after }), RESOLVERS);

        expect(event.summary).toBe(
            'Justin changed account Expenses:Food → Expenses:Groceries, amount $120.00 → $102.00 and amount -$120.00 → -$102.00',
        );
        expect(event.changes).toEqual([
            { field: 'account', label: 'account', before: 'Expenses:Food', after: 'Expenses:Groceries', splitGuid: SPLIT_A },
            { field: 'amount', label: 'amount', before: '$120.00', after: '$102.00', splitGuid: SPLIT_A },
            { field: 'amount', label: 'amount', before: '-$120.00', after: '-$102.00', splitGuid: SPLIT_B },
        ]);
    });

    it('reports a description change at the transaction level', () => {
        const event = renderAuditRow(
            row({ old_values: snapshot(), new_values: snapshot({ description: 'Corner Market — reimbursed' }) }),
            RESOLVERS,
        );
        expect(event.summary).toBe('Justin changed description Corner Market → Corner Market — reimbursed');
    });

    it('spells out a reconcile-state change', () => {
        const after = snapshot({ splits: [split({ reconcile_state: 'y' }), split({ guid: SPLIT_B, account_guid: ACCT_CHECKING })] });
        const event = renderAuditRow(row({ old_values: snapshot(), new_values: after }), RESOLVERS);
        expect(event.changes[0]).toMatchObject({
            field: 'reconcile_state',
            before: 'not reconciled',
            after: 'reconciled',
        });
    });

    it('names added and removed lines rather than diffing them field by field', () => {
        const after = snapshot({
            splits: [
                split(),
                split({ guid: 'd'.repeat(32), account_guid: ACCT_GROCERIES, value_num: '-12000', quantity_num: '-12000' }),
            ],
        });
        const event = renderAuditRow(row({ old_values: snapshot(), new_values: after }), RESOLVERS);
        expect(event.summary).toContain('added Expenses:Groceries -$120.00');
        expect(event.summary).toContain('removed Assets:Checking -$120.00');
    });

    it('reports shares only for an investment leg', () => {
        const before = snapshot({
            splits: [split({ value_num: '100000', quantity_num: '10', quantity_denom: '1' })],
        });
        const after = snapshot({
            splits: [split({ value_num: '100000', quantity_num: '12', quantity_denom: '1' })],
        });
        const event = renderAuditRow(row({ old_values: before, new_values: after }), RESOLVERS);
        expect(event.changes).toEqual([
            { field: 'quantity', label: 'shares', before: '10', after: '12', splitGuid: SPLIT_A },
        ]);
    });

    it('does not mention shares when quantity merely mirrors the cash value', () => {
        const after = snapshot({ splits: [split({ value_num: '10200', quantity_num: '10200' })] });
        const event = renderAuditRow(row({ old_values: snapshot({ splits: [split()] }), new_values: after }), RESOLVERS);
        expect(event.changes.map(change => change.field)).toEqual(['amount']);
    });

    it('describes a create with its opening detail', () => {
        const event = renderAuditRow(
            row({ id: 3, action: 'CREATE', old_values: null, new_values: snapshot() }),
            RESOLVERS,
        );
        expect(event.kind).toBe('created');
        expect(event.summary).toContain('Justin created this transaction');
        expect(event.summary).toContain('Expenses:Food $120.00');
    });

    it('says nothing field-level about a delete', () => {
        const event = renderAuditRow(
            row({ id: 4, action: 'DELETE', old_values: snapshot(), new_values: null }),
            RESOLVERS,
        );
        expect(event.summary).toBe('Justin deleted this transaction');
        expect(event.changes).toEqual([]);
    });

    it('shows an unresolvable account guid as a truncated guid, never as a crash', () => {
        const after = snapshot({ splits: [split({ account_guid: 'f'.repeat(32) })] });
        const event = renderAuditRow(row({ old_values: snapshot({ splits: [split()] }), new_values: after }), {});
        expect(event.changes[0].after).toBe('account ffffffff…');
    });

    it('caps how many changes a single sentence names', () => {
        const after = snapshot({
            description: 'Changed',
            num: '1042',
            post_date: '2026-08-05T00:00:00.000Z',
            splits: [
                split({ account_guid: ACCT_GROCERIES, memo: 'note', value_num: '10200', quantity_num: '10200' }),
                split({ guid: SPLIT_B, account_guid: ACCT_CHECKING, value_num: '-10200', quantity_num: '-10200' }),
            ],
        });
        const event = renderAuditRow(row({ old_values: snapshot(), new_values: after }), RESOLVERS);
        expect(event.summary).toContain('more changes');
        expect(event.changes.length).toBeGreaterThan(4);
    });

    it('flags an entry that has been undone', () => {
        const event = renderAuditRow(
            row({ old_values: snapshot(), new_values: snapshot({ description: 'x' }), undone_at: new Date() }),
            RESOLVERS,
        );
        expect(event.undone).toBe(true);
    });
});

describe('renderAuditRow — non-snapshot payloads', () => {
    it('diffs a legacy shallow payload key by key', () => {
        const event = renderAuditRow(
            row({
                old_values: { description: 'Old', splits_count: 2 },
                new_values: { description: 'New', splits_count: 3 },
            }),
            RESOLVERS,
        );
        expect(event.changes).toEqual([
            { field: 'description', label: 'description', before: 'Old', after: 'New' },
            { field: 'splits_count', label: 'splits count', before: '2', after: '3' },
        ]);
    });

    it('ignores the actor keys it already used for attribution', () => {
        const event = renderAuditRow(
            row({
                user_id: null,
                action: 'CREATE',
                old_values: null,
                new_values: { source: 'inbound_webhook', description: 'Vendor payment', amount: 25 },
            }),
            RESOLVERS,
        );
        expect(event.changes.map(change => change.field)).toEqual(['amount', 'description']);
        expect(event.summary.startsWith('Inbound webhook created this transaction')).toBe(true);
    });
});

describe('buildTransactionHistory', () => {
    it('orders events oldest first, breaking ties on audit id', () => {
        const at = new Date('2026-08-19T14:02:00.000Z');
        const events = buildTransactionHistory([
            row({ id: 5, created_at: new Date('2026-08-20T09:00:00.000Z'), old_values: snapshot(), new_values: snapshot({ num: '2' }) }),
            row({ id: 3, created_at: at, action: 'CREATE', old_values: null, new_values: snapshot() }),
            row({ id: 2, created_at: at, entity_type: 'SPLIT', entity_guid: SPLIT_A, old_values: { memo: '' }, new_values: { memo: 'checked' } }),
        ], RESOLVERS);
        expect(events.map(event => event.auditId)).toEqual([2, 3, 5]);
    });

    it('carries split-level entries into the same timeline', () => {
        const [event] = buildTransactionHistory([
            row({ id: 8, entity_type: 'SPLIT', entity_guid: SPLIT_A, old_values: { memo: '' }, new_values: { memo: 'checked' } }),
        ], RESOLVERS);
        expect(event.entityType).toBe('SPLIT');
        expect(event.summary).toBe('Justin set memo to checked');
    });
});

describe('currency (H1)', () => {
    it('renders amounts in the transaction currency the caller supplies', () => {
        const after = snapshot({ splits: [split({ value_num: '10200' })] });
        const event = renderAuditRow(
            row({ old_values: snapshot({ splits: [split()] }), new_values: after }),
            { ...RESOLVERS, currency: 'EUR' },
        );
        const amount = event.changes.find(change => change.field === 'amount')!;
        expect(amount.before).toContain('€');
        expect(amount.after).toContain('€');
        expect(event.summary).not.toContain('$');
    });

    it('still defaults to USD when nothing is supplied', () => {
        const after = snapshot({ splits: [split({ value_num: '10200' })] });
        const event = renderAuditRow(row({ old_values: snapshot({ splits: [split()] }), new_values: after }), RESOLVERS);
        expect(event.changes[0].after).toBe('$102.00');
    });
});

describe('share legs vs cross-currency cash legs (H2)', () => {
    const ACCT_BROKERAGE = '4'.repeat(32);

    /** value ≠ quantity on both: one is shares, the other is EUR cash. */
    const shareLeg = (quantityNum: string) => split({
        account_guid: ACCT_BROKERAGE,
        value_num: '100000',
        quantity_num: quantityNum,
        quantity_denom: '1',
    });
    const euroCashLeg = (quantityNum: string) => split({
        account_guid: ACCT_CHECKING,
        value_num: '12000',
        value_denom: '100',
        quantity_num: quantityNum,
        quantity_denom: '100',
    });

    const namespaces = {
        ...RESOLVERS,
        accountNamespace: (guid: string) => ({
            [ACCT_BROKERAGE]: 'NASDAQ',
            [ACCT_CHECKING]: 'CURRENCY',
            [ACCT_FOOD]: 'CURRENCY',
        }[guid]),
    };

    it('names shares on a non-CURRENCY account', () => {
        const event = renderAuditRow(row({
            old_values: snapshot({ splits: [shareLeg('10')] }),
            new_values: snapshot({ splits: [shareLeg('12')] }),
        }), namespaces);
        expect(event.changes).toEqual([
            { field: 'quantity', label: 'shares', before: '10', after: '12', splitGuid: SPLIT_A },
        ]);
    });

    it('never names shares on a cross-currency CASH split', () => {
        // The regression: value is in the transaction currency and quantity in
        // the account's, so value ≠ quantity on every FX cash leg.
        const event = renderAuditRow(row({
            old_values: snapshot({ splits: [euroCashLeg('10500')] }),
            new_values: snapshot({ splits: [euroCashLeg('10600')] }),
        }), namespaces);
        expect(event.changes.map(change => change.field)).not.toContain('quantity');
    });

    it('without a namespace resolver, still refuses an FX cash split', () => {
        const event = renderAuditRow(row({
            old_values: snapshot({ splits: [euroCashLeg('10500')] }),
            new_values: snapshot({ splits: [euroCashLeg('10600')] }),
        }), RESOLVERS);
        expect(event.changes.map(change => change.field)).not.toContain('quantity');
    });

    it('without a namespace resolver, still names a whole-share change', () => {
        const event = renderAuditRow(row({
            old_values: snapshot({ splits: [shareLeg('10')] }),
            new_values: snapshot({ splits: [shareLeg('12')] }),
        }), RESOLVERS);
        expect(event.changes.map(change => change.field)).toContain('quantity');
    });
});

describe('post-date rendering (L5)', () => {
    it('does not shift the day for a space-form timestamp at a positive UTC offset', () => {
        // `new Date('2026-08-01 00:00:00')` parses as LOCAL time; converting it
        // back through toISOString() lands on 2026-07-31 anywhere east of UTC.
        const event = renderAuditRow(row({
            old_values: snapshot({ post_date: '2026-08-01 00:00:00' }),
            new_values: snapshot({ post_date: '2026-08-02 00:00:00' }),
        }), RESOLVERS);
        expect(event.changes).toEqual([
            { field: 'post_date', label: 'date', before: '2026-08-01', after: '2026-08-02' },
        ]);
    });

    it('reports no change when the same day is written two ways', () => {
        const event = renderAuditRow(row({
            old_values: snapshot({ post_date: '2026-08-01 00:00:00' }),
            new_values: snapshot({ post_date: '2026-08-01T00:00:00.000Z' }),
        }), RESOLVERS);
        expect(event.changes).toEqual([]);
    });
});

describe('guid-less splits (L6)', () => {
    it('diffs every split when none of them carry a guid', () => {
        const bare = (overrides: Record<string, unknown>) => {
            const { guid: _guid, ...rest } = split(overrides);
            void _guid;
            return rest;
        };
        const event = renderAuditRow(row({
            old_values: snapshot({ splits: [bare({ value_num: '12000' }), bare({ account_guid: ACCT_CHECKING, value_num: '-12000' })] }),
            new_values: snapshot({ splits: [bare({ value_num: '10200' }), bare({ account_guid: ACCT_CHECKING, value_num: '-10200' })] }),
        }), RESOLVERS);
        // Both lines diff; keyed on '' they collapsed onto one another and only
        // the last survived.
        expect(event.changes).toEqual([
            { field: 'amount', label: 'amount', before: '$120.00', after: '$102.00', splitGuid: undefined },
            { field: 'amount', label: 'amount', before: '-$120.00', after: '-$102.00', splitGuid: undefined },
        ]);
    });
});

describe('joinPhrases', () => {
    it('joins one, two and many', () => {
        expect(joinPhrases([])).toBe('');
        expect(joinPhrases(['a'])).toBe('a');
        expect(joinPhrases(['a', 'b'])).toBe('a and b');
        expect(joinPhrases(['a', 'b', 'c'])).toBe('a, b and c');
    });
});

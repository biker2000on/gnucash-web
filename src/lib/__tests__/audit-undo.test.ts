import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/prisma', () => ({
    default: {},
}));
vi.mock('@/lib/auth', () => ({
    getCurrentUser: vi.fn().mockResolvedValue(null),
}));

import { buildUndoPlan, isTransactionSnapshot, type TransactionSnapshot } from '../services/audit.service';

const snapshot: TransactionSnapshot = {
    snapshotVersion: 1,
    guid: 'a'.repeat(32),
    currency_guid: 'c'.repeat(32),
    num: '',
    post_date: '2026-05-01T00:00:00.000Z',
    enter_date: '2026-05-01T12:00:00.000Z',
    description: 'Groceries',
    splits: [
        {
            guid: 's1'.padEnd(32, '0'),
            account_guid: 'x'.repeat(32),
            memo: '',
            action: '',
            reconcile_state: 'n',
            reconcile_date: null,
            value_num: '-5000',
            value_denom: '100',
            quantity_num: '-5000',
            quantity_denom: '100',
            lot_guid: null,
        },
        {
            guid: 's2'.padEnd(32, '0'),
            account_guid: 'y'.repeat(32),
            memo: '',
            action: '',
            reconcile_state: 'n',
            reconcile_date: null,
            value_num: '5000',
            value_denom: '100',
            quantity_num: '5000',
            quantity_denom: '100',
            lot_guid: null,
        },
    ],
};

describe('isTransactionSnapshot', () => {
    it('accepts a v1 snapshot and rejects legacy shallow payloads', () => {
        expect(isTransactionSnapshot(snapshot)).toBe(true);
        expect(isTransactionSnapshot({ description: 'x', splits_count: 2 })).toBe(false);
        expect(isTransactionSnapshot(null)).toBe(false);
        expect(isTransactionSnapshot('str')).toBe(false);
    });
});

describe('buildUndoPlan', () => {
    const base = { entity_type: 'TRANSACTION', entity_guid: snapshot.guid };

    it('DELETE with full snapshot → restore plan', () => {
        const { plan } = buildUndoPlan({ ...base, action: 'DELETE', old_values: snapshot, new_values: null });
        expect(plan).toEqual({ kind: 'restore_deleted', snapshot });
    });

    it('UPDATE with full snapshot → revert plan using the BEFORE image', () => {
        const after = { ...snapshot, description: 'Changed' };
        const { plan } = buildUndoPlan({ ...base, action: 'UPDATE', old_values: snapshot, new_values: after });
        expect(plan?.kind).toBe('revert_update');
        if (plan?.kind === 'revert_update') {
            expect(plan.snapshot.description).toBe('Groceries');
        }
    });

    it('CREATE → delete plan keyed on the entity guid', () => {
        const { plan } = buildUndoPlan({ ...base, action: 'CREATE', old_values: null, new_values: snapshot });
        expect(plan).toEqual({ kind: 'delete_created', guid: snapshot.guid });
    });

    it('legacy shallow DELETE/UPDATE entries are not undoable, with a reason', () => {
        const legacy = { description: 'x', post_date: '2024-01-01', splits_count: 2 };
        const del = buildUndoPlan({ ...base, action: 'DELETE', old_values: legacy, new_values: null });
        expect(del.plan).toBeNull();
        expect(del.reason).toMatch(/predates/);
        const upd = buildUndoPlan({ ...base, action: 'UPDATE', old_values: legacy, new_values: legacy });
        expect(upd.plan).toBeNull();
    });

    it('non-transaction entities are not undoable', () => {
        const { plan, reason } = buildUndoPlan({
            entity_type: 'ACCOUNT',
            entity_guid: 'z'.repeat(32),
            action: 'DELETE',
            old_values: { name: 'Acct' },
            new_values: null,
        });
        expect(plan).toBeNull();
        expect(reason).toMatch(/transaction/i);
    });
});

import { describe, it, expect, vi } from 'vitest';

// bucketPnlByTag is pure; stub prisma so importing the module never touches a DB.
vi.mock('@/lib/prisma', () => ({ default: {} }));

import { bucketPnlByTag, UNTAGGED_LABEL, type TagAggRow } from '../pnl-by-tag';

function agg(over: Partial<TagAggRow>): TagAggRow {
    return {
        tagId: 1,
        tagName: 'client-a',
        tagColor: '#2dd4bf',
        accountType: 'EXPENSE',
        total: 0,
        ...over,
    };
}

describe('bucketPnlByTag', () => {
    it('sign-corrects income (stored negative in GnuCash) to positive', () => {
        const rows = bucketPnlByTag([
            agg({ tagId: 1, tagName: 'client-a', accountType: 'INCOME', total: -1200 }),
            agg({ tagId: 1, tagName: 'client-a', accountType: 'EXPENSE', total: 300 }),
        ]);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            tag: 'client-a',
            income: 1200,
            expenses: 300,
            net: 900,
        });
    });

    it('buckets untagged activity (null tagId) under Untagged with no color', () => {
        const rows = bucketPnlByTag([
            agg({ tagId: null, tagName: null, tagColor: null, accountType: 'EXPENSE', total: 50 }),
            agg({ tagId: null, tagName: null, tagColor: null, accountType: 'INCOME', total: -75 }),
        ]);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            tagId: null,
            tag: UNTAGGED_LABEL,
            color: null,
            income: 75,
            expenses: 50,
            net: 25,
        });
    });

    it('counts a multi-tag transaction fully under each tag (rows come pre-fanned-out)', () => {
        // One $100 expense transaction tagged both 'client-a' and 'client-b':
        // the SQL fan-out yields one aggregate row per tag, each at full value.
        const rows = bucketPnlByTag([
            agg({ tagId: 1, tagName: 'client-a', accountType: 'EXPENSE', total: 100 }),
            agg({ tagId: 2, tagName: 'client-b', accountType: 'EXPENSE', total: 100 }),
        ]);
        expect(rows).toHaveLength(2);
        expect(rows.find(r => r.tag === 'client-a')?.expenses).toBe(100);
        expect(rows.find(r => r.tag === 'client-b')?.expenses).toBe(100);
        // Documented consequence: per-tag sum (200) exceeds the true total (100).
        expect(rows.reduce((s, r) => s + r.expenses, 0)).toBe(200);
    });

    it('sorts tags alphabetically with Untagged last', () => {
        const rows = bucketPnlByTag([
            agg({ tagId: null, tagName: null, accountType: 'EXPENSE', total: 1 }),
            agg({ tagId: 2, tagName: 'zebra', accountType: 'EXPENSE', total: 1 }),
            agg({ tagId: 1, tagName: 'alpha', accountType: 'EXPENSE', total: 1 }),
        ]);
        expect(rows.map(r => r.tag)).toEqual(['alpha', 'zebra', UNTAGGED_LABEL]);
    });

    it('drops tags with zero activity in both columns', () => {
        const rows = bucketPnlByTag([
            agg({ tagId: 1, tagName: 'dormant', accountType: 'EXPENSE', total: 0 }),
            agg({ tagId: 2, tagName: 'active', accountType: 'EXPENSE', total: 10 }),
        ]);
        expect(rows.map(r => r.tag)).toEqual(['active']);
    });

    it('merges multiple aggregate rows for the same tag (income + expense)', () => {
        const rows = bucketPnlByTag([
            agg({ tagId: 3, tagName: 'shop', accountType: 'INCOME', total: -500 }),
            agg({ tagId: 3, tagName: 'shop', accountType: 'EXPENSE', total: 120 }),
            agg({ tagId: 3, tagName: 'shop', accountType: 'EXPENSE', total: 30 }),
        ]);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ income: 500, expenses: 150, net: 350 });
    });

    it('ignores non-P&L account types defensively', () => {
        const rows = bucketPnlByTag([
            agg({ tagId: 1, tagName: 'client-a', accountType: 'ASSET', total: 999 }),
            agg({ tagId: 1, tagName: 'client-a', accountType: 'EXPENSE', total: 10 }),
        ]);
        expect(rows[0]).toMatchObject({ income: 0, expenses: 10 });
    });

    it('keeps a tag whose income and expenses offset to zero net', () => {
        const rows = bucketPnlByTag([
            agg({ tagId: 1, tagName: 'wash', accountType: 'INCOME', total: -100 }),
            agg({ tagId: 1, tagName: 'wash', accountType: 'EXPENSE', total: 100 }),
        ]);
        expect(rows).toHaveLength(1);
        expect(rows[0].net).toBe(0);
    });
});

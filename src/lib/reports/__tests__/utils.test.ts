import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockQueryRaw = vi.fn();

vi.mock('@/lib/prisma', () => ({
    default: {
        $queryRaw: (...args: unknown[]) => mockQueryRaw(...args),
    },
}));

import { sumSplitsByAccount } from '../utils';

beforeEach(() => {
    mockQueryRaw.mockReset();
});

describe('sumSplitsByAccount', () => {
    it('guards numeric per-split division and final float8 cast placement', async () => {
        // This is a query-text guard: PostgreSQL exercises the numeric
        // behavior. Seven 1/7 numeric quotients round just below one, then
        // the one final float8 conversion rounds the completed aggregate to 1.
        mockQueryRaw.mockResolvedValue([
            {
                account_guid: 'checking',
                quantity_sum: 1,
                value_sum: 1,
            },
        ]);

        const sums = await sumSplitsByAccount(['checking'], {});
        const checking = sums.get('checking')!;

        // The mapper passes number rows through unchanged; these are not
        // precision assertions.
        expect(checking.quantity).toBe(1);
        expect(checking.value).toBe(1);

        const sql = (mockQueryRaw.mock.calls[0][0] as TemplateStringsArray).join('');
        expect(sql).toContain('s.quantity_num::numeric / NULLIF(s.quantity_denom, 0)::numeric');
        expect(sql).toContain('s.value_num::numeric / NULLIF(s.value_denom, 0)::numeric');
        expect(sql).toContain(')::float8 AS quantity_sum');
        expect(sql).toContain(')::float8 AS value_sum');
    });
});

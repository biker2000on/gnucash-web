import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockQueryRaw = vi.fn();

vi.mock('@/lib/prisma', () => ({
    default: {
        $queryRaw: (...args: unknown[]) => mockQueryRaw(...args),
    },
}));

import { numericToNumber, sumSplitsByAccount } from '../utils';

beforeEach(() => {
    mockQueryRaw.mockReset();
});

describe('sumSplitsByAccount', () => {
    it('uses exact numeric aggregation and preserves the driver numeric string', async () => {
        // PostgreSQL numeric can sum 100 one-tenth splits to this exact value.
        // The equivalent IEEE-754 accumulation is not exactly 10.
        const float8Result = Array.from({ length: 100 }, () => 0.1)
            .reduce((sum, value) => sum + value, 0);
        expect(float8Result).not.toBe(10);

        mockQueryRaw.mockResolvedValue([
            {
                account_guid: 'checking',
                quantity_sum: '10.00000000000000000000',
                value_sum: '10.00000000000000000000',
            },
        ]);

        const sums = await sumSplitsByAccount(['checking'], {});
        const checking = sums.get('checking')!;

        // Do not parseFloat at the query boundary: preserve the database value
        // until a number-valued report output explicitly needs it.
        expect(checking.quantity).toBe('10.00000000000000000000');
        expect(checking.value).toBe('10.00000000000000000000');
        expect(numericToNumber(checking.quantity)).toBe(10);

        const sql = (mockQueryRaw.mock.calls[0][0] as TemplateStringsArray).join('');
        expect(sql).toContain('s.quantity_num::numeric / NULLIF(s.quantity_denom, 0)::numeric');
        expect(sql).toContain('s.value_num::numeric / NULLIF(s.value_denom, 0)::numeric');
        expect(sql).not.toMatch(/float8|double precision/i);
    });
});

import { describe, expect, it, vi } from 'vitest';
import { invalidateTransactionAccountCaches } from '../AccountLedger';

describe('invalidateTransactionAccountCaches', () => {
    it('invalidates the same account-derived queries as a transaction event', async () => {
        const invalidateQueries = vi.fn().mockResolvedValue(undefined);

        await invalidateTransactionAccountCaches({ invalidateQueries });

        expect(invalidateQueries.mock.calls).toEqual([
            [{ queryKey: ['accounts', 'balances'] }],
            [{ queryKey: ['accounts', 'reconcile-summary'] }],
            [{ queryKey: ['accounts', 'review-status'] }],
        ]);
    });
});

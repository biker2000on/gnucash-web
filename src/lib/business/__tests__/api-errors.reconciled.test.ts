/**
 * The business API error mappers must surface a blocked reconciled/frozen
 * split as 423 RECONCILED_SPLIT — not as the generic 500 that would hide the
 * reason from the user. These mappers are the only error path for the invoice
 * unpost and package lifecycle routes, both of which delete ledger
 * transactions.
 */
import { describe, expect, it } from 'vitest';

import { mapInvoiceError, mapPackageError, mapRecurringError } from '../api-errors';
import { ReconciledSplitError } from '@/lib/services/reconciled-split.service';

const SPLIT_GUID = 's'.repeat(32);
const TX_GUID = 't'.repeat(32);

function blocked(operation: string, state: 'y' | 'f') {
    return new ReconciledSplitError(operation, [{
        splitGuid: SPLIT_GUID,
        txGuid: TX_GUID,
        accountGuid: 'a'.repeat(32),
        accountName: 'Assets:Checking',
        reconcileState: state,
    }]);
}

describe.each([
    ['mapInvoiceError', mapInvoiceError, 'unpost this invoice'],
    ['mapRecurringError', mapRecurringError, 'unpost this invoice'],
    ['mapPackageError', mapPackageError, 'delete this transaction'],
])('%s', (_name, map, operation) => {
    it.each([
        ['reconciled', 'y'],
        ['frozen', 'f'],
    ])('maps a %s split block to 423 naming the split', async (_label, state) => {
        const response = map(blocked(operation, state as 'y' | 'f'));
        const body = await response.json();

        expect(response.status).toBe(423);
        expect(body.code).toBe('RECONCILED_SPLIT');
        expect(body.error).toContain(SPLIT_GUID);
        expect(body.error).toContain('Assets:Checking');
        expect(body.error).toContain(operation);
        expect(body.error).toMatch(/unreconcile/i);
        expect(body.splits).toEqual([{
            guid: SPLIT_GUID,
            tx_guid: TX_GUID,
            account_guid: 'a'.repeat(32),
            reconcile_state: state,
        }]);
    });

    it('still falls through to 500 for unrelated failures', async () => {
        const response = map(new Error('boom'));
        expect(response.status).toBe(500);
    });
});

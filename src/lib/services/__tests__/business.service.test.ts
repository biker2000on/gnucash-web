import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
    customers, vendors, jobs, billterms, taxtables, taxtable_entries,
    invoices, entries, commodities, accounts,
} = vi.hoisted(() => {
    const model = (...methods: string[]) =>
        Object.fromEntries(methods.map(m => [m, vi.fn()]));
    return {
        customers: model('findUnique', 'findFirst', 'findMany', 'create', 'update', 'updateMany', 'delete', 'count'),
        vendors: model('findUnique', 'findMany', 'update', 'delete', 'count'),
        jobs: model('findUnique', 'findMany', 'update', 'delete', 'count', 'groupBy'),
        billterms: model('findUnique', 'findFirst', 'findMany', 'create', 'update', 'updateMany', 'delete'),
        taxtables: model('findUnique', 'findFirst', 'findMany', 'update', 'updateMany', 'delete'),
        taxtable_entries: model('findMany', 'deleteMany', 'createMany'),
        invoices: model('count'),
        entries: model('count'),
        commodities: model('findFirst', 'findMany'),
        accounts: model('findMany'),
    };
});

vi.mock('@/lib/prisma', () => ({
    default: {
        customers,
        vendors,
        jobs,
        billterms,
        taxtables,
        taxtable_entries,
        invoices,
        entries,
        commodities,
        accounts,
        $transaction: vi.fn(async (ops: unknown[]) => Promise.all(ops as Promise<unknown>[])),
    },
}));

import {
    nextEntityId,
    percentToFraction,
    currencyToFraction,
    fractionToNumber,
    parseInput,
    customerInputSchema,
    billtermInputSchema,
    taxtableInputSchema,
    jobInputSchema,
    BusinessValidationError,
    deleteCustomer,
    deleteBillterm,
    deleteJob,
    PERCENT_DENOM,
    CURRENCY_DENOM,
} from '../business.service';

function resetAll() {
    for (const model of [customers, vendors, jobs, billterms, taxtables, taxtable_entries, invoices, entries, commodities, accounts]) {
        for (const fn of Object.values(model)) (fn as ReturnType<typeof vi.fn>).mockReset();
    }
}

const GUID = 'a'.repeat(32);

describe('nextEntityId', () => {
    it('starts at 000001 for an empty table', () => {
        expect(nextEntityId([])).toBe('000001');
    });

    it('increments the max and zero-pads to 6 digits', () => {
        expect(nextEntityId(['000001', '000002'])).toBe('000003');
        expect(nextEntityId(['000009'])).toBe('000010');
    });

    it('does not reuse gaps — always max + 1', () => {
        expect(nextEntityId(['000001', '000005'])).toBe('000006');
    });

    it('ignores non-numeric ids', () => {
        expect(nextEntityId(['CUST-A', '', '  ', '000002', 'x9'])).toBe('000003');
        expect(nextEntityId(['CUST-A'])).toBe('000001');
    });

    it('handles unpadded numeric ids and widths beyond 6 digits', () => {
        expect(nextEntityId(['7'])).toBe('000008');
        expect(nextEntityId(['1234567'])).toBe('1234568');
    });
});

describe('fraction round-trips', () => {
    it('stores percents with denom 10000 and round-trips exactly', () => {
        const f = percentToFraction(8.25);
        expect(f).toEqual({ num: 82500n, denom: BigInt(PERCENT_DENOM) });
        expect(fractionToNumber(f.num, f.denom)).toBe(8.25);
    });

    it('stores currency amounts with denom 100 and round-trips exactly', () => {
        const f = currencyToFraction(1500.5);
        expect(f).toEqual({ num: 150050n, denom: BigInt(CURRENCY_DENOM) });
        expect(fractionToNumber(f.num, f.denom)).toBe(1500.5);
    });

    it('handles zero and rounds sub-precision input', () => {
        expect(percentToFraction(0)).toEqual({ num: 0n, denom: 10000n });
        // 4 decimal places is the percent precision; extra digits round
        expect(percentToFraction(1.23456).num).toBe(12346n);
    });

    it('returns 0 for null fraction parts', () => {
        expect(fractionToNumber(null, 100n)).toBe(0);
    });
});

describe('validation', () => {
    it('rejects a customer without a name', () => {
        expect(() => parseInput(customerInputSchema, { name: '  ' }))
            .toThrow(BusinessValidationError);
    });

    it('rejects a discount above 100 percent', () => {
        expect(() => parseInput(customerInputSchema, { name: 'Acme', discount: 101 }))
            .toThrow(BusinessValidationError);
    });

    it('rejects malformed guids for terms', () => {
        expect(() => parseInput(customerInputSchema, { name: 'Acme', terms: 'not-a-guid' }))
            .toThrow(BusinessValidationError);
    });

    it('applies defaults for a minimal valid customer', () => {
        const input = parseInput(customerInputSchema, { name: 'Acme Corp' });
        expect(input).toMatchObject({
            name: 'Acme Corp',
            currency: 'USD',
            active: true,
            discount: 0,
            credit: 0,
        });
    });

    it('rejects negative or non-integer due days on bill terms', () => {
        expect(() => parseInput(billtermInputSchema, { name: 'Net 30', dueDays: -1 }))
            .toThrow(BusinessValidationError);
        expect(() => parseInput(billtermInputSchema, { name: 'Net 30', dueDays: 30.5 }))
            .toThrow(BusinessValidationError);
    });

    it('requires at least one taxtable entry', () => {
        expect(() => parseInput(taxtableInputSchema, { name: 'Sales Tax', entries: [] }))
            .toThrow(BusinessValidationError);
    });

    it('rejects invalid taxtable entry types', () => {
        expect(() => parseInput(taxtableInputSchema, {
            name: 'Sales Tax',
            entries: [{ account: GUID, amount: 5, type: 'ratio' }],
        })).toThrow(BusinessValidationError);
    });

    it('restricts job owner types to customer or vendor', () => {
        expect(() => parseInput(jobInputSchema, { name: 'Job', ownerType: 'employee', ownerGuid: GUID }))
            .toThrow(BusinessValidationError);
        const ok = parseInput(jobInputSchema, { name: 'Job', ownerType: 'vendor', ownerGuid: GUID });
        expect(ok.ownerType).toBe('vendor');
    });
});

describe('deactivate-not-delete', () => {
    beforeEach(resetAll);

    it('deactivates a customer referenced by jobs instead of deleting', async () => {
        customers.findUnique.mockResolvedValue({ guid: GUID, terms: null, taxtable: null });
        jobs.count.mockResolvedValue(2);
        invoices.count.mockResolvedValue(0);

        const result = await deleteCustomer(GUID);

        expect(result).toEqual({ deleted: false, deactivated: true });
        expect(customers.update).toHaveBeenCalledWith({
            where: { guid: GUID },
            data: { active: 0 },
        });
        expect(customers.delete).not.toHaveBeenCalled();
    });

    it('hard-deletes an unreferenced customer', async () => {
        customers.findUnique.mockResolvedValue({ guid: GUID, terms: null, taxtable: null });
        jobs.count.mockResolvedValue(0);
        invoices.count.mockResolvedValue(0);

        const result = await deleteCustomer(GUID);

        expect(result).toEqual({ deleted: true, deactivated: false });
        expect(customers.delete).toHaveBeenCalledWith({ where: { guid: GUID } });
        expect(customers.update).not.toHaveBeenCalled();
    });

    it('returns null for a missing customer', async () => {
        customers.findUnique.mockResolvedValue(null);
        expect(await deleteCustomer(GUID)).toBeNull();
    });

    it('hides referenced bill terms (invisible=1) instead of deleting', async () => {
        billterms.findUnique
            .mockResolvedValueOnce({ guid: GUID, refcount: 0 })   // existence check
            .mockResolvedValueOnce({ refcount: 3 });              // post-recompute read
        customers.count.mockResolvedValue(2);
        vendors.count.mockResolvedValue(1);
        invoices.count.mockResolvedValue(0);

        const result = await deleteBillterm(GUID);

        expect(result).toEqual({ deleted: false, deactivated: true });
        expect(billterms.update).toHaveBeenCalledWith({
            where: { guid: GUID },
            data: { invisible: 1 },
        });
        expect(billterms.delete).not.toHaveBeenCalled();
    });

    it('hard-deletes unreferenced bill terms', async () => {
        billterms.findUnique
            .mockResolvedValueOnce({ guid: GUID, refcount: 0 })
            .mockResolvedValueOnce({ refcount: 0 });
        customers.count.mockResolvedValue(0);
        vendors.count.mockResolvedValue(0);
        invoices.count.mockResolvedValue(0);

        const result = await deleteBillterm(GUID);

        expect(result).toEqual({ deleted: true, deactivated: false });
        expect(billterms.delete).toHaveBeenCalledWith({ where: { guid: GUID } });
    });

    it('deactivates a job referenced by invoices instead of deleting', async () => {
        jobs.findUnique.mockResolvedValue({ guid: GUID });
        invoices.count.mockResolvedValue(1);

        const result = await deleteJob(GUID);

        expect(result).toEqual({ deleted: false, deactivated: true });
        expect(jobs.update).toHaveBeenCalledWith({
            where: { guid: GUID },
            data: { active: 0 },
        });
        expect(jobs.delete).not.toHaveBeenCalled();
    });
});

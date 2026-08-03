/**
 * Cross-book isolation for the native GnuCash business tables.
 *
 * These tables have no book_guid column, so ownership lives in
 * gnucash_web_business_entity_ownership. The rule under test: an entity this
 * book does not own is INVISIBLE — lists omit it, single reads return null,
 * and writes behave exactly as not-found. Missing ownership counts as foreign.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { db, customers, vendors, jobs, ownership, commodities } = vi.hoisted(() => {
    const model = (...methods: string[]) =>
        Object.fromEntries(methods.map(m => [m, vi.fn()]));
    const models = {
        customers: model('findUnique', 'findFirst', 'findMany', 'create', 'update', 'delete', 'count'),
        vendors: model('findUnique', 'findFirst', 'findMany', 'create', 'update', 'delete', 'count'),
        jobs: model('findUnique', 'findMany', 'create', 'update', 'delete', 'count', 'groupBy'),
        billterms: model('findUnique', 'findFirst', 'findMany', 'create', 'update', 'updateMany', 'delete'),
        taxtables: model('findUnique', 'findFirst', 'findMany', 'update', 'updateMany', 'delete'),
        taxtable_entries: model('findMany', 'deleteMany', 'createMany'),
        invoices: model('count'),
        entries: model('count'),
        commodities: model('findFirst', 'findMany'),
        accounts: model('findMany'),
        gnucash_web_business_entity_ownership: model('findUnique', 'findMany', 'create', 'deleteMany'),
    };
    const db = {
        ...models,
        $transaction: vi.fn(async (arg: unknown) =>
            typeof arg === 'function'
                ? (arg as (tx: unknown) => Promise<unknown>)(db)
                : Promise.all(arg as Promise<unknown>[])),
    };
    return { ...models, ownership: models.gnucash_web_business_entity_ownership, db };
});

vi.mock('@/lib/prisma', () => ({ default: db }));

import {
    listCustomers,
    getCustomer,
    createCustomer,
    updateCustomer,
    deleteCustomer,
    listVendors,
    getVendor,
    listJobs,
    getJob,
    createJob,
    updateJob,
    deleteJob,
    BusinessValidationError,
    parseInput,
    customerInputSchema,
    jobInputSchema,
    recomputeBilltermRefcount,
} from '../business.service';

const BOOK_A = 'a'.repeat(32);
const BOOK_B = 'b'.repeat(32);
const CUSTOMER_A = '1'.repeat(32);
const CUSTOMER_B = '2'.repeat(32);
const JOB_A = '3'.repeat(32);
const JOB_B = '4'.repeat(32);
const CURRENCY_GUID = '9'.repeat(32);

/**
 * Wire the ownership side table from a plain map of
 * `${entity_type}:${entity_guid}` -> owning book. Anything absent is foreign,
 * which is the semantic under test.
 */
function seedOwnership(owners: Record<string, string>) {
    ownership.findUnique.mockImplementation(async (args: {
        where: { entity_type_entity_guid: { entity_type: string; entity_guid: string } };
    }) => {
        const { entity_type, entity_guid } = args.where.entity_type_entity_guid;
        const book = owners[`${entity_type}:${entity_guid}`];
        return book ? { book_guid: book } : null;
    });
    ownership.findMany.mockImplementation(async (args: {
        where: { entity_type: string; book_guid: string };
    }) => Object.entries(owners)
        .filter(([key, book]) =>
            key.startsWith(`${args.where.entity_type}:`) && book === args.where.book_guid)
        .map(([key]) => ({ entity_guid: key.split(':')[1] })));
}

function resetAll() {
    for (const model of Object.values(db)) {
        if (typeof model === 'function') continue;
        for (const fn of Object.values(model as Record<string, unknown>)) {
            (fn as ReturnType<typeof vi.fn>).mockReset();
        }
    }
    db.$transaction.mockClear();
    commodities.findMany.mockResolvedValue([]);
    jobs.groupBy.mockResolvedValue([]);
    jobs.findMany.mockResolvedValue([]);
}

const CUSTOMER_ROW = {
    guid: CUSTOMER_A,
    id: '000001',
    name: 'Book A Customer',
    notes: '',
    active: 1,
    discount_num: 0n,
    discount_denom: 100n,
    credit_num: 0n,
    credit_denom: 100n,
    currency: CURRENCY_GUID,
    tax_override: 0,
    tax_included: 0,
    terms: null,
    taxtable: null,
};

describe('customer book scope', () => {
    beforeEach(resetAll);

    it('omits another book\'s customer from the list', async () => {
        seedOwnership({
            [`customer:${CUSTOMER_A}`]: BOOK_A,
            [`customer:${CUSTOMER_B}`]: BOOK_B,
        });
        customers.findMany.mockResolvedValue([CUSTOMER_ROW]);

        const rows = await listCustomers(BOOK_A);

        expect(rows.map(r => r.guid)).toEqual([CUSTOMER_A]);
        // Scoping is a join against the ownership view, so the constraint rides
        // in the query itself rather than as a materialized guid list.
        expect(customers.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ ownership: { book_guid: BOOK_A } }),
            }),
        );
    });

    it('never issues an unfiltered query, even when the book owns nothing', async () => {
        seedOwnership({ [`customer:${CUSTOMER_B}`]: BOOK_B });
        customers.findMany.mockResolvedValue([]);

        expect(await listCustomers(BOOK_A)).toEqual([]);
        // The join is what returns nothing; what must never happen is a query
        // that omits the ownership constraint.
        for (const call of customers.findMany.mock.calls) {
            expect(call[0].where).toMatchObject({ ownership: { book_guid: BOOK_A } });
        }
    });

    it('returns null for a customer owned by another book', async () => {
        seedOwnership({ [`customer:${CUSTOMER_B}`]: BOOK_B });
        customers.findUnique.mockResolvedValue({ ...CUSTOMER_ROW, guid: CUSTOMER_B });

        expect(await getCustomer(BOOK_A, CUSTOMER_B)).toBeNull();
        expect(customers.findUnique).not.toHaveBeenCalled();
    });

    it('treats an unattributed customer as foreign', async () => {
        seedOwnership({});
        customers.findUnique.mockResolvedValue(CUSTOMER_ROW);

        expect(await getCustomer(BOOK_A, CUSTOMER_A)).toBeNull();
    });

    it('updates a foreign customer as not-found and writes nothing', async () => {
        seedOwnership({ [`customer:${CUSTOMER_B}`]: BOOK_B });
        const input = parseInput(customerInputSchema, { name: 'Renamed' });

        expect(await updateCustomer(BOOK_A, CUSTOMER_B, input)).toBeNull();
        expect(customers.update).not.toHaveBeenCalled();
    });

    it('deletes a foreign customer as not-found and writes nothing', async () => {
        seedOwnership({ [`customer:${CUSTOMER_B}`]: BOOK_B });

        expect(await deleteCustomer(BOOK_A, CUSTOMER_B)).toBeNull();
        expect(customers.delete).not.toHaveBeenCalled();
        expect(customers.update).not.toHaveBeenCalled();
    });

    it('records ownership for the creating book, inside the create transaction', async () => {
        seedOwnership({});
        commodities.findFirst.mockResolvedValue({ guid: CURRENCY_GUID });
        customers.findMany.mockResolvedValue([]);
        customers.create.mockResolvedValue(CUSTOMER_ROW);
        // getCustomer() re-reads after the insert; ownership is now in place.
        ownership.findUnique.mockResolvedValue({ book_guid: BOOK_A });
        customers.findUnique.mockResolvedValue(CUSTOMER_ROW);

        await createCustomer(BOOK_A, parseInput(customerInputSchema, { name: 'New Co' }));

        expect(db.$transaction).toHaveBeenCalled();
        expect(ownership.create).toHaveBeenCalledWith({
            data: {
                entity_type: 'customer',
                entity_guid: expect.any(String),
                book_guid: BOOK_A,
            },
        });
        const createdGuid = customers.create.mock.calls[0][0].data.guid;
        expect(ownership.create.mock.calls[0][0].data.entity_guid).toBe(createdGuid);
    });

    it('drops the ownership row alongside a hard delete', async () => {
        seedOwnership({ [`customer:${CUSTOMER_A}`]: BOOK_A });
        customers.findUnique.mockResolvedValue(CUSTOMER_ROW);
        jobs.count.mockResolvedValue(0);
        db.invoices.count.mockResolvedValue(0);
        db.billterms.updateMany.mockResolvedValue({ count: 0 });

        expect(await deleteCustomer(BOOK_A, CUSTOMER_A)).toEqual({ deleted: true, deactivated: false });
        expect(ownership.deleteMany).toHaveBeenCalledWith({
            where: { entity_type: 'customer', entity_guid: CUSTOMER_A },
        });
    });

    it('keeps ownership when the customer is deactivated instead of deleted', async () => {
        seedOwnership({ [`customer:${CUSTOMER_A}`]: BOOK_A });
        customers.findUnique.mockResolvedValue(CUSTOMER_ROW);
        jobs.count.mockResolvedValue(1);
        db.invoices.count.mockResolvedValue(0);

        expect(await deleteCustomer(BOOK_A, CUSTOMER_A)).toEqual({ deleted: false, deactivated: true });
        expect(ownership.deleteMany).not.toHaveBeenCalled();
    });
});

describe('vendor book scope', () => {
    beforeEach(resetAll);

    it('constrains the vendor list to the book even when it owns none', async () => {
        seedOwnership({ [`vendor:${CUSTOMER_B}`]: BOOK_B });
        vendors.findMany.mockResolvedValue([]);

        expect(await listVendors(BOOK_A)).toEqual([]);
        for (const call of vendors.findMany.mock.calls) {
            expect(call[0].where).toMatchObject({ ownership: { book_guid: BOOK_A } });
        }
    });

    it('returns null for another book\'s vendor', async () => {
        seedOwnership({ [`vendor:${CUSTOMER_B}`]: BOOK_B });

        expect(await getVendor(BOOK_A, CUSTOMER_B)).toBeNull();
        expect(vendors.findUnique).not.toHaveBeenCalled();
    });
});

const JOB_ROW = {
    guid: JOB_A,
    id: '000001',
    name: 'Book A Job',
    reference: '',
    active: 1,
    owner_type: 2,
    owner_guid: CUSTOMER_A,
};

describe('job book scope', () => {
    beforeEach(resetAll);

    it('omits another book\'s job from the list', async () => {
        seedOwnership({ [`job:${JOB_A}`]: BOOK_A, [`job:${JOB_B}`]: BOOK_B });
        jobs.findMany.mockResolvedValue([JOB_ROW]);
        customers.findMany.mockResolvedValue([{ guid: CUSTOMER_A, name: 'Book A Customer' }]);

        const rows = await listJobs(BOOK_A);

        expect(rows.map(r => r.guid)).toEqual([JOB_A]);
        expect(jobs.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ ownership: { book_guid: BOOK_A } }),
            }),
        );
    });

    it('returns null for a job owned by another book', async () => {
        seedOwnership({ [`job:${JOB_B}`]: BOOK_B });

        expect(await getJob(BOOK_A, JOB_B)).toBeNull();
        expect(jobs.findUnique).not.toHaveBeenCalled();
    });

    it('rejects a job whose owner belongs to another book', async () => {
        seedOwnership({ [`customer:${CUSTOMER_B}`]: BOOK_B });
        // The customer row exists — only the ownership check rules it out.
        customers.findUnique.mockResolvedValue({ guid: CUSTOMER_B });

        await expect(createJob(
            BOOK_A,
            parseInput(jobInputSchema, { name: 'Job', ownerType: 'customer', ownerGuid: CUSTOMER_B }),
        )).rejects.toThrow(BusinessValidationError);
        expect(jobs.create).not.toHaveBeenCalled();
        expect(db.$transaction).not.toHaveBeenCalled();
    });

    it('records ownership when creating a job with an in-book owner', async () => {
        seedOwnership({ [`customer:${CUSTOMER_A}`]: BOOK_A });
        customers.findUnique.mockResolvedValue({ guid: CUSTOMER_A });
        jobs.findMany.mockResolvedValue([]);
        jobs.create.mockResolvedValue(JOB_ROW);
        jobs.findUnique.mockResolvedValue(JOB_ROW);
        customers.findMany.mockResolvedValue([{ guid: CUSTOMER_A, name: 'Book A Customer' }]);
        ownership.findUnique.mockResolvedValue({ book_guid: BOOK_A });

        await createJob(
            BOOK_A,
            parseInput(jobInputSchema, { name: 'Job', ownerType: 'customer', ownerGuid: CUSTOMER_A }),
        );

        expect(ownership.create).toHaveBeenCalledWith({
            data: { entity_type: 'job', entity_guid: expect.any(String), book_guid: BOOK_A },
        });
    });

    it('updates and deletes a foreign job as not-found', async () => {
        seedOwnership({ [`job:${JOB_B}`]: BOOK_B });
        const input = parseInput(jobInputSchema, {
            name: 'Job', ownerType: 'customer', ownerGuid: CUSTOMER_A,
        });

        expect(await updateJob(BOOK_A, JOB_B, input)).toBeNull();
        expect(await deleteJob(BOOK_A, JOB_B)).toBeNull();
        expect(jobs.update).not.toHaveBeenCalled();
        expect(jobs.delete).not.toHaveBeenCalled();
    });
});

describe('reference counts stay inside the owning book', () => {
    beforeEach(resetAll);

    const TERM = 'e'.repeat(32);

    it('counts only references from the book that owns the bill term', async () => {
        seedOwnership({ [`billterm:${TERM}`]: BOOK_A });
        customers.count.mockResolvedValue(1);
        vendors.count.mockResolvedValue(0);
        db.invoices.count.mockResolvedValue(0);
        db.billterms.updateMany.mockResolvedValue({ count: 1 });

        await recomputeBilltermRefcount(TERM);

        // Validation forbids referencing another book's term, so a cross-book
        // reference can only be legacy data — counting it would stop this book
        // from hard-deleting a term it no longer uses.
        for (const call of [
            ...customers.count.mock.calls,
            ...vendors.count.mock.calls,
            ...db.invoices.count.mock.calls,
        ]) {
            expect(call[0].where).toMatchObject({ ownership: { book_guid: BOOK_A } });
        }
        expect(db.billterms.updateMany).toHaveBeenCalledWith({
            where: { guid: TERM },
            data: { refcount: 1 },
        });
    });

    it('falls back to the unscoped count for an unattributed term', async () => {
        seedOwnership({});
        customers.count.mockResolvedValue(0);
        vendors.count.mockResolvedValue(0);
        db.invoices.count.mockResolvedValue(0);
        db.billterms.updateMany.mockResolvedValue({ count: 1 });

        await recomputeBilltermRefcount(TERM);

        // Over-counting is the safe direction: an unowned term is invisible,
        // and a high refcount blocks deletion rather than exposing anything.
        for (const call of customers.count.mock.calls) {
            expect(call[0].where).not.toHaveProperty('ownership');
        }
    });
});

import { describe, it, expect } from 'vitest';
import {
    detectContactListKind,
    parseQboContactRows,
    splitAddressLines,
    planQboDocuments,
    summarizeDocumentPlan,
} from '../qbo-business';
import type { QboJournalTransaction } from '../qbo-journal';

/* ------------------------------------------------------------------ */
/* Contact lists                                                        */
/* ------------------------------------------------------------------ */

const CUSTOMERS: string[][] = [
    ['Industrial Insight Inc', '', '', '', '', '', ''],
    ['Customer Contact List', '', '', '', '', '', ''],
    ['', '', '', '', '', '', ''],
    ['', 'Customer', 'Phone Numbers', 'Email', 'Full Name', 'Billing Address', 'Shipping Address'],
    ['', 'Albemarle Chemical - Magnolia', 'Phone: (225) 388-7451', 'apinvoices@albemarle.com', 'Rebecca Fremin', '451 Florida Street\nBaton Rouge LA 70801\nUSA', '2270 Highway 79 South\nMagnolia AR 71753\nUSA'],
    ['', 'Anadarko US Offshore LLC', '', '', '', 'PO Box 2004\nHouston TX 77252', 'PO Box 2004\nHouston TX 77252'],
    ['', 'Anadarko US Offshore LLC', '', '', '', '', ''], // duplicate name → dropped
    ['', '', '', '', '', '', ''],
    ['Tuesday, Sep 01, 2026 12:20:28 PM GMT-7', '', '', '', '', '', ''],
];

const VENDORS: string[][] = [
    ['', 'Vendor', 'Phone Numbers', 'Email', 'Full Name', 'Address', 'Account #'],
    ['', 'Zoom.us', 'Mobile: 720-270-5030', 'billing@zoom.us', '', '55 Almaden Blvd\nSan Jose CA 95113', 'ACCT-42'],
];

const EMPLOYEES: string[][] = [
    ['', 'Employee', 'Phone Numbers', 'Email', 'Address'],
    ['', '*Adrian E. Lourenco', '', 'adrian@example.com', '2043 S Balsam Street\nLakewood CO 80227'],
    ['', 'Philip A. Babb', 'Mobile: 4052433833', 'pbabb@example.com', 'L1\nL2\nL3\nL4\nL5\nL6'],
];

describe('contact lists', () => {
    it('classifies the three contact list reports', () => {
        expect(detectContactListKind(CUSTOMERS)).toBe('customers');
        expect(detectContactListKind(VENDORS)).toBe('vendors');
        expect(detectContactListKind(EMPLOYEES)).toBe('employees');
        expect(detectContactListKind([['Account name', 'Account type', 'Detail type']])).toBeNull();
    });

    it('parses customers with contact person, cleaned phone, and both addresses', () => {
        const parsed = parseQboContactRows(CUSTOMERS)!;
        expect(parsed.kind).toBe('customers');
        expect(parsed.contacts.map((c) => c.name)).toEqual(['Albemarle Chemical - Magnolia', 'Anadarko US Offshore LLC']);
        const [alb] = parsed.contacts;
        expect(alb.contactName).toBe('Rebecca Fremin');
        expect(alb.phone).toBe('(225) 388-7451');
        expect(alb.email).toBe('apinvoices@albemarle.com');
        expect(alb.address).toEqual(['451 Florida Street', 'Baton Rouge LA 70801', 'USA']);
        expect(alb.shipAddress).toEqual(['2270 Highway 79 South', 'Magnolia AR 71753', 'USA']);
    });

    it('parses vendors with the account number', () => {
        const parsed = parseQboContactRows(VENDORS)!;
        expect(parsed.kind).toBe('vendors');
        expect(parsed.contacts[0]).toMatchObject({ name: 'Zoom.us', phone: '720-270-5030', accountNumber: 'ACCT-42' });
    });

    it('strips the leading "*" QBO puts on some employees and folds long addresses to 4 lines', () => {
        const parsed = parseQboContactRows(EMPLOYEES)!;
        expect(parsed.kind).toBe('employees');
        expect(parsed.contacts[0].name).toBe('Adrian E. Lourenco');
        expect(parsed.contacts[1].address).toEqual(['L1', 'L2', 'L3', 'L4, L5, L6']);
        expect(splitAddressLines('')).toEqual([]);
    });
});

/* ------------------------------------------------------------------ */
/* Documents                                                            */
/* ------------------------------------------------------------------ */

const AR = 'Accounts Receivable (A/R)';
const AP = 'Accounts Payable (A/P)';
const CHK = 'Checking';

function txn(
    date: string,
    type: string,
    name: string,
    num: string,
    lines: Array<[string, number]>,
    memo = ''
): QboJournalTransaction {
    return {
        date,
        type,
        num,
        name,
        memo,
        lines: lines.map(([accountPath, amount], i) => ({ accountPath, amount, memo: '', row: i + 1 })),
        startRow: 1,
    };
}

const TYPES = new Map<string, string>([
    [AR, 'RECEIVABLE'],
    [AP, 'PAYABLE'],
    [CHK, 'BANK'],
    ['Services', 'INCOME'],
    ['Software', 'EXPENSE'],
]);

const JOURNAL: QboJournalTransaction[] = [
    txn('2017-05-02', 'Invoice', 'Acme', '1001', [[AR, 14000], ['Services', -14000]], 'Consulting'),
    txn('2017-06-01', 'Invoice', 'Acme', '1002', [[AR, 6000], ['Services', -6000]]),
    // Pays 1001 in full and 1002 partly, in one payment
    txn('2017-07-10', 'Payment', 'Acme', '', [[CHK, 15000], [AR, -15000]]),
    // Overpays the remainder of 1002 by 500
    txn('2017-08-01', 'Payment', 'Acme', '', [[CHK, 5500], [AR, -5500]]),
    txn('2018-10-31', 'Credit Memo', 'Acme', '1047', [[AR, 0], ['Services', 0]], 'Voided'),
    // Same-day: the payment sorts after the invoice even though it is listed first
    txn('2019-03-01', 'Payment', 'Acme', '', [[CHK, 700], [AR, -700]]),
    txn('2019-03-01', 'Invoice', 'Acme', '1050', [[AR, 700], ['Services', -700]]),
    // A real credit memo, then QBO's zero-amount "link credits to charges" payment
    txn('2019-04-01', 'Invoice', 'Acme', '1051', [[AR, 300], ['Services', -300]]),
    txn('2019-04-02', 'Credit Memo', 'Acme', '1052', [[AR, -120], ['Services', 120]], 'Goodwill'),
    txn('2019-04-03', 'Payment', 'Acme', '', [[AR, 0]], 'Created by QB Online to link credits to charges.'),
    txn('2020-07-13', 'Bill', 'Pattern Discovery', '', [[AP, -3840], ['Software', 3840]], 'PI Tag Tuning'),
    txn('2020-07-20', 'Bill Payment (Check)', 'Pattern Discovery', '', [[CHK, -3840], [AP, 3840]]),
    txn('2020-08-01', 'Invoice', 'Nobody Inc', '2001', [[AR, 100], ['Services', -100]]),
    txn('2020-09-01', 'Expense', 'Zoom.us', '', [[CHK, -15], ['Software', 15]]),
];

describe('planQboDocuments', () => {
    const plan = planQboDocuments({
        transactions: JOURNAL,
        accountTypeByPath: TYPES,
        customerNames: ['Acme'],
        vendorNames: ['Pattern Discovery', 'Zoom.us'],
    });
    const docs = Object.fromEntries(plan.documents.map((d) => [d.id, d]));

    it('turns Invoice and Bill transactions into documents with entries priced from their lines', () => {
        expect(plan.documents.map((d) => [d.kind, d.id, d.total])).toEqual([
            ['invoice', '1001', 14000],
            ['invoice', '1002', 6000],
            ['invoice', '1050', 700],
            ['invoice', '1051', 300],
            ['invoice', '1052', -120], // credit memo → negative document
            ['bill', '000001', 3840], // bill had no Num → generated
        ]);
        expect(docs['1001'].entries).toEqual([{ accountPath: 'Services', price: 14000, description: 'Consulting' }]);
        expect(docs['000001'].entries).toEqual([{ accountPath: 'Software', price: 3840, description: 'PI Tag Tuning' }]);
        expect(docs['1001'].postAccountPath).toBe(AR);
        expect(docs['1001'].postLineIndex).toBe(0);
    });

    it('applies payments FIFO across the owner\'s open documents and carries the excess unallocated', () => {
        const [p1, p2, sameDay, link, bp] = plan.payments;
        expect(p1.allocations).toEqual([
            { docIndex: 0, amount: 14000 },
            { docIndex: 1, amount: 1000 },
        ]);
        expect(p1.unallocated).toBe(0);
        // 5000 closes 1002; the 500 excess is a prepayment against the later
        // invoice 1051 (180 still due after its credit memo), 320 left over.
        expect(p2.allocations).toEqual([
            { docIndex: 1, amount: 5000 },
            { docIndex: 3, amount: 180 },
        ]);
        expect(p2.unallocated).toBe(320);
        expect(sameDay.allocations).toEqual([{ docIndex: 2, amount: 700 }]);
        expect(link.amount).toBe(0);
        expect(bp.kind).toBe('bill');
        expect(bp.allocations).toEqual([{ docIndex: 5, amount: 3840 }]);
        expect(docs['1001'].paid).toBe(14000);
        expect(docs['1002'].paid).toBe(6000);
        expect(docs['000001'].paid).toBe(3840);
    });

    it('applies a credit memo to the owner\'s open invoice through the linking payment', () => {
        const link = plan.payments[3];
        expect(link.creditLinks).toEqual([{ creditDocIndex: 4, docIndex: 3, amount: 120 }]);
        expect(docs['1051'].paid).toBe(300); // 120 credit + 180 prepayment
        expect(docs['1052'].paid).toBe(-120); // credit fully consumed
        expect(docs['1052'].entries).toEqual([{ accountPath: 'Services', price: -120, description: 'Goodwill' }]);
    });

    it('skips voided documents and owners missing from the lists, and ignores non-document types', () => {
        expect(plan.skipped.map((s) => [s.type, s.reason])).toEqual([
            ['Credit Memo', 'zero-amount document (voided)'],
            ['Invoice', '"Nobody Inc" is not in the customer list'],
        ]);
    });

    it('summarizes for the preview', () => {
        expect(summarizeDocumentPlan(plan)).toEqual({
            invoices: 4,
            creditNotes: 1,
            bills: 1,
            customerPayments: 4,
            billPayments: 1,
            paidInFull: 6, // 1001, 1002, 1050, 1051, the credit memo, the bill
            partiallyPaid: 0,
            unallocatedPayments: 1,
            unallocatedAmount: 320,
            skipped: 2,
        });
    });

    it('generates ids past the existing numeric ids and never reuses a duplicate Num', () => {
        const dup = planQboDocuments({
            transactions: [
                txn('2020-01-01', 'Invoice', 'Acme', '7', [[AR, 1], ['Services', -1]]),
                txn('2020-01-02', 'Invoice', 'Acme', '7', [[AR, 1], ['Services', -1]]),
                txn('2020-01-03', 'Invoice', 'Acme', '', [[AR, 1], ['Services', -1]]),
            ],
            accountTypeByPath: TYPES,
            customerNames: ['Acme'],
            vendorNames: [],
            existingIds: { invoice: ['000009'], bill: [] },
        });
        expect(dup.documents.map((d) => d.id)).toEqual(['7', '000010', '000011']);
    });
});

import { describe, it, expect } from 'vitest';
import {
    STATUS_META,
    parseAmount,
    roundCents,
    computeEntryPreview,
    computeTotalsPreview,
    entryDraftToPayload,
    entryViewToDraft,
    emptyEntryDraft,
    isBlankDraft,
    dueDateFromTerm,
    addDaysIso,
    fifoAllocations,
    allocationsTotal,
    allocationsToPayload,
    validatePayment,
    type OpenInvoiceLite,
} from '@/components/business/invoice-ui';
import type { TaxtableDTO } from '@/lib/business-types';
import type { EntryView } from '@/lib/business/invoice-engine';

const salesTax: TaxtableDTO = {
    guid: 'tt1',
    name: 'Sales Tax',
    refcount: 0,
    invisible: false,
    entries: [
        { id: 1, account: 'acct-tax', accountName: 'Tax', amount: 5, type: 'percent' },
    ],
};

const mixedTax: TaxtableDTO = {
    guid: 'tt2',
    name: 'Mixed',
    refcount: 0,
    invisible: false,
    entries: [
        { id: 1, account: 'a', accountName: null, amount: 10, type: 'percent' },
        { id: 2, account: 'b', accountName: null, amount: 2, type: 'value' },
    ],
};

function draft(overrides: Partial<ReturnType<typeof emptyEntryDraft>> = {}) {
    return { ...emptyEntryDraft(), ...overrides };
}

describe('STATUS_META', () => {
    it('maps every status to a label and token-based classes', () => {
        expect(Object.keys(STATUS_META).sort()).toEqual(['draft', 'open', 'overdue', 'paid']);
        expect(STATUS_META.draft.className).toContain('foreground-muted');
        expect(STATUS_META.open.className).toContain('secondary');
        expect(STATUS_META.paid.className).toContain('positive');
        expect(STATUS_META.overdue.className).toContain('negative');
    });
});

describe('parseAmount / roundCents', () => {
    it('parses strings with commas and rejects garbage', () => {
        expect(parseAmount('1,234.50')).toBe(1234.5);
        expect(parseAmount('')).toBe(0);
        expect(parseAmount('abc')).toBe(0);
        expect(parseAmount(3.25)).toBe(3.25);
        expect(parseAmount(null)).toBe(0);
    });

    it('rounds half-away-from-zero to cents', () => {
        expect(roundCents(1.0051)).toBe(1.01);
        expect(roundCents(-1.0051)).toBe(-1.01);
        expect(roundCents(2.004)).toBe(2);
        expect(roundCents(1.125)).toBe(1.13);
        expect(roundCents(-1.125)).toBe(-1.13);
    });
});

describe('computeEntryPreview', () => {
    it('computes a plain line (no discount, no tax)', () => {
        const p = computeEntryPreview(draft({ quantity: '3', price: '19.99' }), 'invoice', null);
        expect(p.subtotal).toBe(59.97);
        expect(p.discountValue).toBe(0);
        expect(p.net).toBe(59.97);
        expect(p.taxTotal).toBe(0);
        expect(p.gross).toBe(59.97);
    });

    it('applies percent tax on the discounted (PRETAX) base', () => {
        const p = computeEntryPreview(
            draft({ quantity: '1', price: '100', discount: '10', discountType: 'PERCENT', discountHow: 'PRETAX' }),
            'invoice',
            salesTax,
        );
        expect(p.subtotal).toBe(100);
        expect(p.discountValue).toBe(10);
        expect(p.net).toBe(90);
        expect(p.taxTotal).toBe(4.5); // 5% of 90
        expect(p.gross).toBe(94.5);
    });

    it('SAMETIME taxes the pre-discount value', () => {
        const p = computeEntryPreview(
            draft({ quantity: '1', price: '100', discount: '10', discountType: 'PERCENT', discountHow: 'SAMETIME' }),
            'invoice',
            salesTax,
        );
        expect(p.net).toBe(90);
        expect(p.taxTotal).toBe(5); // 5% of 100
        expect(p.gross).toBe(95);
    });

    it('POSTTAX percent discount includes tax in the discount base', () => {
        const p = computeEntryPreview(
            draft({ quantity: '1', price: '100', discount: '10', discountType: 'PERCENT', discountHow: 'POSTTAX' }),
            'invoice',
            salesTax,
        );
        // discount = (100 + 5) * 10% = 10.50; net = 89.50; tax on pretax = 5
        expect(p.discountValue).toBe(10.5);
        expect(p.net).toBe(89.5);
        expect(p.taxTotal).toBe(5);
        expect(p.gross).toBe(94.5);
    });

    it('backs included tax out of the aggregate', () => {
        const p = computeEntryPreview(
            draft({ quantity: '1', price: '107', taxIncluded: true }),
            'invoice',
            mixedTax,
        );
        // pretax = (107 - 2) / 1.10 = 95.4545...
        expect(p.subtotal).toBe(95.45);
        expect(p.taxTotal).toBe(11.55); // 9.545... -> 9.55 percent + 2 value
        expect(p.gross).toBe(107.0);
    });

    it('ignores discounts on bills and tax when not taxable', () => {
        const billLine = computeEntryPreview(
            draft({ quantity: '2', price: '50', discount: '10', discountType: 'PERCENT' }),
            'bill',
            salesTax,
        );
        expect(billLine.discountValue).toBe(0);
        expect(billLine.net).toBe(100);
        expect(billLine.taxTotal).toBe(5);

        const untaxed = computeEntryPreview(
            draft({ quantity: '2', price: '50', taxable: false }),
            'bill',
            salesTax,
        );
        expect(untaxed.taxTotal).toBe(0);
        expect(untaxed.gross).toBe(100);
    });
});

describe('computeTotalsPreview', () => {
    it('aggregates line previews with per-step rounding', () => {
        const lines = [
            computeEntryPreview(draft({ quantity: '1', price: '100', discount: '10', discountType: 'PERCENT' }), 'invoice', salesTax),
            computeEntryPreview(draft({ quantity: '3', price: '19.99' }), 'invoice', null),
        ];
        const t = computeTotalsPreview(lines);
        expect(t.subtotal).toBe(159.97);
        expect(t.discountTotal).toBe(10);
        expect(t.taxTotal).toBe(4.5);
        expect(t.total).toBe(154.47);
    });
});

describe('entry draft round-trip', () => {
    const view: EntryView = {
        guid: 'e1',
        date: '2026-07-01',
        description: 'Consulting',
        action: 'Hours',
        notes: 'n',
        quantity: 2.5,
        price: 150,
        accountGuid: 'income-1',
        discount: 5,
        discountType: 'PERCENT',
        discountHow: 'PRETAX',
        taxable: true,
        taxIncluded: false,
        taxTableGuid: 'tt1',
        computed: { subtotal: 375, discountValue: 18.75, net: 356.25, taxTotal: 17.81, gross: 374.06 },
    };

    it('converts a server entry into an editable draft and back', () => {
        const d = entryViewToDraft(view);
        expect(d.quantity).toBe('2.5');
        expect(d.price).toBe('150');
        expect(d.discount).toBe('5');
        expect(d.taxTableGuid).toBe('tt1');

        const payload = entryDraftToPayload(d, 'invoice');
        expect(payload).toMatchObject({
            description: 'Consulting',
            quantity: 2.5,
            price: 150,
            accountGuid: 'income-1',
            discount: 5,
            discountType: 'PERCENT',
            discountHow: 'PRETAX',
            taxable: true,
            taxIncluded: false,
            taxTableGuid: 'tt1',
            date: '2026-07-01',
        });
    });

    it('omits discount fields for bills (API rejects them)', () => {
        const d = entryViewToDraft(view);
        const payload = entryDraftToPayload(d, 'bill');
        expect(payload.discount).toBeUndefined();
        expect(payload.discountType).toBeUndefined();
        expect(payload.discountHow).toBeUndefined();
    });

    it('sends null taxTableGuid when cleared and detects blank rows', () => {
        const d = draft({ taxTableGuid: '' });
        expect(entryDraftToPayload(d, 'invoice').taxTableGuid).toBeNull();

        expect(isBlankDraft(emptyEntryDraft())).toBe(true);
        expect(isBlankDraft(draft({ description: 'x' }))).toBe(false);
        expect(isBlankDraft(draft({ accountGuid: 'a' }))).toBe(false);
        expect(isBlankDraft(draft({ price: '5' }))).toBe(false);
    });
});

describe('due dates', () => {
    it('adds net-N days from a bill term', () => {
        expect(addDaysIso('2026-07-08', 30)).toBe('2026-08-07');
        expect(dueDateFromTerm('2026-07-08', { dueDays: 15 })).toBe('2026-07-23');
        expect(dueDateFromTerm('2026-12-20', { dueDays: 30 })).toBe('2027-01-19');
    });

    it('falls back to the post date without a term', () => {
        expect(dueDateFromTerm('2026-07-08', null)).toBe('2026-07-08');
        expect(dueDateFromTerm('2026-07-08', { dueDays: 0 })).toBe('2026-07-08');
    });
});

describe('payment allocation helpers', () => {
    const open: OpenInvoiceLite[] = [
        { guid: 'b', id: '000002', datePosted: '2026-06-15', dueDate: null, amountDue: 50 },
        { guid: 'a', id: '000001', datePosted: '2026-06-01', dueDate: null, amountDue: 100 },
        { guid: 'c', id: '000003', datePosted: null, dueDate: null, amountDue: 25 },
    ];

    it('allocates FIFO oldest-first, null post dates last', () => {
        expect(fifoAllocations(open, 120)).toEqual({ a: 100, b: 20 });
        expect(fifoAllocations(open, 175)).toEqual({ a: 100, b: 50, c: 25 });
        expect(fifoAllocations(open, 10)).toEqual({ a: 10 });
    });

    it('sums and serializes allocation maps', () => {
        const allocs = { a: '100.00', b: '20', c: '' };
        expect(allocationsTotal(allocs)).toBe(120);
        expect(allocationsToPayload(allocs)).toEqual([
            { invoiceGuid: 'a', amount: 100 },
            { invoiceGuid: 'b', amount: 20 },
        ]);
    });

    it('validates amount, per-invoice caps and the allocation balance', () => {
        expect(validatePayment(0, {}, open)).toMatch(/greater than zero/);
        expect(validatePayment(120, { a: '100', b: '20' }, open)).toBeNull();
        expect(validatePayment(120, { a: '150' }, open)).toMatch(/exceeds/);
        expect(validatePayment(120, { a: '-5', b: '125' }, open)).toMatch(/negative/);
        expect(validatePayment(120, { a: '100' }, open)).toMatch(/add up/);
        expect(validatePayment(50, { zzz: '50' }, open)).toMatch(/unknown/);
    });
});

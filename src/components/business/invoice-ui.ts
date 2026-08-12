/**
 * Invoice/Bill UI helpers — pure logic shared by the AR/AP pages.
 *
 * The entry math here is a client-side mirror of the engine's
 * `computeEntry` / `computeInvoiceTotals` (src/lib/business/invoice-totals.ts)
 * used only for live previews while editing a draft. The server recomputes
 * everything on save/post and remains the source of truth.
 */

import type {
    InvoiceKind,
    InvoiceStatus,
    DiscountType,
    DiscountHow,
} from '@/lib/business/invoice-totals';
import type { EntryView } from '@/lib/business/invoice-engine';
import type { TaxtableDTO } from '@/lib/business-types';

export type { InvoiceKind, InvoiceStatus, DiscountType, DiscountHow };

// ---------------------------------------------------------------------------
// Status badges
// ---------------------------------------------------------------------------

export const STATUS_META: Record<InvoiceStatus, { label: string; className: string }> = {
    draft: { label: 'Draft', className: 'bg-surface-hover text-foreground-muted' },
    open: { label: 'Open', className: 'bg-secondary-light text-secondary' },
    paid: { label: 'Paid', className: 'bg-positive/10 text-positive' },
    overdue: { label: 'Overdue', className: 'bg-negative/10 text-negative' },
};

// ---------------------------------------------------------------------------
// Entry drafts (string-valued for inputs)
// ---------------------------------------------------------------------------

export interface EntryDraft {
    /** Stable React key (not persisted). */
    key: string;
    description: string;
    action: string;
    notes: string;
    /** Preserved from the server row; not edited in the UI. */
    date: string | null;
    quantity: string;
    price: string;
    accountGuid: string;
    /** Customer invoices only. */
    discount: string;
    discountType: DiscountType;
    discountHow: DiscountHow;
    taxable: boolean;
    taxIncluded: boolean;
    taxTableGuid: string;
}

let draftSeq = 0;
export function newDraftKey(): string {
    draftSeq += 1;
    return `draft-${draftSeq}-${Date.now()}`;
}

export function emptyEntryDraft(): EntryDraft {
    return {
        key: newDraftKey(),
        description: '',
        action: '',
        notes: '',
        date: null,
        quantity: '1',
        price: '',
        accountGuid: '',
        discount: '',
        discountType: 'PERCENT',
        discountHow: 'PRETAX',
        taxable: true,
        taxIncluded: false,
        taxTableGuid: '',
    };
}

export function entryViewToDraft(e: EntryView): EntryDraft {
    return {
        key: e.guid || newDraftKey(),
        description: e.description ?? '',
        action: e.action ?? '',
        notes: e.notes ?? '',
        date: e.date ?? null,
        quantity: String(e.quantity),
        price: String(e.price),
        accountGuid: e.accountGuid ?? '',
        discount: e.discount ? String(e.discount) : '',
        discountType: e.discountType ?? 'PERCENT',
        discountHow: e.discountHow ?? 'PRETAX',
        taxable: e.taxable !== false,
        taxIncluded: Boolean(e.taxIncluded),
        taxTableGuid: e.taxTableGuid ?? '',
    };
}

/** True when the row has nothing meaningful in it (safe to drop on save). */
export function isBlankDraft(d: EntryDraft): boolean {
    return !d.accountGuid && !d.description.trim() && parseAmount(d.price) === 0;
}

export interface EntryPayload {
    description: string;
    action?: string;
    notes?: string;
    date?: string;
    quantity: number;
    price: number;
    accountGuid: string;
    discount?: number;
    discountType?: DiscountType;
    discountHow?: DiscountHow;
    taxable?: boolean;
    taxIncluded?: boolean;
    taxTableGuid?: string | null;
}

/** Convert an edited row to the API entry body. Discounts only for invoices. */
export function entryDraftToPayload(d: EntryDraft, kind: InvoiceKind): EntryPayload {
    const payload: EntryPayload = {
        description: d.description,
        action: d.action || undefined,
        notes: d.notes || undefined,
        date: d.date ?? undefined,
        quantity: parseAmount(d.quantity),
        price: parseAmount(d.price),
        accountGuid: d.accountGuid,
        taxable: d.taxable,
        taxIncluded: d.taxIncluded,
        taxTableGuid: d.taxTableGuid || null,
    };
    if (kind === 'invoice') {
        const discount = parseAmount(d.discount);
        if (discount !== 0) {
            payload.discount = discount;
            payload.discountType = d.discountType;
            payload.discountHow = d.discountHow;
        }
    }
    return payload;
}

// ---------------------------------------------------------------------------
// Entry math (mirror of invoice-totals.ts computeEntry)
// ---------------------------------------------------------------------------

export function parseAmount(value: string | number | null | undefined): number {
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    if (!value) return 0;
    const n = parseFloat(String(value).replace(/,/g, ''));
    return Number.isFinite(n) ? n : 0;
}

/** Round half-away-from-zero to cents. */
export function roundCents(value: number): number {
    const sign = value < 0 ? -1 : 1;
    return (sign * Math.round(Math.abs(value) * 100)) / 100;
}

export interface EntryPreview {
    subtotal: number;
    discountValue: number;
    net: number;
    taxTotal: number;
    gross: number;
}

/**
 * Live preview of one row's computed values. `taxtable` is the resolved
 * TaxtableDTO for the row's taxTableGuid (or null/undefined for no tax).
 */
export function computeEntryPreview(
    d: Pick<EntryDraft, 'quantity' | 'price' | 'discount' | 'discountType' | 'discountHow' | 'taxable' | 'taxIncluded'>,
    kind: InvoiceKind,
    taxtable?: TaxtableDTO | null,
): EntryPreview {
    const quantity = parseAmount(d.quantity);
    const price = parseAmount(d.price);
    const aggregate = quantity * price;

    const table = d.taxable && taxtable && taxtable.entries.length > 0 ? taxtable : null;

    let tpercent = 0;
    let tvalue = 0;
    if (table) {
        for (const e of table.entries) {
            if (e.type === 'percent') tpercent += e.amount;
            else tvalue += e.amount;
        }
    }
    tpercent /= 100;

    const taxIncluded = Boolean(table && d.taxIncluded);
    const pretax = taxIncluded ? (aggregate - tvalue) / (1 + tpercent) : aggregate;

    // Discount (customer invoices only)
    let discount = 0;
    const discAmt = kind === 'invoice' ? parseAmount(d.discount) : 0;
    if (discAmt !== 0) {
        if (d.discountType === 'VALUE') {
            discount = discAmt;
        } else if (d.discountHow === 'POSTTAX') {
            const taxOnPretax = table ? pretax * tpercent + tvalue : 0;
            discount = ((pretax + taxOnPretax) * discAmt) / 100;
        } else {
            discount = (pretax * discAmt) / 100;
        }
    }

    const netRaw = pretax - discount;
    const net = roundCents(netRaw);
    const discountValue = roundCents(discount);

    const taxBase = d.discountHow === 'PRETAX' ? netRaw : pretax;
    let taxTotal = 0;
    if (table) {
        for (const e of table.entries) {
            const amt = roundCents(e.type === 'percent' ? (taxBase * e.amount) / 100 : e.amount);
            taxTotal += amt;
        }
    }
    taxTotal = roundCents(taxTotal);

    return {
        subtotal: roundCents(pretax),
        discountValue,
        net,
        taxTotal,
        gross: roundCents(net + taxTotal),
    };
}

export interface TotalsPreview {
    subtotal: number;
    discountTotal: number;
    taxTotal: number;
    total: number;
}

export function computeTotalsPreview(previews: EntryPreview[]): TotalsPreview {
    let subtotal = 0;
    let discountTotal = 0;
    let taxTotal = 0;
    let total = 0;
    for (const p of previews) {
        subtotal = roundCents(subtotal + p.subtotal);
        discountTotal = roundCents(discountTotal + p.discountValue);
        taxTotal = roundCents(taxTotal + p.taxTotal);
        total = roundCents(total + p.net + p.taxTotal);
    }
    return { subtotal, discountTotal, taxTotal, total };
}

// ---------------------------------------------------------------------------
// Dates / bill terms
// ---------------------------------------------------------------------------

export function todayIso(): string {
    const d = new Date();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day}`;
}

export function addDaysIso(iso: string, days: number): string {
    const d = new Date(iso.slice(0, 10) + 'T12:00:00Z');
    if (isNaN(d.getTime())) return iso;
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}

/** Net-N due date preview from a bill term; no term => due on post date. */
export function dueDateFromTerm(postDateIso: string, term?: { dueDays: number } | null): string {
    if (!term || !term.dueDays) return postDateIso;
    return addDaysIso(postDateIso, term.dueDays);
}

// ---------------------------------------------------------------------------
// Payment allocation editing
// ---------------------------------------------------------------------------

export interface OpenInvoiceLite {
    guid: string;
    id: string;
    datePosted: string | null;
    dueDate: string | null;
    amountDue: number;
}

/**
 * Oldest-first (FIFO) allocation of `amount` across open invoices — mirrors
 * the engine's default so the editable table starts from what the server
 * would do anyway.
 */
export function fifoAllocations(invoices: OpenInvoiceLite[], amount: number): Record<string, number> {
    const sorted = [...invoices]
        .filter((i) => i.amountDue > 0.005)
        .sort((a, b) => {
            const ta = a.datePosted ?? '9999-99-99';
            const tb = b.datePosted ?? '9999-99-99';
            if (ta !== tb) return ta < tb ? -1 : 1;
            return a.guid < b.guid ? -1 : a.guid > b.guid ? 1 : 0;
        });

    const result: Record<string, number> = {};
    let remaining = roundCents(amount);
    for (const inv of sorted) {
        if (remaining <= 0.005) break;
        const take = roundCents(Math.min(inv.amountDue, remaining));
        result[inv.guid] = take;
        remaining = roundCents(remaining - take);
    }
    return result;
}

export function allocationsTotal(allocations: Record<string, string | number>): number {
    let sum = 0;
    for (const v of Object.values(allocations)) sum = roundCents(sum + parseAmount(v));
    return sum;
}

/**
 * Validate a payment before submitting. Returns an error message, or null
 * when the payment is consistent.
 */
export function validatePayment(
    amount: number,
    allocations: Record<string, string | number>,
    invoices: OpenInvoiceLite[],
): string | null {
    if (!(amount > 0)) return 'Amount must be greater than zero';
    const byGuid = new Map(invoices.map((i) => [i.guid, i]));
    for (const [guid, raw] of Object.entries(allocations)) {
        const value = parseAmount(raw);
        if (value === 0) continue;
        if (value < 0) return 'Allocations cannot be negative';
        const inv = byGuid.get(guid);
        if (!inv) return 'Allocation references an unknown invoice';
        if (value > inv.amountDue + 0.005) {
            return `Allocation for ${inv.id} exceeds its amount due`;
        }
    }
    const total = allocationsTotal(allocations);
    if (Math.abs(total - roundCents(amount)) > 0.005) {
        return `Allocations (${total.toFixed(2)}) must add up to the payment amount (${roundCents(amount).toFixed(2)})`;
    }
    return null;
}

/** Non-zero allocations in API shape. */
export function allocationsToPayload(
    allocations: Record<string, string | number>,
): Array<{ invoiceGuid: string; amount: number }> {
    return Object.entries(allocations)
        .map(([invoiceGuid, v]) => ({ invoiceGuid, amount: parseAmount(v) }))
        .filter((a) => a.amount > 0);
}

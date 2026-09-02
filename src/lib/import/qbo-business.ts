/**
 * QuickBooks Online business records (pure — no database access).
 *
 * Two jobs:
 *
 * 1. Contact lists. The "Export data" ZIP carries Customers.xlsx,
 *    Vendors.xlsx and Employees.xlsx ("Customer/Vendor/Employee Contact
 *    List" reports): name, phone, email, contact person, multi-line
 *    address(es), vendor account number. parseQboContactRows() turns them
 *    into flat records for the GnuCash customers / vendors / employees tables.
 *
 * 2. Documents. The Journal tags every transaction with a QBO type and the
 *    customer/vendor name. Invoice / Credit Memo / Bill transactions become
 *    GnuCash invoices (owner customer) and bills (owner vendor), posted
 *    against the transaction the ledger import already creates: entries per
 *    income/expense line, a lot on the A/R–A/P account, and the A/R–A/P split
 *    carrying that lot. Payment / Bill Payment transactions are applied FIFO
 *    to the owner's open documents — the A/R–A/P split is divided across the
 *    lots it settles, mirroring gncOwnerApplyPayment. planQboDocuments()
 *    produces that plan; the service writes it inside the import transaction.
 */

import { round2, normHeader, type QboJournalTransaction } from './qbo-journal';
import { MONEY_DISPLAY_EPSILON } from '@/lib/tolerances';

/* ------------------------------------------------------------------ */
/* Contacts                                                             */
/* ------------------------------------------------------------------ */

export type ContactKind = 'customers' | 'vendors' | 'employees';

export interface QboContact {
    /** Display name (QBO "Customer"/"Vendor"/"Employee" column) */
    name: string;
    /** Contact person (QBO "Full Name"), '' when absent */
    contactName: string;
    phone: string;
    email: string;
    /** Up to 4 address lines */
    address: string[];
    /** Customers only: shipping address lines */
    shipAddress: string[];
    /** Vendors only: QBO "Account #" */
    accountNumber: string;
    /** 1-based sheet row */
    row: number;
}

interface ContactColumns {
    name: number;
    phone: number;
    email: number;
    fullName: number;
    address: number;
    shipAddress: number;
    accountNumber: number;
}

const NAME_HEADERS: Record<ContactKind, string[]> = {
    customers: ['customer', 'customer name', 'company name'],
    vendors: ['vendor', 'vendor name', 'supplier'],
    employees: ['employee', 'employee name'],
};

/** Detect a Contact List header row; returns the kind it belongs to. */
export function detectContactHeader(cells: string[]): { kind: ContactKind; cols: ContactColumns } | null {
    const norm = cells.map(normHeader);
    const find = (...names: string[]): number => {
        for (const n of names) {
            const idx = norm.findIndex((c) => c === n);
            if (idx >= 0) return idx;
        }
        return -1;
    };
    const phone = find('phone numbers', 'phone', 'phone number');
    const email = find('email', 'e-mail');
    if (phone < 0 && email < 0) return null;

    for (const kind of ['customers', 'vendors', 'employees'] as ContactKind[]) {
        const name = find(...NAME_HEADERS[kind]);
        if (name < 0) continue;
        return {
            kind,
            cols: {
                name,
                phone,
                email,
                fullName: find('full name', 'contact', 'contact name'),
                address: find('billing address', 'address', 'bill address'),
                shipAddress: find('shipping address', 'ship address'),
                accountNumber: find('account #', 'account no.', 'account number', 'acct #'),
            },
        };
    }
    return null;
}

export function detectContactListKind(rows: string[][]): ContactKind | null {
    for (let i = 0; i < Math.min(rows.length, 25); i++) {
        const hit = detectContactHeader(rows[i]);
        if (hit) return hit.kind;
    }
    return null;
}

/** "Phone: (225) 388-7451" / "Mobile: 720-270-5030" → the number. */
function cleanPhone(raw: string): string {
    return raw.replace(/^(phone|mobile|work|home|fax|cell)\s*:\s*/i, '').trim();
}

/** Multi-line cell → at most 4 address lines (extras fold into the last). */
export function splitAddressLines(raw: string): string[] {
    const lines = raw
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l !== '');
    if (lines.length <= 4) return lines;
    return [...lines.slice(0, 3), lines.slice(3).join(', ')];
}

export function parseQboContactRows(rows: string[][]): { kind: ContactKind; contacts: QboContact[] } | null {
    let headerIdx = -1;
    let detected: ReturnType<typeof detectContactHeader> = null;
    for (let i = 0; i < Math.min(rows.length, 25); i++) {
        detected = detectContactHeader(rows[i]);
        if (detected) {
            headerIdx = i;
            break;
        }
    }
    if (!detected) return null;
    const { kind, cols } = detected;
    const cell = (row: string[], idx: number): string => (idx >= 0 && idx < row.length ? row[idx] : '');

    const contacts: QboContact[] = [];
    const seen = new Set<string>();
    for (let i = headerIdx + 1; i < rows.length; i++) {
        const row = rows[i];
        // QBO marks some employees with a leading "*"; the name is what follows.
        const name = cell(row, cols.name).replace(/^\*\s*/, '').trim();
        if (!name) continue; // blank rows and the report footer (label in col 0)
        const key = name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        contacts.push({
            name,
            contactName: cell(row, cols.fullName).trim(),
            phone: cleanPhone(cell(row, cols.phone)),
            email: cell(row, cols.email).trim(),
            address: splitAddressLines(cell(row, cols.address)),
            shipAddress: splitAddressLines(cell(row, cols.shipAddress)),
            accountNumber: cell(row, cols.accountNumber).trim(),
            row: i + 1,
        });
    }
    return { kind, contacts };
}

/* ------------------------------------------------------------------ */
/* Documents                                                            */
/* ------------------------------------------------------------------ */

export type DocumentKind = 'invoice' | 'bill';

export interface PlannedEntry {
    accountPath: string;
    /** Unit price (quantity is always 1): positive for a normal line */
    price: number;
    description: string;
}

export interface PlannedDocument {
    /** Index into the journal transaction array */
    txIndex: number;
    kind: DocumentKind;
    /** Customer (invoice) or vendor (bill) name as it appears in the journal */
    ownerName: string;
    /** QBO document number, or a generated one when the export has none */
    id: string;
    date: string;
    notes: string;
    /** A/R (invoice) or A/P (bill) account path the posting split sits on */
    postAccountPath: string;
    /** Index of that split in the transaction's lines */
    postLineIndex: number;
    /** Document total (positive; a credit memo is negative) */
    total: number;
    entries: PlannedEntry[];
    /** Sum of allocated payments (filled by the planner) */
    paid: number;
}

export interface PaymentAllocation {
    /** Index into plan.documents */
    docIndex: number;
    amount: number;
}

/**
 * A credit note (negative document) applied against an invoice: written as
 * a pair of zero-sum A/R–A/P splits on the payment transaction, one in each
 * lot — exactly what QuickBooks' "Created by QB Online to link credits to
 * charges" zero-amount payments represent.
 */
export interface CreditLink {
    /** Index into plan.documents of the credit note / vendor credit */
    creditDocIndex: number;
    /** Index into plan.documents of the invoice / bill it offsets */
    docIndex: number;
    amount: number;
}

export interface PlannedPayment {
    txIndex: number;
    kind: DocumentKind;
    ownerName: string;
    /** Line index of the A/R–A/P split being applied */
    lineIndex: number;
    /** Absolute amount of that split */
    amount: number;
    allocations: PaymentAllocation[];
    /** Credit notes applied to open documents on this payment */
    creditLinks: CreditLink[];
    /** Portion with no open document to settle (prepayment / overpayment) */
    unallocated: number;
}

export interface DocumentPlan {
    documents: PlannedDocument[];
    payments: PlannedPayment[];
    /** Journal transactions that looked like documents but could not become one */
    skipped: Array<{ txIndex: number; type: string; name: string; date: string; reason: string }>;
}

const INVOICE_TYPES = new Set(['invoice', 'credit memo', 'sales receipt']);
const BILL_TYPES = new Set(['bill', 'vendor credit']);
const CUSTOMER_PAYMENT_TYPES = new Set(['payment', 'receive payment', 'customer payment']);
const BILL_PAYMENT_TYPES = new Set(['bill payment (check)', 'bill payment (credit card)', 'bill payment', 'bill payment (cash)']);

export interface PlanInput {
    transactions: QboJournalTransaction[];
    /** Journal account path → GnuCash account type (RECEIVABLE/PAYABLE decide the posting split) */
    accountTypeByPath: Map<string, string>;
    /** Known customer / vendor display names (case-insensitive match) */
    customerNames: Iterable<string>;
    vendorNames: Iterable<string>;
    /** Existing numeric ids per kind, so generated ids do not collide */
    existingIds?: { invoice: string[]; bill: string[] };
}

function lowerSet(names: Iterable<string>): Set<string> {
    const s = new Set<string>();
    for (const n of names) s.add(n.trim().toLowerCase());
    return s;
}

function maxNumericId(ids: string[]): number {
    let max = 0;
    for (const id of ids) {
        const t = id.trim();
        if (/^\d+$/.test(t)) max = Math.max(max, parseInt(t, 10));
    }
    return max;
}

/**
 * Plan invoices/bills and their payments from the journal. Transactions are
 * visited in date order — documents before payments on the same day — so
 * FIFO allocation sees invoices before the payments that settle them.
 *
 * Credit memos / vendor credits become negative documents ("credit notes").
 * Whenever a payment for that owner is processed, open credit notes are
 * first applied FIFO to the owner's open invoices (as zero-sum lot links),
 * then the payment's own amount is allocated.
 */
export function planQboDocuments(input: PlanInput): DocumentPlan {
    const customers = lowerSet(input.customerNames);
    const vendors = lowerSet(input.vendorNames);
    const documents: PlannedDocument[] = [];
    const payments: PlannedPayment[] = [];
    const skipped: DocumentPlan['skipped'] = [];

    // Open documents per (kind, owner) in creation order for FIFO.
    const openByOwner = new Map<string, number[]>();
    const ownerKey = (kind: DocumentKind, name: string) => `${kind} ${name.trim().toLowerCase()}`;

    let nextInvoiceNum = maxNumericId(input.existingIds?.invoice ?? []);
    let nextBillNum = maxNumericId(input.existingIds?.bill ?? []);
    const seenIds = { invoice: new Set<string>(), bill: new Set<string>() };

    const isPaymentType = (t: QboJournalTransaction) => {
        const n = normHeader(t.type);
        return CUSTOMER_PAYMENT_TYPES.has(n) || BILL_PAYMENT_TYPES.has(n);
    };
    const order = input.transactions
        .map((t, i) => ({ t, i, pay: isPaymentType(t) ? 1 : 0 }))
        .sort((a, b) =>
            a.t.date < b.t.date ? -1 : a.t.date > b.t.date ? 1 : a.pay !== b.pay ? a.pay - b.pay : a.i - b.i
        );

    /** Open credit notes (total < 0) per owner key, creation order. */
    const creditsByOwner = new Map<string, number[]>();
    const dueOf = (d: PlannedDocument) => round2(d.total - d.paid);

    /** Apply the owner's open credit notes FIFO against open documents. */
    const applyCredits = (key: string): CreditLink[] => {
        const links: CreditLink[] = [];
        const credits = creditsByOwner.get(key) ?? [];
        const open = openByOwner.get(key) ?? [];
        while (credits.length > 0 && open.length > 0) {
            const credit = documents[credits[0]];
            const available = round2(-dueOf(credit)); // credit still unapplied (positive)
            if (available <= MONEY_DISPLAY_EPSILON) {
                credits.shift();
                continue;
            }
            const doc = documents[open[0]];
            const due = dueOf(doc);
            if (due <= MONEY_DISPLAY_EPSILON) {
                open.shift();
                continue;
            }
            const take = round2(Math.min(available, due));
            links.push({ creditDocIndex: credits[0], docIndex: open[0], amount: take });
            doc.paid = round2(doc.paid + take);
            credit.paid = round2(credit.paid - take);
            if (dueOf(doc) <= MONEY_DISPLAY_EPSILON) open.shift();
            if (round2(-dueOf(credit)) <= MONEY_DISPLAY_EPSILON) credits.shift();
        }
        return links;
    };

    for (const { t, i } of order) {
        const type = normHeader(t.type);
        const name = t.name.trim();
        const isInvoiceLike = INVOICE_TYPES.has(type);
        const isBillLike = BILL_TYPES.has(type);
        const isCustomerPayment = CUSTOMER_PAYMENT_TYPES.has(type);
        const isBillPayment = BILL_PAYMENT_TYPES.has(type);
        if (!isInvoiceLike && !isBillLike && !isCustomerPayment && !isBillPayment) continue;

        const kind: DocumentKind = isInvoiceLike || isCustomerPayment ? 'invoice' : 'bill';
        const postType = kind === 'invoice' ? 'RECEIVABLE' : 'PAYABLE';
        const known = kind === 'invoice' ? customers : vendors;
        const skip = (reason: string) => skipped.push({ txIndex: i, type: t.type, name, date: t.date, reason });

        if (!name) {
            skip('no customer/vendor name on the transaction');
            continue;
        }
        if (!known.has(name.toLowerCase())) {
            skip(`"${name}" is not in the ${kind === 'invoice' ? 'customer' : 'vendor'} list`);
            continue;
        }
        const postLines = t.lines
            .map((l, idx) => ({ l, idx }))
            .filter(({ l }) => input.accountTypeByPath.get(l.accountPath) === postType);
        if (postLines.length === 0) {
            skip(`no ${kind === 'invoice' ? 'Accounts Receivable' : 'Accounts Payable'} line`);
            continue;
        }

        if (isInvoiceLike || isBillLike) {
            if (postLines.length !== 1) {
                skip(`${postLines.length} ${postType === 'RECEIVABLE' ? 'A/R' : 'A/P'} lines on one document`);
                continue;
            }
            const { l: postLine, idx: postLineIndex } = postLines[0];
            // Invoice: A/R debit (+); bill: A/P credit (−). Total is the document's face value.
            // Credit Memo / Vendor Credit rows carry the opposite sign and
            // become negative documents (credit notes).
            const total = round2(kind === 'invoice' ? postLine.amount : -postLine.amount);
            if (total === 0) {
                skip('zero-amount document (voided)');
                continue;
            }
            const entries: PlannedEntry[] = t.lines
                .filter((_, idx) => idx !== postLineIndex)
                .map((l) => ({
                    accountPath: l.accountPath,
                    // Invoice lines are credits (−) on income → positive price;
                    // bill lines are debits (+) on expense → positive price.
                    price: round2(kind === 'invoice' ? -l.amount : l.amount),
                    description: l.memo || t.memo || '',
                }));

            let id = t.num.trim();
            const ids = seenIds[kind];
            if (!id || ids.has(id)) {
                if (kind === 'invoice') id = String(++nextInvoiceNum).padStart(6, '0');
                else id = String(++nextBillNum).padStart(6, '0');
                while (ids.has(id)) {
                    id = String(kind === 'invoice' ? ++nextInvoiceNum : ++nextBillNum).padStart(6, '0');
                }
            } else if (/^\d+$/.test(id)) {
                const n = parseInt(id, 10);
                if (kind === 'invoice') nextInvoiceNum = Math.max(nextInvoiceNum, n);
                else nextBillNum = Math.max(nextBillNum, n);
            }
            ids.add(id);

            const docIndex = documents.length;
            documents.push({
                txIndex: i,
                kind,
                ownerName: name,
                id,
                date: t.date,
                notes: t.memo || '',
                postAccountPath: postLine.accountPath,
                postLineIndex,
                total,
                entries,
                paid: 0,
            });
            const key = ownerKey(kind, name);
            const bucket = total < 0 ? creditsByOwner : openByOwner;
            const list = bucket.get(key) ?? [];
            list.push(docIndex);
            bucket.set(key, list);
            continue;
        }

        // Payment: apply pending credit notes, then settle the owner's open
        // documents FIFO. A customer payment credits A/R (−); a bill payment
        // debits A/P (+).
        const key = ownerKey(kind, name);
        let creditLinks = applyCredits(key);
        for (const { l, idx } of postLines) {
            let remaining = round2(kind === 'invoice' ? -l.amount : l.amount);
            const allocations: PaymentAllocation[] = [];
            if (remaining <= 0) {
                // Zero line (QBO credit-link payment) or a refund / reversal:
                // nothing of its own to allocate.
                payments.push({
                    txIndex: i,
                    kind,
                    ownerName: name,
                    lineIndex: idx,
                    amount: round2(Math.abs(remaining)),
                    allocations,
                    creditLinks,
                    unallocated: round2(Math.abs(remaining)),
                });
                creditLinks = [];
                continue;
            }
            const open = openByOwner.get(key) ?? [];
            while (remaining > MONEY_DISPLAY_EPSILON && open.length > 0) {
                const docIndex = open[0];
                const doc = documents[docIndex];
                const due = dueOf(doc);
                if (due <= MONEY_DISPLAY_EPSILON) {
                    open.shift();
                    continue;
                }
                const take = round2(Math.min(due, remaining));
                allocations.push({ docIndex, amount: take });
                doc.paid = round2(doc.paid + take);
                remaining = round2(remaining - take);
                if (dueOf(doc) <= MONEY_DISPLAY_EPSILON) open.shift();
            }
            payments.push({
                txIndex: i,
                kind,
                ownerName: name,
                lineIndex: idx,
                amount: round2(kind === 'invoice' ? -l.amount : l.amount),
                allocations,
                creditLinks,
                unallocated: remaining,
            });
            creditLinks = [];
        }
    }

    // Second pass: prepayments. A payment dated before the document it
    // settles (QBO lets you receive against a later invoice, or pay a bill
    // before it is entered) still has its remainder; apply it to whatever of
    // the owner's documents is still open, oldest first.
    for (const p of payments) {
        if (p.unallocated <= MONEY_DISPLAY_EPSILON || p.amount <= MONEY_DISPLAY_EPSILON) continue;
        const open = openByOwner.get(ownerKey(p.kind, p.ownerName)) ?? [];
        let remaining = p.unallocated;
        while (remaining > MONEY_DISPLAY_EPSILON && open.length > 0) {
            const doc = documents[open[0]];
            const due = dueOf(doc);
            if (due <= MONEY_DISPLAY_EPSILON) {
                open.shift();
                continue;
            }
            const take = round2(Math.min(due, remaining));
            p.allocations.push({ docIndex: open[0], amount: take });
            doc.paid = round2(doc.paid + take);
            remaining = round2(remaining - take);
            if (dueOf(doc) <= MONEY_DISPLAY_EPSILON) open.shift();
        }
        p.unallocated = remaining;
    }

    return { documents, payments, skipped };
}

/** Summary counts for the preview. */
export function summarizeDocumentPlan(plan: DocumentPlan): {
    invoices: number;
    /** Credit memos / vendor credits (negative documents) */
    creditNotes: number;
    bills: number;
    customerPayments: number;
    billPayments: number;
    paidInFull: number;
    partiallyPaid: number;
    unallocatedPayments: number;
    unallocatedAmount: number;
    skipped: number;
} {
    let paidInFull = 0;
    let partiallyPaid = 0;
    for (const d of plan.documents) {
        if (Math.abs(round2(d.total - d.paid)) <= MONEY_DISPLAY_EPSILON) paidInFull++;
        else if (d.paid !== 0) partiallyPaid++;
    }
    const unallocated = plan.payments.filter((p) => p.unallocated > MONEY_DISPLAY_EPSILON);
    return {
        invoices: plan.documents.filter((d) => d.kind === 'invoice' && d.total > 0).length,
        creditNotes: plan.documents.filter((d) => d.total < 0).length,
        bills: plan.documents.filter((d) => d.kind === 'bill' && d.total > 0).length,
        customerPayments: plan.payments.filter((p) => p.kind === 'invoice').length,
        billPayments: plan.payments.filter((p) => p.kind === 'bill').length,
        paidInFull,
        partiallyPaid,
        unallocatedPayments: unallocated.length,
        unallocatedAmount: round2(unallocated.reduce((s, p) => s + p.unallocated, 0)),
        skipped: plan.skipped.length,
    };
}

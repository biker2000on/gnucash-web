'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Modal } from '@/components/ui/Modal';
import { ConfirmationDialog } from '@/components/ui/ConfirmationDialog';
import { PageHeader } from '@/components/ui/PageHeader';
import { AccountSelector } from '@/components/ui/AccountSelector';
import { OwnerSelector, type OwnerDTO } from '@/components/business/OwnerSelector';
import { PaymentModal } from '@/components/business/PaymentModal';
import { InvoiceFulfillmentSection } from '@/components/business/InvoiceFulfillmentSection';
import { useToast } from '@/contexts/ToastContext';
import { useCurrentUser, READONLY_TOOLTIP } from '@/hooks/useCurrentUser';
import { useAccounts } from '@/lib/hooks/useAccounts';
import { formatCurrency } from '@/lib/format';
import type { InvoiceDetailView, PaymentView } from '@/lib/business/invoice-engine';
import type { BilltermDTO, TaxtableDTO, JobDTO } from '@/lib/business-types';
import {
    STATUS_META,
    type InvoiceKind,
    type EntryDraft,
    emptyEntryDraft,
    entryViewToDraft,
    entryDraftToPayload,
    isBlankDraft,
    computeEntryPreview,
    computeTotalsPreview,
    dueDateFromTerm,
    todayIso,
} from '@/components/business/invoice-ui';

const TNUM = { fontFeatureSettings: "'tnum'" } as const;
const inputClass = 'w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder-foreground-muted focus:outline-none focus:border-primary/50 transition-all';
const cellInputClass = 'w-full bg-input-bg border border-border rounded-md px-2 py-1 text-[13px] text-foreground placeholder-foreground-muted focus:outline-none focus:border-primary/50 transition-all';
const labelClass = 'block text-xs font-medium text-foreground-secondary mb-1';

interface HeaderForm {
    id: string;
    dateOpened: string;
    billingId: string;
    termsGuid: string;
    notes: string;
}

function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function InvoiceDetailContent() {
    const params = useParams<{ guid: string }>();
    const searchParams = useSearchParams();
    const router = useRouter();
    const { success, error } = useToast();
    const { isReadonly } = useCurrentUser();

    const routeGuid = params.guid;
    const isNew = routeGuid === 'new';
    const newKind: InvoiceKind = searchParams.get('type') === 'bill' ? 'bill' : 'invoice';

    const [invoice, setInvoice] = useState<InvoiceDetailView | null>(null);
    const [loading, setLoading] = useState(!isNew);
    const [notFound, setNotFound] = useState(false);

    // Draft editing state
    const [header, setHeader] = useState<HeaderForm>({
        id: '', dateOpened: todayIso(), billingId: '', termsGuid: '', notes: '',
    });
    const [entries, setEntries] = useState<EntryDraft[]>(isNew ? [emptyEntryDraft()] : []);
    /** Last-saved row state by key — Escape restores a row from here. */
    const savedRowsRef = useRef<Map<string, EntryDraft>>(new Map());
    const [dirty, setDirty] = useState(false);
    const [saving, setSaving] = useState(false);

    // New-invoice owner selection (owner is fixed after creation — the API
    // does not support changing an invoice's owner).
    const [newOwnerGuid, setNewOwnerGuid] = useState('');
    const [newOwner, setNewOwner] = useState<OwnerDTO | null>(null);

    // Reference data
    const [billterms, setBillterms] = useState<BilltermDTO[]>([]);
    const [taxtables, setTaxtables] = useState<TaxtableDTO[]>([]);
    const [currencyByGuid, setCurrencyByGuid] = useState<Record<string, string>>({});

    // Actions
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [postOpen, setPostOpen] = useState(false);
    const [postDate, setPostDate] = useState(todayIso());
    const [postDueDate, setPostDueDate] = useState(todayIso());
    const [postDueTouched, setPostDueTouched] = useState(false);
    const [postMemo, setPostMemo] = useState('');
    const [posting, setPosting] = useState(false);
    const [confirmUnpost, setConfirmUnpost] = useState(false);
    const [unposting, setUnposting] = useState(false);
    const [paymentOpen, setPaymentOpen] = useState(false);

    // Posted-side data
    const [payments, setPayments] = useState<PaymentView[]>([]);
    const [endOwner, setEndOwner] = useState<{ type: 'customer' | 'vendor'; guid: string; name: string } | null>(null);
    const [ownerDto, setOwnerDto] = useState<OwnerDTO | null>(null);

    const kind: InvoiceKind = invoice?.type ?? newKind;
    const isDraft = isNew || !invoice?.posted;
    const singular = kind === 'invoice' ? 'Invoice' : 'Bill';
    const ownerKind = kind === 'invoice' ? 'customer' as const : 'vendor' as const;
    const entryAccountTypes = kind === 'invoice' ? ['INCOME'] : ['EXPENSE'];

    const currency = invoice
        ? (currencyByGuid[invoice.currencyGuid] ?? 'USD')
        : (newOwner?.currency ?? 'USD');

    const taxtableByGuid = useMemo(() => {
        const map = new Map<string, TaxtableDTO>();
        for (const t of taxtables) map.set(t.guid, t);
        return map;
    }, [taxtables]);

    const termByGuid = useMemo(() => {
        const map = new Map<string, BilltermDTO>();
        for (const t of billterms) map.set(t.guid, t);
        return map;
    }, [billterms]);

    // ------------------------------------------------------------------
    // Data loading
    // ------------------------------------------------------------------

    const applyInvoice = useCallback((inv: InvoiceDetailView) => {
        setInvoice(inv);
        setHeader({
            id: inv.id,
            dateOpened: inv.dateOpened ?? todayIso(),
            billingId: inv.billingId ?? '',
            termsGuid: inv.termsGuid ?? '',
            notes: inv.notes ?? '',
        });
        const drafts = inv.entries.map(entryViewToDraft);
        setEntries(inv.posted ? drafts : [...drafts]);
        savedRowsRef.current = new Map(drafts.map((d) => [d.key, { ...d }]));
        setDirty(false);
    }, []);

    const fetchInvoice = useCallback(async () => {
        if (isNew) return;
        try {
            const res = await fetch(`/api/business/invoices/${routeGuid}`);
            const data = await res.json().catch(() => null);
            if (res.status === 404) {
                setNotFound(true);
                return;
            }
            if (!res.ok) throw new Error(data?.error || 'Failed to load invoice');
            applyInvoice(data.invoice);
        } catch (err) {
            error(err instanceof Error ? err.message : 'Failed to load invoice');
        } finally {
            setLoading(false);
        }
    }, [isNew, routeGuid, applyInvoice, error]);

    useEffect(() => { fetchInvoice(); }, [fetchInvoice]);

    useEffect(() => {
        fetch('/api/business/billterms')
            .then((res) => (res.ok ? res.json() : []))
            .then(setBillterms)
            .catch(() => {});
        fetch('/api/business/taxtables')
            .then((res) => (res.ok ? res.json() : []))
            .then(setTaxtables)
            .catch(() => {});
        fetch('/api/commodities?type=CURRENCY')
            .then((res) => (res.ok ? res.json() : []))
            .then((rows: Array<{ guid: string; mnemonic: string }>) => {
                const map: Record<string, string> = {};
                for (const r of rows) map[r.guid] = r.mnemonic;
                setCurrencyByGuid(map);
            })
            .catch(() => {});
    }, []);

    // Resolve the end owner (jobs resolve to their customer/vendor) for
    // payments and the printable address block.
    useEffect(() => {
        if (!invoice) return;
        let cancelled = false;
        const resolve = async () => {
            let type: 'customer' | 'vendor' = invoice.type === 'invoice' ? 'customer' : 'vendor';
            let guid = invoice.ownerGuid;
            let name = invoice.ownerName;
            if (invoice.ownerType === 'job') {
                try {
                    const res = await fetch(`/api/business/jobs/${invoice.ownerGuid}`);
                    if (res.ok) {
                        const job: JobDTO = await res.json();
                        if (job.ownerType && job.ownerGuid) {
                            type = job.ownerType;
                            guid = job.ownerGuid;
                            name = job.ownerName ?? name;
                        }
                    }
                } catch { /* keep defaults */ }
            }
            if (!cancelled) setEndOwner({ type, guid, name });
            try {
                const res = await fetch(`/api/business/${type}s/${guid}`);
                if (res.ok && !cancelled) setOwnerDto(await res.json());
            } catch { /* address block just stays empty */ }
        };
        resolve();
        return () => { cancelled = true; };
    }, [invoice]);

    const fetchPayments = useCallback(async () => {
        if (!invoice?.posted || !endOwner) return;
        try {
            const res = await fetch(`/api/business/payments?ownerType=${endOwner.type}&ownerGuid=${endOwner.guid}`);
            const data = await res.json().catch(() => null);
            if (!res.ok) return;
            const relevant = (data.payments as PaymentView[]).filter((p) =>
                p.allocations.some((a) => a.invoiceGuid === invoice.guid),
            );
            setPayments(relevant);
        } catch { /* payment history is non-critical */ }
    }, [invoice, endOwner]);

    useEffect(() => { fetchPayments(); }, [fetchPayments]);

    // ------------------------------------------------------------------
    // Entry editing
    // ------------------------------------------------------------------

    const updateEntry = (key: string, patch: Partial<EntryDraft>) => {
        setEntries((prev) => prev.map((e) => (e.key === key ? { ...e, ...patch } : e)));
        setDirty(true);
    };

    const addRow = () => {
        setEntries((prev) => [...prev, emptyEntryDraft()]);
        setDirty(true);
    };

    const removeRow = (key: string) => {
        setEntries((prev) => {
            const next = prev.filter((e) => e.key !== key);
            return next.length > 0 ? next : [emptyEntryDraft()];
        });
        setDirty(true);
    };

    /** Escape restores the row from its last-saved state (or blanks a new row). */
    const revertRow = (key: string) => {
        const saved = savedRowsRef.current.get(key);
        setEntries((prev) => prev.map((e) => {
            if (e.key !== key) return e;
            return saved ? { ...saved } : { ...emptyEntryDraft(), key: e.key };
        }));
    };

    const handleRowKeyDown = (e: React.KeyboardEvent, key: string, isLastRow: boolean) => {
        if (e.key === 'Enter' && isLastRow) {
            e.preventDefault();
            addRow();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            revertRow(key);
            (e.target as HTMLElement).blur();
        }
    };

    const previews = useMemo(
        () => entries.map((d) => computeEntryPreview(d, kind, d.taxTableGuid ? taxtableByGuid.get(d.taxTableGuid) : null)),
        [entries, kind, taxtableByGuid],
    );
    const totals = useMemo(() => computeTotalsPreview(previews), [previews]);

    // ------------------------------------------------------------------
    // Actions
    // ------------------------------------------------------------------

    const handleSave = async () => {
        const rows = entries.filter((d) => !isBlankDraft(d));
        if (isNew && !newOwnerGuid) {
            error(`Select a ${ownerKind} first`);
            return;
        }
        if (rows.length === 0) {
            error('At least one line with an account is required');
            return;
        }
        const missingAccount = rows.find((d) => !d.accountGuid);
        if (missingAccount) {
            error('Every line needs an account');
            return;
        }
        setSaving(true);
        try {
            const entriesPayload = rows.map((d) => entryDraftToPayload(d, kind));
            let res: Response;
            if (isNew) {
                res = await fetch('/api/business/invoices', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        ownerType: ownerKind,
                        ownerGuid: newOwnerGuid,
                        id: header.id.trim() || undefined,
                        dateOpened: header.dateOpened,
                        notes: header.notes,
                        billingId: header.billingId,
                        termsGuid: header.termsGuid || null,
                        entries: entriesPayload,
                    }),
                });
            } else {
                res = await fetch(`/api/business/invoices/${routeGuid}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        id: header.id.trim() || undefined,
                        dateOpened: header.dateOpened,
                        notes: header.notes,
                        billingId: header.billingId,
                        termsGuid: header.termsGuid || null,
                        entries: entriesPayload,
                    }),
                });
            }
            const data = await res.json().catch(() => null);
            if (!res.ok) throw new Error(data?.error || `Failed to save ${singular.toLowerCase()}`);
            success(isNew ? `${singular} ${data.invoice.id} created` : `${singular} saved`);
            if (isNew) {
                router.replace(`/business/invoices/${data.invoice.guid}`);
            } else {
                applyInvoice(data.invoice);
            }
        } catch (err) {
            error(err instanceof Error ? err.message : `Failed to save ${singular.toLowerCase()}`);
        } finally {
            setSaving(false);
        }
    };

    const handleDelete = async () => {
        setDeleting(true);
        try {
            const res = await fetch(`/api/business/invoices/${routeGuid}`, { method: 'DELETE' });
            const data = await res.json().catch(() => null);
            if (!res.ok) throw new Error(data?.error || `Failed to delete ${singular.toLowerCase()}`);
            success(`${singular} deleted`);
            router.push(`/business/invoices${kind === 'bill' ? '?type=bill' : ''}`);
        } catch (err) {
            error(err instanceof Error ? err.message : `Failed to delete ${singular.toLowerCase()}`);
            setDeleting(false);
            setConfirmDelete(false);
        }
    };

    const openPostModal = () => {
        const today = todayIso();
        setPostDate(today);
        setPostDueTouched(false);
        setPostDueDate(dueDateFromTerm(today, header.termsGuid ? termByGuid.get(header.termsGuid) : null));
        setPostMemo('');
        setPostOpen(true);
    };

    const handlePostDateChange = (value: string) => {
        setPostDate(value);
        if (!postDueTouched && value) {
            setPostDueDate(dueDateFromTerm(value, header.termsGuid ? termByGuid.get(header.termsGuid) : null));
        }
    };

    const handlePost = async (e?: React.FormEvent) => {
        e?.preventDefault();
        if (!postDate) {
            error('Post date is required');
            return;
        }
        setPosting(true);
        try {
            const res = await fetch(`/api/business/invoices/${routeGuid}/post`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    postDate,
                    dueDate: postDueDate || undefined,
                    memo: postMemo || undefined,
                }),
            });
            const data = await res.json().catch(() => null);
            if (!res.ok) throw new Error(data?.error || `Failed to post ${singular.toLowerCase()}`);
            success(`${singular} posted — due ${data.result.dueDate}`);
            setPostOpen(false);
            await fetchInvoice();
        } catch (err) {
            error(err instanceof Error ? err.message : `Failed to post ${singular.toLowerCase()}`);
        } finally {
            setPosting(false);
        }
    };

    const handleUnpost = async () => {
        setUnposting(true);
        try {
            const res = await fetch(`/api/business/invoices/${routeGuid}/post`, { method: 'DELETE' });
            const data = await res.json().catch(() => null);
            if (!res.ok) throw new Error(data?.error || `Failed to unpost ${singular.toLowerCase()}`);
            success(`${singular} unposted — it is a draft again`);
            setConfirmUnpost(false);
            setPayments([]);
            await fetchInvoice();
        } catch (err) {
            // 409 when payments are attached comes through here with the API message.
            error(err instanceof Error ? err.message : `Failed to unpost ${singular.toLowerCase()}`);
            setConfirmUnpost(false);
        } finally {
            setUnposting(false);
        }
    };

    // ------------------------------------------------------------------
    // Print
    // ------------------------------------------------------------------

    const handlePrint = () => {
        if (!invoice) return;
        const label = kind === 'invoice' ? 'INVOICE' : 'BILL';
        const addr = ownerDto?.address;
        const addressLines = [addr?.name, addr?.addr1, addr?.addr2, addr?.addr3, addr?.addr4]
            .filter((l): l is string => Boolean(l && l.trim()))
            .map((l) => escapeHtml(l))
            .join('<br>');
        const showDiscount = kind === 'invoice' && invoice.entries.some((e) => e.computed.discountValue !== 0);
        const showTax = invoice.entries.some((e) => e.computed.taxTotal !== 0);

        const rows = invoice.entries.map((e) => `
            <tr>
                <td>${escapeHtml(e.date ?? '')}</td>
                <td>${escapeHtml(e.description)}</td>
                <td class="num">${e.quantity}</td>
                <td class="num">${formatCurrency(e.price, currency)}</td>
                ${showDiscount ? `<td class="num">${e.computed.discountValue ? formatCurrency(e.computed.discountValue, currency) : ''}</td>` : ''}
                ${showTax ? `<td class="num">${e.computed.taxTotal ? formatCurrency(e.computed.taxTotal, currency) : ''}</td>` : ''}
                <td class="num">${formatCurrency(e.computed.gross, currency)}</td>
            </tr>`).join('');

        const totalsRows = [
            `<tr><td>Subtotal</td><td class="num">${formatCurrency(invoice.totals.subtotal, currency)}</td></tr>`,
            invoice.totals.discountTotal !== 0
                ? `<tr><td>Discount</td><td class="num">−${formatCurrency(invoice.totals.discountTotal, currency)}</td></tr>` : '',
            invoice.totals.taxTotal !== 0
                ? `<tr><td>Tax</td><td class="num">${formatCurrency(invoice.totals.taxTotal, currency)}</td></tr>` : '',
            `<tr class="grand"><td>Total</td><td class="num">${formatCurrency(invoice.totals.total, currency)}</td></tr>`,
            invoice.posted
                ? `<tr class="grand"><td>Amount due</td><td class="num">${formatCurrency(invoice.amountDue, currency)}</td></tr>` : '',
        ].join('');

        const printWindow = window.open('', '_blank', 'width=800,height=600');
        if (!printWindow) return;
        printWindow.document.write(`
            <!DOCTYPE html>
            <html>
            <head>
                <title></title>
                <style>
                    * { box-sizing: border-box; color: #000; }
                    body { font-family: 'Segoe UI', Arial, sans-serif; font-size: 12px; margin: 0; padding: 1cm; }
                    h1 { font-size: 22px; letter-spacing: 0.15em; margin: 0; }
                    .head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 24px; }
                    .meta { text-align: right; font-size: 12px; }
                    .meta div { margin-bottom: 2px; }
                    .meta .id { font-size: 15px; font-weight: 700; }
                    .party { margin-bottom: 24px; }
                    .party .label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.1em; color: #555; margin-bottom: 4px; }
                    .party .name { font-weight: 700; font-size: 14px; }
                    table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
                    th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; border-bottom: 1.5px solid #333; padding: 6px 8px; }
                    td { padding: 6px 8px; border-bottom: 1px solid #ddd; vertical-align: top; }
                    .num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
                    .totals { width: 280px; margin-left: auto; }
                    .totals td { border-bottom: none; padding: 3px 8px; }
                    .totals .grand td { font-weight: 700; border-top: 1px solid #333; }
                    .notes { margin-top: 24px; font-size: 11px; color: #444; white-space: pre-wrap; }
                    .draft { color: #999; font-weight: 400; }
                    @media print {
                        @page { margin: 0; size: auto; }
                        body { margin: 0; padding: 1cm; }
                    }
                </style>
            </head>
            <body>
                <div class="head">
                    <h1>${label}${invoice.posted ? '' : ' <span class="draft">(DRAFT)</span>'}</h1>
                    <div class="meta">
                        <div class="id"># ${escapeHtml(invoice.id)}</div>
                        <div>Opened: ${escapeHtml(invoice.dateOpened ?? '—')}</div>
                        ${invoice.datePosted ? `<div>Posted: ${escapeHtml(invoice.datePosted)}</div>` : ''}
                        ${invoice.dueDate ? `<div>Due: ${escapeHtml(invoice.dueDate)}</div>` : ''}
                        ${invoice.billingId ? `<div>Billing ID: ${escapeHtml(invoice.billingId)}</div>` : ''}
                    </div>
                </div>
                <div class="party">
                    <div class="label">${kind === 'invoice' ? 'Bill to' : 'Vendor'}</div>
                    <div class="name">${escapeHtml(endOwner?.name ?? invoice.ownerName)}</div>
                    ${addressLines ? `<div>${addressLines}</div>` : ''}
                </div>
                <table>
                    <thead>
                        <tr>
                            <th>Date</th>
                            <th>Description</th>
                            <th class="num">Qty</th>
                            <th class="num">Unit price</th>
                            ${showDiscount ? '<th class="num">Discount</th>' : ''}
                            ${showTax ? '<th class="num">Tax</th>' : ''}
                            <th class="num">Amount</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
                <table class="totals">${totalsRows}</table>
                ${invoice.notes ? `<div class="notes">${escapeHtml(invoice.notes)}</div>` : ''}
            </body>
            </html>
        `);
        printWindow.document.close();
        printWindow.focus();
        printWindow.print();
        printWindow.close();
    };

    // ------------------------------------------------------------------
    // Render
    // ------------------------------------------------------------------

    if (notFound) {
        return (
            <div className="p-12 text-center text-foreground-muted">
                {singular} not found.{' '}
                <Link href="/business/invoices" className="text-primary hover:text-primary-hover">Back to invoices</Link>
            </div>
        );
    }

    if (loading) {
        return (
            <div className="p-12 flex items-center justify-center gap-3">
                <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                <span className="text-foreground-secondary">Loading {singular.toLowerCase()}...</span>
            </div>
        );
    }

    const status = invoice?.status ?? 'draft';
    const statusMeta = STATUS_META[status];
    const title = isNew ? `New ${singular}` : `${singular} ${invoice?.id ?? ''}`;

    const draftActions = (
        <>
            {!isNew && (
                <button
                    type="button"
                    onClick={() => setConfirmDelete(true)}
                    disabled={isReadonly}
                    title={isReadonly ? READONLY_TOOLTIP : undefined}
                    className="px-3 py-2 text-sm text-negative hover:bg-negative/10 rounded-lg transition-colors disabled:opacity-50"
                >
                    Delete
                </button>
            )}
            <button
                type="button"
                onClick={handleSave}
                disabled={saving || isReadonly}
                title={isReadonly ? READONLY_TOOLTIP : undefined}
                className="px-4 py-2 text-sm bg-primary hover:bg-primary-hover disabled:bg-primary/50 disabled:cursor-not-allowed text-primary-foreground rounded-lg transition-colors"
            >
                {saving ? 'Saving...' : isNew ? `Create ${singular}` : 'Save'}
            </button>
            {!isNew && (
                <button
                    type="button"
                    onClick={openPostModal}
                    disabled={isReadonly || dirty}
                    title={isReadonly ? READONLY_TOOLTIP : dirty ? 'Save changes before posting' : undefined}
                    className="px-4 py-2 text-sm bg-secondary-light text-secondary hover:opacity-80 rounded-lg transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    Post...
                </button>
            )}
        </>
    );

    const postedActions = (
        <>
            <button
                type="button"
                onClick={handlePrint}
                className="px-3 py-2 text-sm text-foreground-secondary hover:text-foreground hover:bg-surface-hover rounded-lg transition-colors"
            >
                Print
            </button>
            <button
                type="button"
                onClick={() => setConfirmUnpost(true)}
                disabled={isReadonly}
                title={isReadonly ? READONLY_TOOLTIP : undefined}
                className="px-3 py-2 text-sm text-foreground-secondary hover:text-foreground hover:bg-surface-hover rounded-lg transition-colors disabled:opacity-50"
            >
                Unpost
            </button>
            {invoice && invoice.amountDue > 0.005 && (
                <button
                    type="button"
                    onClick={() => setPaymentOpen(true)}
                    disabled={isReadonly || !endOwner}
                    title={isReadonly ? READONLY_TOOLTIP : undefined}
                    className="px-4 py-2 text-sm bg-primary hover:bg-primary-hover disabled:bg-primary/50 disabled:cursor-not-allowed text-primary-foreground rounded-lg transition-colors"
                >
                    Record Payment
                </button>
            )}
        </>
    );

    return (
        <div className="space-y-4">
            <PageHeader
                title={title}
                subtitle={
                    isNew
                        ? (kind === 'invoice' ? 'Draft a new customer invoice.' : 'Draft a new vendor bill.')
                        : invoice?.ownerName
                }
                actions={isDraft ? draftActions : postedActions}
            />

            <div className="flex items-center gap-3 text-sm">
                <Link
                    href={`/business/invoices${kind === 'bill' ? '?type=bill' : ''}`}
                    className="text-foreground-muted hover:text-foreground transition-colors"
                >
                    ← All {kind === 'invoice' ? 'invoices' : 'bills'}
                </Link>
                <span className={`inline-block px-2 py-0.5 text-xs rounded-md ${statusMeta.className}`}>
                    {statusMeta.label}
                </span>
                {!isNew && isDraft && (
                    <button
                        type="button"
                        onClick={handlePrint}
                        className="text-foreground-muted hover:text-foreground transition-colors text-xs"
                    >
                        Print draft
                    </button>
                )}
            </div>

            {/* Header fields */}
            <div className="bg-surface border border-border rounded-lg p-4">
                {isDraft ? (
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                        <div className="sm:col-span-2">
                            <label className={labelClass}>{kind === 'invoice' ? 'Customer' : 'Vendor'} *</label>
                            {isNew ? (
                                <OwnerSelector
                                    kind={ownerKind}
                                    value={newOwnerGuid}
                                    onChange={(guid, owner) => {
                                        setNewOwnerGuid(guid);
                                        setNewOwner(owner);
                                        // Default the terms from the owner's configured terms.
                                        setHeader((h) => ({ ...h, termsGuid: owner.terms ?? h.termsGuid }));
                                        setDirty(true);
                                    }}
                                    autoFocus
                                />
                            ) : (
                                <p className="px-3 py-2 text-sm text-foreground border border-transparent" title="The owner is fixed once the document is created">
                                    {invoice?.ownerName}
                                </p>
                            )}
                        </div>
                        <div>
                            <label className={labelClass}>Date opened</label>
                            <input
                                type="date"
                                value={header.dateOpened}
                                onChange={(e) => { setHeader({ ...header, dateOpened: e.target.value }); setDirty(true); }}
                                className={`${inputClass} font-mono`}
                                style={TNUM}
                            />
                        </div>
                        <div>
                            <label className={labelClass}>{singular} #</label>
                            <input
                                type="text"
                                value={header.id}
                                onChange={(e) => { setHeader({ ...header, id: e.target.value }); setDirty(true); }}
                                placeholder={isNew ? 'Auto' : undefined}
                                className={`${inputClass} font-mono`}
                                style={TNUM}
                            />
                        </div>
                        <div>
                            <label className={labelClass}>Billing ID</label>
                            <input
                                type="text"
                                value={header.billingId}
                                onChange={(e) => { setHeader({ ...header, billingId: e.target.value }); setDirty(true); }}
                                placeholder="PO / reference"
                                className={inputClass}
                            />
                        </div>
                        <div>
                            <label className={labelClass}>Terms</label>
                            <select
                                value={header.termsGuid}
                                onChange={(e) => { setHeader({ ...header, termsGuid: e.target.value }); setDirty(true); }}
                                className={inputClass}
                            >
                                <option value="">None (due on post)</option>
                                {billterms.map((t) => (
                                    <option key={t.guid} value={t.guid}>{t.name} (net {t.dueDays})</option>
                                ))}
                            </select>
                        </div>
                        <div className="sm:col-span-2">
                            <label className={labelClass}>Notes</label>
                            <input
                                type="text"
                                value={header.notes}
                                onChange={(e) => { setHeader({ ...header, notes: e.target.value }); setDirty(true); }}
                                placeholder="Optional notes..."
                                className={inputClass}
                            />
                        </div>
                    </div>
                ) : invoice && (
                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-x-6 gap-y-3 text-sm">
                        <div>
                            <div className="text-xs text-foreground-muted uppercase tracking-wider mb-0.5">Opened</div>
                            <div className="font-mono tabular-nums text-foreground-secondary" style={TNUM}>{invoice.dateOpened ?? '—'}</div>
                        </div>
                        <div>
                            <div className="text-xs text-foreground-muted uppercase tracking-wider mb-0.5">Posted</div>
                            <div className="font-mono tabular-nums text-foreground-secondary" style={TNUM}>{invoice.datePosted ?? '—'}</div>
                        </div>
                        <div>
                            <div className="text-xs text-foreground-muted uppercase tracking-wider mb-0.5">Due</div>
                            <div className={`font-mono tabular-nums ${invoice.status === 'overdue' ? 'text-negative' : 'text-foreground-secondary'}`} style={TNUM}>
                                {invoice.dueDate ?? '—'}
                            </div>
                        </div>
                        <div>
                            <div className="text-xs text-foreground-muted uppercase tracking-wider mb-0.5">Billing ID</div>
                            <div className="text-foreground-secondary truncate">{invoice.billingId || '—'}</div>
                        </div>
                        <div>
                            <div className="text-xs text-foreground-muted uppercase tracking-wider mb-0.5">Total</div>
                            <div className="font-mono tabular-nums text-foreground" style={TNUM}>{formatCurrency(invoice.totals.total, currency)}</div>
                        </div>
                        <div>
                            <div className="text-xs text-foreground-muted uppercase tracking-wider mb-0.5">Amount due</div>
                            <div className={`font-mono tabular-nums font-semibold ${invoice.amountDue > 0.005 ? (invoice.status === 'overdue' ? 'text-negative' : 'text-foreground') : 'text-positive'}`} style={TNUM}>
                                {formatCurrency(invoice.amountDue, currency)}
                            </div>
                        </div>
                        {invoice.notes && (
                            <div className="col-span-2 sm:col-span-3 lg:col-span-6">
                                <div className="text-xs text-foreground-muted uppercase tracking-wider mb-0.5">Notes</div>
                                <div className="text-foreground-secondary whitespace-pre-wrap">{invoice.notes}</div>
                            </div>
                        )}
                    </div>
                )}
            </div>

            {/* Entries */}
            <div className="bg-surface border border-border rounded-lg overflow-hidden">
                <div className="overflow-x-auto">
                    <table className="w-full text-left text-[13px]">
                        <thead>
                            <tr className="bg-background-secondary/50 text-foreground-secondary text-xs uppercase tracking-widest">
                                <th className="px-3 py-2 font-semibold min-w-48">Description</th>
                                <th className="px-3 py-2 font-semibold min-w-52">{kind === 'invoice' ? 'Income account' : 'Expense account'}</th>
                                <th className="px-3 py-2 font-semibold text-right w-20">Qty</th>
                                <th className="px-3 py-2 font-semibold text-right w-28">Price</th>
                                {kind === 'invoice' && isDraft && (
                                    <th className="px-3 py-2 font-semibold text-right w-32">Discount</th>
                                )}
                                {kind === 'invoice' && !isDraft && (
                                    <th className="px-3 py-2 font-semibold text-right w-24">Discount</th>
                                )}
                                <th className="px-3 py-2 font-semibold w-40">Tax</th>
                                <th className="px-3 py-2 font-semibold text-right w-24">Net</th>
                                <th className="px-3 py-2 font-semibold text-right w-24">Tax amt</th>
                                <th className="px-3 py-2 font-semibold text-right w-28">Total</th>
                                {isDraft && <th className="px-2 py-2 w-8" />}
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                            {isDraft ? entries.map((d, index) => {
                                const preview = previews[index];
                                const isLastRow = index === entries.length - 1;
                                return (
                                    <tr key={d.key} className="align-top">
                                        <td className="px-2 py-1.5">
                                            <input
                                                type="text"
                                                value={d.description}
                                                onChange={(e) => updateEntry(d.key, { description: e.target.value })}
                                                onKeyDown={(e) => handleRowKeyDown(e, d.key, isLastRow)}
                                                placeholder="Description"
                                                className={cellInputClass}
                                            />
                                        </td>
                                        <td className="px-2 py-1.5">
                                            <AccountSelector
                                                value={d.accountGuid}
                                                onChange={(guid) => updateEntry(d.key, { accountGuid: guid })}
                                                accountTypes={entryAccountTypes}
                                                compact
                                                onEnter={isLastRow ? addRow : undefined}
                                            />
                                        </td>
                                        <td className="px-2 py-1.5">
                                            <input
                                                type="number"
                                                step="any"
                                                value={d.quantity}
                                                onChange={(e) => updateEntry(d.key, { quantity: e.target.value })}
                                                onKeyDown={(e) => handleRowKeyDown(e, d.key, isLastRow)}
                                                className={`${cellInputClass} font-mono text-right`}
                                                style={TNUM}
                                            />
                                        </td>
                                        <td className="px-2 py-1.5">
                                            <input
                                                type="number"
                                                step="0.01"
                                                value={d.price}
                                                onChange={(e) => updateEntry(d.key, { price: e.target.value })}
                                                onKeyDown={(e) => handleRowKeyDown(e, d.key, isLastRow)}
                                                placeholder="0.00"
                                                className={`${cellInputClass} font-mono text-right`}
                                                style={TNUM}
                                            />
                                        </td>
                                        {kind === 'invoice' && (
                                            <td className="px-2 py-1.5">
                                                <div className="flex gap-1">
                                                    <input
                                                        type="number"
                                                        min="0"
                                                        step="0.01"
                                                        value={d.discount}
                                                        onChange={(e) => updateEntry(d.key, { discount: e.target.value })}
                                                        onKeyDown={(e) => handleRowKeyDown(e, d.key, isLastRow)}
                                                        placeholder="0"
                                                        className={`${cellInputClass} font-mono text-right w-16`}
                                                        style={TNUM}
                                                    />
                                                    <select
                                                        value={d.discountType}
                                                        onChange={(e) => updateEntry(d.key, { discountType: e.target.value as EntryDraft['discountType'] })}
                                                        className="bg-input-bg border border-border rounded-md px-1 py-1 text-[13px] text-foreground focus:outline-none focus:border-primary/50"
                                                        title="Discount type"
                                                    >
                                                        <option value="PERCENT">%</option>
                                                        <option value="VALUE">$</option>
                                                    </select>
                                                </div>
                                            </td>
                                        )}
                                        <td className="px-2 py-1.5">
                                            <div className="flex items-center gap-1.5">
                                                <input
                                                    type="checkbox"
                                                    checked={d.taxable}
                                                    onChange={(e) => updateEntry(d.key, { taxable: e.target.checked })}
                                                    className="accent-primary shrink-0"
                                                    title="Taxable"
                                                />
                                                <select
                                                    value={d.taxTableGuid}
                                                    onChange={(e) => updateEntry(d.key, { taxTableGuid: e.target.value })}
                                                    disabled={!d.taxable}
                                                    className="w-full bg-input-bg border border-border rounded-md px-1 py-1 text-[13px] text-foreground focus:outline-none focus:border-primary/50 disabled:opacity-50"
                                                >
                                                    <option value="">No tax</option>
                                                    {taxtables.map((t) => (
                                                        <option key={t.guid} value={t.guid}>{t.name}</option>
                                                    ))}
                                                </select>
                                            </div>
                                        </td>
                                        <td className="px-3 py-1.5 font-mono tabular-nums text-right text-foreground-secondary whitespace-nowrap" style={TNUM}>
                                            {formatCurrency(preview.net, currency)}
                                        </td>
                                        <td className="px-3 py-1.5 font-mono tabular-nums text-right text-foreground-secondary whitespace-nowrap" style={TNUM}>
                                            {preview.taxTotal !== 0 ? formatCurrency(preview.taxTotal, currency) : '—'}
                                        </td>
                                        <td className="px-3 py-1.5 font-mono tabular-nums text-right text-foreground whitespace-nowrap" style={TNUM}>
                                            {formatCurrency(preview.gross, currency)}
                                        </td>
                                        <td className="px-1 py-1.5 text-center">
                                            <button
                                                type="button"
                                                onClick={() => removeRow(d.key)}
                                                className="px-1.5 py-0.5 text-xs rounded-md text-foreground-muted hover:text-negative hover:bg-negative/10 transition-colors"
                                                title="Remove line"
                                            >
                                                ✕
                                            </button>
                                        </td>
                                    </tr>
                                );
                            }) : invoice?.entries.map((e) => (
                                <tr key={e.guid}>
                                    <td className="px-3 py-2 text-foreground">{e.description || <span className="text-foreground-muted">—</span>}</td>
                                    <td className="px-3 py-2 text-foreground-secondary font-mono text-xs" style={TNUM}>
                                        <EntryAccountName guid={e.accountGuid} />
                                    </td>
                                    <td className="px-3 py-2 font-mono tabular-nums text-right text-foreground-secondary" style={TNUM}>{e.quantity}</td>
                                    <td className="px-3 py-2 font-mono tabular-nums text-right text-foreground-secondary" style={TNUM}>{formatCurrency(e.price, currency)}</td>
                                    {kind === 'invoice' && (
                                        <td className="px-3 py-2 font-mono tabular-nums text-right text-foreground-secondary" style={TNUM}>
                                            {e.computed.discountValue !== 0 ? formatCurrency(e.computed.discountValue, currency) : '—'}
                                        </td>
                                    )}
                                    <td className="px-3 py-2 text-foreground-secondary text-xs">
                                        {e.taxTableGuid ? (taxtableByGuid.get(e.taxTableGuid)?.name ?? 'Tax') : '—'}
                                    </td>
                                    <td className="px-3 py-2 font-mono tabular-nums text-right text-foreground-secondary" style={TNUM}>{formatCurrency(e.computed.net, currency)}</td>
                                    <td className="px-3 py-2 font-mono tabular-nums text-right text-foreground-secondary" style={TNUM}>
                                        {e.computed.taxTotal !== 0 ? formatCurrency(e.computed.taxTotal, currency) : '—'}
                                    </td>
                                    <td className="px-3 py-2 font-mono tabular-nums text-right text-foreground" style={TNUM}>{formatCurrency(e.computed.gross, currency)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>

                {isDraft && (
                    <div className="px-3 py-2 border-t border-border">
                        <button
                            type="button"
                            onClick={addRow}
                            className="px-2 py-1 text-xs rounded-md text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors"
                        >
                            + Add line (Enter on last row)
                        </button>
                    </div>
                )}

                {/* Totals footer */}
                <div className="border-t border-border px-4 py-3 flex justify-end">
                    <div className="w-64 space-y-1 text-sm">
                        <div className="flex justify-between text-foreground-secondary">
                            <span>Subtotal</span>
                            <span className="font-mono tabular-nums" style={TNUM}>
                                {formatCurrency(isDraft ? totals.subtotal : invoice?.totals.subtotal ?? 0, currency)}
                            </span>
                        </div>
                        {kind === 'invoice' && (
                            <div className="flex justify-between text-foreground-secondary">
                                <span>Discount</span>
                                <span className="font-mono tabular-nums" style={TNUM}>
                                    {formatCurrency(isDraft ? totals.discountTotal : invoice?.totals.discountTotal ?? 0, currency)}
                                </span>
                            </div>
                        )}
                        <div className="flex justify-between text-foreground-secondary">
                            <span>Tax</span>
                            <span className="font-mono tabular-nums" style={TNUM}>
                                {formatCurrency(isDraft ? totals.taxTotal : invoice?.totals.taxTotal ?? 0, currency)}
                            </span>
                        </div>
                        <div className="flex justify-between text-foreground font-semibold pt-1 border-t border-border">
                            <span>Total</span>
                            <span className="font-mono tabular-nums" style={TNUM}>
                                {formatCurrency(isDraft ? totals.total : invoice?.totals.total ?? 0, currency)}
                            </span>
                        </div>
                        {!isDraft && invoice && (
                            <div className="flex justify-between text-foreground font-semibold">
                                <span>Amount due</span>
                                <span className={`font-mono tabular-nums ${invoice.amountDue > 0.005 ? '' : 'text-positive'}`} style={TNUM}>
                                    {formatCurrency(invoice.amountDue, currency)}
                                </span>
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* Payments history (posted only) */}
            {!isDraft && invoice && (
                <div className="bg-surface border border-border rounded-lg overflow-hidden">
                    <div className="px-4 py-2.5 border-b border-border flex items-center justify-between">
                        <h2 className="text-sm font-semibold text-foreground">Payments</h2>
                        {endOwner && (
                            <Link
                                href="/business/payments"
                                className="text-xs text-primary hover:text-primary-hover transition-colors"
                            >
                                Payment center →
                            </Link>
                        )}
                    </div>
                    {payments.length === 0 ? (
                        <p className="px-4 py-4 text-sm text-foreground-muted">No payments applied to this {singular.toLowerCase()} yet.</p>
                    ) : (
                        <table className="w-full text-left text-[13px]">
                            <thead>
                                <tr className="bg-background-secondary/50 text-foreground-secondary text-xs uppercase tracking-widest">
                                    <th className="px-4 py-2 font-semibold">Date</th>
                                    <th className="px-4 py-2 font-semibold">Num</th>
                                    <th className="px-4 py-2 font-semibold">Description</th>
                                    <th className="px-4 py-2 font-semibold text-right">Payment</th>
                                    <th className="px-4 py-2 font-semibold text-right">Applied here</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-border">
                                {payments.map((p) => {
                                    const applied = p.allocations
                                        .filter((a) => a.invoiceGuid === invoice.guid)
                                        .reduce((s, a) => s + a.amount, 0);
                                    return (
                                        <tr key={p.transactionGuid} className="hover:bg-surface-hover/50 transition-colors">
                                            <td className="px-4 py-2 font-mono tabular-nums text-foreground-secondary" style={TNUM}>{p.date ?? '—'}</td>
                                            <td className="px-4 py-2 font-mono tabular-nums text-foreground-secondary" style={TNUM}>{p.num || '—'}</td>
                                            <td className="px-4 py-2 text-foreground-secondary max-w-xs truncate">{p.description}</td>
                                            <td className="px-4 py-2 font-mono tabular-nums text-right text-foreground-secondary" style={TNUM}>
                                                {formatCurrency(p.amount, currency)}
                                            </td>
                                            <td className="px-4 py-2 font-mono tabular-nums text-right text-foreground" style={TNUM}>
                                                {formatCurrency(applied, currency)}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    )}
                </div>
            )}

            {/* Inventory fulfillment (posted customer invoices only) */}
            {!isDraft && invoice && invoice.type === 'invoice' && (
                <InvoiceFulfillmentSection
                    invoiceGuid={invoice.guid}
                    entries={invoice.entries.map((e) => ({
                        guid: e.guid,
                        description: e.description,
                        quantity: e.quantity,
                    }))}
                />
            )}

            {/* Post modal */}
            <Modal isOpen={postOpen} onClose={posting ? () => {} : () => setPostOpen(false)} title={`Post ${singular}`} size="sm">
                <form onSubmit={handlePost} className="px-6 py-4 space-y-3">
                    <p className="text-sm text-foreground-secondary">
                        Posting writes the {singular.toLowerCase()} to {kind === 'invoice' ? 'Accounts Receivable' : 'Accounts Payable'} and locks it from editing.
                    </p>
                    <div>
                        <label className={labelClass}>Post date *</label>
                        <input
                            type="date"
                            value={postDate}
                            onChange={(e) => handlePostDateChange(e.target.value)}
                            className={`${inputClass} font-mono`}
                            style={TNUM}
                        />
                    </div>
                    <div>
                        <label className={labelClass}>
                            Due date
                            {header.termsGuid && termByGuid.get(header.termsGuid) && (
                                <span className="ml-1 text-foreground-muted normal-case">
                                    ({termByGuid.get(header.termsGuid)!.name})
                                </span>
                            )}
                        </label>
                        <input
                            type="date"
                            value={postDueDate}
                            onChange={(e) => { setPostDueDate(e.target.value); setPostDueTouched(true); }}
                            className={`${inputClass} font-mono`}
                            style={TNUM}
                        />
                    </div>
                    <div>
                        <label className={labelClass}>Memo</label>
                        <input
                            type="text"
                            value={postMemo}
                            onChange={(e) => setPostMemo(e.target.value)}
                            placeholder="Optional"
                            className={inputClass}
                        />
                    </div>
                    <div className="flex justify-end gap-3 pt-2 border-t border-border">
                        <button
                            type="button"
                            onClick={() => setPostOpen(false)}
                            disabled={posting}
                            className="px-4 py-2 text-sm text-foreground-secondary hover:text-foreground transition-colors"
                        >
                            Cancel
                        </button>
                        <button
                            type="submit"
                            disabled={posting || !postDate}
                            className="px-4 py-2 text-sm bg-primary hover:bg-primary-hover disabled:bg-primary/50 disabled:cursor-not-allowed text-primary-foreground rounded-lg transition-colors"
                        >
                            {posting ? 'Posting...' : `Post ${formatCurrency(totals.total, currency)}`}
                        </button>
                    </div>
                </form>
            </Modal>

            {/* Payment modal */}
            {endOwner && invoice && (
                <PaymentModal
                    isOpen={paymentOpen}
                    onClose={() => setPaymentOpen(false)}
                    ownerType={endOwner.type}
                    ownerGuid={endOwner.guid}
                    ownerName={endOwner.name}
                    currency={currency}
                    focusInvoiceGuid={invoice.guid}
                    onSuccess={async () => {
                        await fetchInvoice();
                        await fetchPayments();
                    }}
                />
            )}

            {/* Confirmations */}
            <ConfirmationDialog
                isOpen={confirmDelete}
                onConfirm={handleDelete}
                onCancel={() => setConfirmDelete(false)}
                title={`Delete ${singular}`}
                message={`Delete ${singular.toLowerCase()} ${invoice?.id ?? ''}? This removes the draft and all its lines. This cannot be undone.`}
                confirmLabel="Delete"
                confirmVariant="danger"
                isLoading={deleting}
            />
            <ConfirmationDialog
                isOpen={confirmUnpost}
                onConfirm={handleUnpost}
                onCancel={() => setConfirmUnpost(false)}
                title={`Unpost ${singular}`}
                message={`Unpost ${singular.toLowerCase()} ${invoice?.id ?? ''}? The posting transaction is removed and the document returns to draft. This is rejected if payments are attached.`}
                confirmLabel="Unpost"
                confirmVariant="warning"
                isLoading={unposting}
            />
        </div>
    );
}

/** Resolves an account guid to its full path via the shared cached hook. */
function EntryAccountName({ guid }: { guid: string | null }) {
    const { data: accounts = [] } = useAccounts({ flat: true });
    if (!guid) return <span className="text-foreground-muted">—</span>;
    const acct = accounts.find((a) => a.guid === guid);
    return <span className="truncate">{acct ? (acct.fullname || acct.name) : '…'}</span>;
}

export default function InvoiceDetailPage() {
    return (
        <Suspense
            fallback={
                <div className="p-12 flex items-center justify-center gap-3">
                    <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                    <span className="text-foreground-secondary">Loading...</span>
                </div>
            }
        >
            <InvoiceDetailContent />
        </Suspense>
    );
}

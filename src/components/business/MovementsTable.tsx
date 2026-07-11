'use client';

import Link from 'next/link';
import { MobileCard } from '@/components/ui/MobileCard';
import { formatCurrency } from '@/lib/format';
import {
    type MovementDTO,
    movementTypeMeta,
    movementQtyClass,
    formatSignedQty,
} from '@/components/business/inventory-ui';

const TNUM = { fontFeatureSettings: "'tnum'" } as const;

interface MovementsTableProps {
    movements: MovementDTO[];
    /** Resolve item id → "SKU — name" label; omit to hide the Item column. */
    itemLabel?: (itemId: number) => string;
    /** Resolve location id → name. */
    locationLabel: (locationId: number) => string;
    /** Show a link to the item detail page in the Item column. */
    linkItems?: boolean;
    emptyMessage?: string;
}

function PostedMark({ txnGuid }: { txnGuid: string | null }) {
    if (!txnGuid) return <span className="text-foreground-muted">—</span>;
    return (
        <span className="text-positive" title="Posted to the ledger">
            ✓
        </span>
    );
}

function InvoiceLink({ invoiceGuid }: { invoiceGuid: string | null }) {
    if (!invoiceGuid) return null;
    return (
        <Link
            href={`/business/invoices/${invoiceGuid}`}
            className="text-primary hover:text-primary-hover transition-colors text-xs"
            title="Open invoice"
        >
            Invoice
        </Link>
    );
}

/**
 * Shared movements list: dense table on md+ screens, MobileCards below.
 * Type badge, signed colored quantity, unit cost, posted marker, invoice link.
 */
export function MovementsTable({
    movements,
    itemLabel,
    locationLabel,
    linkItems = false,
    emptyMessage = 'No movements yet.',
}: MovementsTableProps) {
    if (movements.length === 0) {
        return <p className="px-4 py-6 text-sm text-foreground-muted text-center">{emptyMessage}</p>;
    }

    const showItem = itemLabel !== undefined;

    return (
        <>
            {/* Desktop table */}
            <div className="hidden md:block overflow-x-auto">
                <table className="w-full text-left text-[13px]">
                    <thead>
                        <tr className="bg-background-secondary/50 text-foreground-secondary text-xs uppercase tracking-widest">
                            <th className="px-3 py-2 font-semibold">Date</th>
                            <th className="px-3 py-2 font-semibold">Type</th>
                            {showItem && <th className="px-3 py-2 font-semibold">Item</th>}
                            <th className="px-3 py-2 font-semibold">Location</th>
                            <th className="px-3 py-2 font-semibold text-right">Qty</th>
                            <th className="px-3 py-2 font-semibold text-right">Unit cost</th>
                            <th className="px-3 py-2 font-semibold">Reference</th>
                            <th className="px-3 py-2 font-semibold text-center" title="Posted to ledger">Posted</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                        {movements.map((m) => {
                            const meta = movementTypeMeta(m.movementType);
                            return (
                                <tr key={m.id} className="hover:bg-surface-hover/50 transition-colors">
                                    <td className="px-3 py-2 font-mono tabular-nums text-foreground-secondary whitespace-nowrap" style={TNUM}>
                                        {m.movementDate}
                                    </td>
                                    <td className="px-3 py-2">
                                        <span className={`inline-block px-2 py-0.5 text-xs rounded-md whitespace-nowrap ${meta.badgeClass}`}>
                                            {meta.label}
                                        </span>
                                    </td>
                                    {showItem && (
                                        <td className="px-3 py-2 text-foreground-secondary max-w-56 truncate">
                                            {linkItems ? (
                                                <Link
                                                    href={`/business/inventory/${m.itemId}`}
                                                    className="hover:text-foreground transition-colors"
                                                >
                                                    {itemLabel!(m.itemId)}
                                                </Link>
                                            ) : (
                                                itemLabel!(m.itemId)
                                            )}
                                        </td>
                                    )}
                                    <td className="px-3 py-2 text-foreground-secondary whitespace-nowrap">
                                        {locationLabel(m.locationId)}
                                    </td>
                                    <td
                                        className={`px-3 py-2 font-mono tabular-nums text-right whitespace-nowrap ${movementQtyClass(m.quantity)}`}
                                        style={TNUM}
                                    >
                                        {formatSignedQty(m.quantity)}
                                    </td>
                                    <td className="px-3 py-2 font-mono tabular-nums text-right text-foreground-secondary whitespace-nowrap" style={TNUM}>
                                        {m.unitCost != null ? formatCurrency(m.unitCost) : '—'}
                                    </td>
                                    <td className="px-3 py-2 text-foreground-secondary max-w-48 truncate">
                                        <span className="mr-2">{m.reference || <span className="text-foreground-muted">—</span>}</span>
                                        <InvoiceLink invoiceGuid={m.invoiceGuid} />
                                    </td>
                                    <td className="px-3 py-2 text-center">
                                        <PostedMark txnGuid={m.txnGuid} />
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>

            {/* Mobile cards */}
            <div className="md:hidden">
                {movements.map((m) => {
                    const meta = movementTypeMeta(m.movementType);
                    return (
                        <MobileCard
                            key={m.id}
                            fields={[
                                {
                                    label: 'Type',
                                    value: (
                                        <span className={`inline-block px-2 py-0.5 text-xs rounded-md ${meta.badgeClass}`}>
                                            {meta.label}
                                        </span>
                                    ),
                                },
                                ...(showItem
                                    ? [{ label: 'Item', value: <span className="truncate">{itemLabel!(m.itemId)}</span> }]
                                    : []),
                                {
                                    label: 'Qty',
                                    value: (
                                        <span className={`font-mono tabular-nums ${movementQtyClass(m.quantity)}`} style={TNUM}>
                                            {formatSignedQty(m.quantity)}
                                        </span>
                                    ),
                                },
                                {
                                    label: 'Date',
                                    value: <span className="font-mono tabular-nums" style={TNUM}>{m.movementDate}</span>,
                                },
                                { label: 'Location', value: locationLabel(m.locationId) },
                                ...(m.unitCost != null
                                    ? [{
                                        label: 'Unit cost',
                                        value: <span className="font-mono tabular-nums" style={TNUM}>{formatCurrency(m.unitCost)}</span>,
                                    }]
                                    : []),
                                ...(m.reference
                                    ? [{ label: 'Reference', value: <span className="truncate">{m.reference}</span> }]
                                    : []),
                                ...(m.txnGuid
                                    ? [{ label: 'Posted', value: <PostedMark txnGuid={m.txnGuid} /> }]
                                    : []),
                                ...(m.invoiceGuid
                                    ? [{ label: 'Invoice', value: <InvoiceLink invoiceGuid={m.invoiceGuid} /> }]
                                    : []),
                            ]}
                        />
                    );
                })}
            </div>
        </>
    );
}

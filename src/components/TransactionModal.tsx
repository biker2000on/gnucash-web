'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Modal } from './ui/Modal';
import { ConfirmationDialog } from './ui/ConfirmationDialog';
import { Transaction, Split } from '@/lib/types';
import { formatCurrency } from '@/lib/format';
import { formatAccountPath } from '@/lib/account-utils';
import { PopoutButton } from './popout/PopoutButton';
import { TransactionActivityFeed } from './transactions/TransactionActivityFeed';
import { usePopoutHost } from '@/lib/popout/usePopout';
import { Tip } from '@/components/ui/Tooltip';

function getReconcileStatus(splits: Split[] | undefined): {
    hasReconciled: boolean;
    hasCleared: boolean;
} {
    if (!splits || splits.length === 0) return { hasReconciled: false, hasCleared: false };
    return {
        hasReconciled: splits.some(s => s.reconcile_state === 'y'),
        hasCleared: splits.some(s => s.reconcile_state === 'c'),
    };
}

interface TransactionModalProps {
    transactionGuid: string | null;
    isOpen: boolean;
    onClose: () => void;
    onEdit?: (guid: string) => void;
    onDelete?: (guid: string) => void;
}

export interface TransactionDetail extends Transaction {
    currency_mnemonic?: string;
    /** Import source from transaction meta ('manual' when none). */
    source?: string;
    /** Preserved import-time payee; null for manual transactions. */
    original_description?: string | null;
    splits: (Split & {
        account_name: string;
        account_fullname?: string;
        commodity_mnemonic: string;
        value_decimal: string;
        quantity_decimal: string;
    })[];
}

/**
 * The preserved import-time payee to show as a secondary line: only when it
 * exists and differs from the display description (a renamed import).
 */
export function originalPayeeLine(transaction: {
    description?: string | null;
    original_description?: string | null;
}): string | null {
    const original = (transaction.original_description ?? '').trim();
    if (!original) return null;
    if (original === (transaction.description ?? '').trim()) return null;
    return original;
}

function getReconcileLabel(state: string) {
    switch (state) {
        case 'y': return { label: 'Reconciled', color: 'text-primary bg-primary/10' };
        case 'c': return { label: 'Cleared', color: 'text-warning bg-warning/10' };
        default: return { label: 'Not Reconciled', color: 'text-foreground-secondary bg-surface/10' };
    }
}

/**
 * Fetches and renders one transaction's detail (header, splits, metadata).
 * Shared by the transaction modal and the /popout/transaction pane.
 */
export function TransactionDetailContent({
    transactionGuid,
    onAccountNavigate,
    onLoaded,
    actions,
}: {
    transactionGuid: string | null;
    /** Called when the user follows an account link (e.g. to close the modal). */
    onAccountNavigate?: () => void;
    /** Reports the loaded transaction (or null) so wrappers can drive actions. */
    onLoaded?: (transaction: TransactionDetail | null) => void;
    /** Optional action row rendered under the detail. */
    actions?: React.ReactNode;
}) {
    const [transaction, setTransaction] = useState<TransactionDetail | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const onLoadedRef = useRef(onLoaded);
    onLoadedRef.current = onLoaded;

    useEffect(() => {
        if (!transactionGuid) {
            setTransaction(null);
            onLoadedRef.current?.(null);
            return;
        }

        let cancelled = false;
        async function fetchTransaction() {
            setLoading(true);
            setError(null);
            try {
                const res = await fetch(`/api/transactions/${transactionGuid}`);
                if (!res.ok) throw new Error('Failed to fetch transaction');
                const data = await res.json();
                if (cancelled) return;
                setTransaction(data);
                onLoadedRef.current?.(data);
            } catch (err) {
                if (cancelled) return;
                setError(err instanceof Error ? err.message : 'An error occurred');
                setTransaction(null);
                onLoadedRef.current?.(null);
            } finally {
                if (!cancelled) setLoading(false);
            }
        }

        fetchTransaction();
        return () => {
            cancelled = true;
        };
    }, [transactionGuid]);

    if (loading) {
        return (
            <div className="p-8 flex items-center justify-center">
                <div className="flex items-center gap-3">
                    <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                    <span className="text-foreground-secondary">Loading transaction...</span>
                </div>
            </div>
        );
    }
    if (error) {
        return <div className="p-8 text-center text-error">{error}</div>;
    }
    if (!transaction) return null;

    return (
        <div className="space-y-5 p-4 sm:p-5">
            {/* Transaction Header */}
            <div className="space-y-2">
                <div className="flex items-start justify-between gap-4">
                    <div>
                        <h3 className="text-xl font-semibold text-foreground">
                            {transaction.description}
                        </h3>
                        {originalPayeeLine(transaction) && (
                            <div className="text-sm text-foreground-muted mt-0.5">
                                Imported as &ldquo;{originalPayeeLine(transaction)}&rdquo;
                            </div>
                        )}
                        {transaction.num && (
                            <span className="text-sm text-foreground-muted">#{transaction.num}</span>
                        )}
                    </div>
                    <div className="text-right shrink-0">
                        <div className="text-sm text-foreground-secondary">Post Date</div>
                        <div className="text-foreground font-mono">
                            {new Date(transaction.post_date).toLocaleDateString('en-US', {
                                weekday: 'short',
                                year: 'numeric',
                                month: 'short',
                                day: 'numeric',
                                timeZone: 'UTC',
                            })}
                        </div>
                    </div>
                </div>
            </div>

            {/* Splits Table */}
            <div>
                <h4 className="text-sm font-semibold text-foreground-secondary uppercase tracking-wider mb-3">
                    Splits
                </h4>
                <div className="max-w-full overflow-x-auto rounded-lg border border-border bg-input-bg">
                    <table className="w-full min-w-[640px] table-fixed">
                        <thead>
                            <tr className="text-xs text-foreground-muted uppercase tracking-wider">
                                <th className="w-[40%] px-4 py-3 text-left lg:w-[32%]">Account</th>
                                <th className="hidden w-[18%] px-4 py-3 text-left lg:table-cell">Memo</th>
                                <th className="w-[10%] px-2 py-3 text-center">Status</th>
                                <th className="w-[25%] px-3 py-3 text-right lg:w-[20%]">
                                    Debit ({transaction.currency_mnemonic || 'USD'})
                                </th>
                                <th className="w-[25%] px-3 py-3 text-right lg:w-[20%]">
                                    Credit ({transaction.currency_mnemonic || 'USD'})
                                </th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                            {transaction.splits.map(split => {
                                // Debit/credit columns show the split VALUE in the
                                // transaction currency. Quantity is only the money
                                // amount for currency accounts — zero-share splits
                                // (realized gains) and stock legs would render blank
                                // or in the wrong unit otherwise.
                                const txCurrency = transaction.currency_mnemonic || 'USD';
                                const value = parseFloat(split.value_decimal);
                                const qty = parseFloat(split.quantity_decimal);
                                // Show the commodity quantity when it is denominated
                                // differently from the value (stock/fund/crypto legs,
                                // multi-currency transfers)
                                const showQty = qty !== 0 && split.commodity_mnemonic !== txCurrency;
                                const qtyLine = showQty
                                    ? `Native: ${qty > 0 ? '+' : ''}${qty.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${split.commodity_mnemonic}`
                                    : null;
                                const reconcile = getReconcileLabel(split.reconcile_state);
                                return (
                                    <tr key={split.guid} className="hover:bg-surface-hover/30">
                                        <td className="break-words px-4 py-3 align-top">
                                            <Link
                                                href={`/accounts/${split.account_guid}`}
                                                className="text-foreground hover:text-primary transition-colors"
                                                onClick={onAccountNavigate}
                                            >
                                                {formatAccountPath(split.account_fullname, split.account_name)}
                                            </Link>
                                            {split.action && (
                                                <span className="ml-2 text-xs text-foreground-muted">({split.action})</span>
                                            )}
                                        </td>
                                        <Tip content={split.memo || undefined}>
                                        <td className="hidden truncate px-4 py-3 text-sm italic text-foreground-muted lg:table-cell">
                                            {split.memo || '—'}
                                        </td>
                                        </Tip>
                                        <td className="px-2 py-3 text-center align-top">
                                            <span className={`text-xs px-2 py-1 rounded-full ${reconcile.color}`}>
                                                {split.reconcile_state.toUpperCase()}
                                            </span>
                                        </td>
                                        <td className="px-3 py-3 text-right font-mono text-positive align-top">
                                            {value > 0 ? (
                                                <>
                                                    <span className="whitespace-nowrap">{formatCurrency(value.toString(), txCurrency)}</span>
                                                    {qtyLine && (
                                                        <div className="break-words text-[11px] leading-4 text-foreground-muted">{qtyLine}</div>
                                                    )}
                                                </>
                                            ) : value === 0 && qty > 0 ? (
                                                <span className="text-foreground-secondary">{qtyLine}</span>
                                            ) : ''}
                                        </td>
                                        <td className="px-3 py-3 text-right font-mono text-negative align-top">
                                            {value < 0 ? (
                                                <>
                                                    <span className="whitespace-nowrap">{formatCurrency(Math.abs(value).toString(), txCurrency)}</span>
                                                    {qtyLine && (
                                                        <div className="break-words text-[11px] leading-4 text-foreground-muted">{qtyLine}</div>
                                                    )}
                                                </>
                                            ) : value === 0 && qty < 0 ? (
                                                <span className="text-foreground-secondary">{qtyLine}</span>
                                            ) : ''}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* Metadata */}
            <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
                <div className="rounded-lg border border-border bg-input-bg p-4">
                    <div className="text-foreground-muted text-xs uppercase tracking-wider mb-1">Enter Date</div>
                    <div className="text-foreground-secondary font-mono">
                        {new Date(transaction.enter_date).toLocaleString()}
                    </div>
                </div>
                <div className="min-w-0 rounded-lg border border-border bg-input-bg p-4">
                    <div className="text-foreground-muted text-xs uppercase tracking-wider mb-1">Transaction ID</div>
                    <Tip content={transaction.guid}>
                    <div className="break-all font-mono text-xs text-foreground-secondary">
                        {transaction.guid}
                    </div>
                    </Tip>
                </div>
            </div>

            {/* Comments + change history — same feed, and the same "Activity"
              * heading and separator, as the edit modal. */}
            <section className="mt-6 border-t border-border pt-4">
                <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-foreground-secondary">
                    Activity
                </h3>
                <TransactionActivityFeed transactionGuid={transaction.guid} />
            </section>

            {actions}
        </div>
    );
}

export function TransactionModal({
    transactionGuid,
    isOpen,
    onClose,
    onEdit,
    onDelete,
}: TransactionModalProps) {
    const [transaction, setTransaction] = useState<TransactionDetail | null>(null);
    const [reconcileWarningOpen, setReconcileWarningOpen] = useState(false);
    const [pendingAction, setPendingAction] = useState<'edit' | 'delete' | null>(null);
    // When the pop-out window closes, its last shown transaction re-docks here
    // so the pane returns to the main window without losing state.
    const [redockGuid, setRedockGuid] = useState<string | null>(null);

    const handleRedock = useCallback((lastPayload: unknown) => {
        // The host's own selection supersedes a re-docked one, so a selection
        // arriving while the modal is already open is dropped rather than
        // stored and cleared.
        if (isOpen) return;
        if (typeof lastPayload === 'string') setRedockGuid(lastPayload);
    }, [isOpen]);
    const popout = usePopoutHost('transaction', handleRedock);
    const { isPopoutOpen, show: showInPopout, open: openPopout } = popout;

    const effectiveOpen = isOpen || redockGuid !== null;
    const effectiveGuid = isOpen ? transactionGuid : redockGuid;

    const handleClose = useCallback(() => {
        setRedockGuid(null);
        onClose();
    }, [onClose]);

    // While a pop-out window is open, selections route there instead of the
    // modal. Layout effect so the modal never paints before forwarding.
    useLayoutEffect(() => {
        if (!isOpen || !transactionGuid || !isPopoutOpen) return;
        if (showInPopout(transactionGuid)) onClose();
    }, [isOpen, transactionGuid, isPopoutOpen, showInPopout, onClose]);

    const handlePopout = () => {
        if (!effectiveGuid) return;
        const opened = openPopout(
            `/popout/transaction?tx=${encodeURIComponent(effectiveGuid)}`,
            effectiveGuid,
        );
        if (opened) handleClose();
    };

    const handleEditClick = () => {
        if (!transaction) return;
        const { hasReconciled, hasCleared } = getReconcileStatus(transaction.splits);
        if (hasReconciled || hasCleared) {
            setPendingAction('edit');
            setReconcileWarningOpen(true);
        } else {
            onEdit?.(transaction.guid);
        }
    };

    const handleDeleteClick = () => {
        if (!transaction) return;
        const { hasReconciled, hasCleared } = getReconcileStatus(transaction.splits);
        if (hasReconciled || hasCleared) {
            setPendingAction('delete');
            setReconcileWarningOpen(true);
        } else {
            onDelete?.(transaction.guid);
        }
    };

    const handleReconcileWarningConfirm = () => {
        setReconcileWarningOpen(false);
        if (!transaction) return;
        if (pendingAction === 'edit') {
            onEdit?.(transaction.guid);
        } else if (pendingAction === 'delete') {
            onDelete?.(transaction.guid);
        }
        setPendingAction(null);
    };

    const handleReconcileWarningCancel = () => {
        setReconcileWarningOpen(false);
        setPendingAction(null);
    };

    const { hasReconciled } = getReconcileStatus(transaction?.splits);

    return (
        <Modal
            isOpen={effectiveOpen}
            onClose={handleClose}
            title="Transaction Details"
            size="xl"
            resetKey={effectiveGuid}
            headerActions={<PopoutButton onClick={handlePopout} />}
        >
            <TransactionDetailContent
                transactionGuid={effectiveGuid}
                onAccountNavigate={handleClose}
                onLoaded={setTransaction}
                actions={(onEdit || onDelete) && transaction ? (
                    <div className="flex justify-end gap-3 pt-4 border-t border-border">
                        {onDelete && (
                            <button
                                onClick={handleDeleteClick}
                                className="px-4 py-2 text-sm text-negative hover:text-negative hover:bg-negative/10 rounded-lg transition-colors"
                            >
                                Delete
                            </button>
                        )}
                        {onEdit && (
                            <button
                                onClick={handleEditClick}
                                className="px-4 py-2 text-sm bg-primary hover:bg-primary-hover text-primary-foreground rounded-lg transition-colors"
                            >
                                Edit Transaction
                            </button>
                        )}
                    </div>
                ) : null}
            />

            {/* Reconcile Warning Dialog */}
            <ConfirmationDialog
                isOpen={reconcileWarningOpen}
                onConfirm={handleReconcileWarningConfirm}
                onCancel={handleReconcileWarningCancel}
                title={hasReconciled ? (pendingAction === 'delete' ? "Delete Reconciled Transaction?" : "Edit Reconciled Transaction?") : (pendingAction === 'delete' ? "Delete Cleared Transaction?" : "Edit Cleared Transaction?")}
                message={hasReconciled
                    ? `This transaction has reconciled splits. ${pendingAction === 'delete' ? 'Deleting' : 'Editing'} may affect your account reconciliation. Are you sure you want to continue?`
                    : `This transaction has cleared splits. Are you sure you want to ${pendingAction === 'delete' ? 'delete' : 'edit'} it?`
                }
                confirmLabel="Continue Anyway"
                confirmVariant={hasReconciled ? "danger" : "warning"}
            />
        </Modal>
    );
}

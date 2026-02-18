'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Modal } from './ui/Modal';
import { ConfirmationDialog } from './ui/ConfirmationDialog';
import { Transaction, Split } from '@/lib/types';
import { formatCurrency } from '@/lib/format';

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

// Format account path, stripping "Root Account:" prefix
function formatAccountPath(fullname: string | undefined, name: string): string {
    const path = fullname || name;
    if (path.startsWith('Root Account:')) {
        return path.substring('Root Account:'.length);
    }
    return path;
}

interface TransactionModalProps {
    transactionGuid: string | null;
    isOpen: boolean;
    onClose: () => void;
    onEdit?: (guid: string) => void;
    onDelete?: (guid: string) => void;
}

interface TransactionDetail extends Transaction {
    splits: (Split & {
        account_name: string;
        account_fullname?: string;
        commodity_mnemonic: string;
        value_decimal: string;
        quantity_decimal: string;
    })[];
}

export function TransactionModal({
    transactionGuid,
    isOpen,
    onClose,
    onEdit,
    onDelete,
}: TransactionModalProps) {
    const [transaction, setTransaction] = useState<TransactionDetail | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [reconcileWarningOpen, setReconcileWarningOpen] = useState(false);
    const [pendingAction, setPendingAction] = useState<'edit' | 'delete' | null>(null);

    useEffect(() => {
        if (!isOpen || !transactionGuid) {
            setTransaction(null);
            return;
        }

        async function fetchTransaction() {
            setLoading(true);
            setError(null);
            try {
                const res = await fetch(`/api/transactions/${transactionGuid}`);
                if (!res.ok) throw new Error('Failed to fetch transaction');
                const data = await res.json();
                setTransaction(data);
            } catch (err) {
                setError(err instanceof Error ? err.message : 'An error occurred');
            } finally {
                setLoading(false);
            }
        }

        fetchTransaction();
    }, [isOpen, transactionGuid]);

    const getReconcileLabel = (state: string) => {
        switch (state) {
            case 'y': return { label: 'Reconciled', color: 'text-emerald-400 bg-emerald-500/10' };
            case 'c': return { label: 'Cleared', color: 'text-amber-400 bg-amber-500/10' };
            default: return { label: 'Not Reconciled', color: 'text-foreground-secondary bg-surface/10' };
        }
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

    const { hasReconciled, hasCleared } = getReconcileStatus(transaction?.splits);

    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title="Transaction Details"
            size="xl"
        >
            {loading ? (
                <div className="p-8 flex items-center justify-center">
                    <div className="flex items-center gap-3">
                        <div className="w-5 h-5 border-2 border-cyan-500/30 border-t-cyan-500 rounded-full animate-spin" />
                        <span className="text-foreground-secondary">Loading transaction...</span>
                    </div>
                </div>
            ) : error ? (
                <div className="p-8 text-center text-rose-400">{error}</div>
            ) : transaction ? (
                <div className="p-6 space-y-6">
                    {/* Transaction Header */}
                    <div className="space-y-2">
                        <div className="flex items-start justify-between gap-4">
                            <div>
                                <h3 className="text-xl font-semibold text-foreground">
                                    {transaction.description}
                                </h3>
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
                        <div className="bg-input-bg border border-border rounded-xl overflow-hidden">
                            <table className="w-full">
                                <thead>
                                    <tr className="text-xs text-foreground-muted uppercase tracking-wider">
                                        <th className="px-4 py-3 text-left">Account</th>
                                        <th className="px-4 py-3 text-left">Memo</th>
                                        <th className="px-4 py-3 text-center">Status</th>
                                        <th className="px-4 py-3 text-right">Debit</th>
                                        <th className="px-4 py-3 text-right">Credit</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-border">
                                    {transaction.splits.map(split => {
                                        const amount = parseFloat(split.quantity_decimal);
                                        const debit = amount > 0 ? amount : 0;
                                        const credit = amount < 0 ? Math.abs(amount) : 0;
                                        const reconcile = getReconcileLabel(split.reconcile_state);
                                        return (
                                            <tr key={split.guid} className="hover:bg-surface-hover/30">
                                                <td className="px-4 py-3 whitespace-nowrap">
                                                    <Link
                                                        href={`/accounts/${split.account_guid}`}
                                                        className="text-foreground hover:text-cyan-400 transition-colors"
                                                        onClick={onClose}
                                                    >
                                                        {formatAccountPath(split.account_fullname, split.account_name)}
                                                    </Link>
                                                    {split.action && (
                                                        <span className="ml-2 text-xs text-foreground-muted">({split.action})</span>
                                                    )}
                                                </td>
                                                <td className="px-4 py-3 text-sm text-foreground-muted italic max-w-[200px] truncate" title={split.memo || undefined}>
                                                    {split.memo || '—'}
                                                </td>
                                                <td className="px-4 py-3 text-center whitespace-nowrap">
                                                    <span className={`text-xs px-2 py-1 rounded-full ${reconcile.color}`}>
                                                        {split.reconcile_state.toUpperCase()}
                                                    </span>
                                                </td>
                                                <td className="px-4 py-3 text-right font-mono text-emerald-400 whitespace-nowrap">
                                                    {debit > 0 ? formatCurrency(debit.toString(), split.commodity_mnemonic) : ''}
                                                </td>
                                                <td className="px-4 py-3 text-right font-mono text-rose-400 whitespace-nowrap">
                                                    {credit > 0 ? formatCurrency(credit.toString(), split.commodity_mnemonic) : ''}
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    </div>

                    {/* Metadata */}
                    <div className="grid grid-cols-2 gap-4 text-sm">
                        <div className="bg-input-bg border border-border rounded-xl p-4">
                            <div className="text-foreground-muted text-xs uppercase tracking-wider mb-1">Enter Date</div>
                            <div className="text-foreground-secondary font-mono">
                                {new Date(transaction.enter_date).toLocaleString()}
                            </div>
                        </div>
                        <div className="bg-input-bg border border-border rounded-xl p-4">
                            <div className="text-foreground-muted text-xs uppercase tracking-wider mb-1">Transaction ID</div>
                            <div className="text-foreground-secondary font-mono text-xs truncate" title={transaction.guid}>
                                {transaction.guid}
                            </div>
                        </div>
                    </div>

                    {/* Actions */}
                    {(onEdit || onDelete) && (
                        <div className="flex justify-end gap-3 pt-4 border-t border-border">
                            {onDelete && (
                                <button
                                    onClick={handleDeleteClick}
                                    className="px-4 py-2 text-sm text-rose-400 hover:text-rose-300 hover:bg-rose-500/10 rounded-lg transition-colors"
                                >
                                    Delete
                                </button>
                            )}
                            {onEdit && (
                                <button
                                    onClick={handleEditClick}
                                    className="px-4 py-2 text-sm bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg transition-colors"
                                >
                                    Edit Transaction
                                </button>
                            )}
                        </div>
                    )}
                </div>
            ) : null}

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

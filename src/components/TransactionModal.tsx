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
            default: return { label: 'Not Reconciled', color: 'text-neutral-400 bg-neutral-500/10' };
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
            size="lg"
        >
            {loading ? (
                <div className="p-8 flex items-center justify-center">
                    <div className="flex items-center gap-3">
                        <div className="w-5 h-5 border-2 border-cyan-500/30 border-t-cyan-500 rounded-full animate-spin" />
                        <span className="text-neutral-400">Loading transaction...</span>
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
                                <h3 className="text-xl font-semibold text-neutral-100">
                                    {transaction.description}
                                </h3>
                                {transaction.num && (
                                    <span className="text-sm text-neutral-500">#{transaction.num}</span>
                                )}
                            </div>
                            <div className="text-right shrink-0">
                                <div className="text-sm text-neutral-400">Post Date</div>
                                <div className="text-neutral-100 font-mono">
                                    {new Date(transaction.post_date).toLocaleDateString('en-US', {
                                        weekday: 'short',
                                        year: 'numeric',
                                        month: 'short',
                                        day: 'numeric',
                                    })}
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Splits Table */}
                    <div>
                        <h4 className="text-sm font-semibold text-neutral-400 uppercase tracking-wider mb-3">
                            Splits
                        </h4>
                        <div className="bg-neutral-950/50 border border-neutral-800 rounded-xl overflow-hidden">
                            <table className="w-full">
                                <thead>
                                    <tr className="text-xs text-neutral-500 uppercase tracking-wider">
                                        <th className="px-4 py-3 text-left">Account</th>
                                        <th className="px-4 py-3 text-left">Memo</th>
                                        <th className="px-4 py-3 text-left">Action</th>
                                        <th className="px-4 py-3 text-center">Status</th>
                                        <th className="px-4 py-3 text-right">Amount</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-neutral-800">
                                    {transaction.splits.map(split => {
                                        const amount = parseFloat(split.quantity_decimal);
                                        const reconcile = getReconcileLabel(split.reconcile_state);
                                        return (
                                            <tr key={split.guid} className="hover:bg-neutral-800/30">
                                                <td className="px-4 py-3">
                                                    <Link
                                                        href={`/accounts/${split.account_guid}`}
                                                        className="text-neutral-200 hover:text-cyan-400 transition-colors"
                                                        onClick={onClose}
                                                    >
                                                        {split.account_name}
                                                    </Link>
                                                </td>
                                                <td className="px-4 py-3 text-sm text-neutral-500 italic">
                                                    {split.memo || '—'}
                                                </td>
                                                <td className="px-4 py-3 text-sm text-neutral-400">
                                                    {split.action || '—'}
                                                </td>
                                                <td className="px-4 py-3 text-center">
                                                    <span className={`text-xs px-2 py-1 rounded-full ${reconcile.color}`}>
                                                        {split.reconcile_state.toUpperCase()}
                                                    </span>
                                                </td>
                                                <td className={`px-4 py-3 text-right font-mono ${
                                                    amount < 0 ? 'text-rose-400' : 'text-emerald-400'
                                                }`}>
                                                    {formatCurrency(split.quantity_decimal, split.commodity_mnemonic)}
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
                        <div className="bg-neutral-950/50 border border-neutral-800 rounded-xl p-4">
                            <div className="text-neutral-500 text-xs uppercase tracking-wider mb-1">Enter Date</div>
                            <div className="text-neutral-300 font-mono">
                                {new Date(transaction.enter_date).toLocaleString()}
                            </div>
                        </div>
                        <div className="bg-neutral-950/50 border border-neutral-800 rounded-xl p-4">
                            <div className="text-neutral-500 text-xs uppercase tracking-wider mb-1">Transaction ID</div>
                            <div className="text-neutral-300 font-mono text-xs truncate" title={transaction.guid}>
                                {transaction.guid}
                            </div>
                        </div>
                    </div>

                    {/* Actions */}
                    {(onEdit || onDelete) && (
                        <div className="flex justify-end gap-3 pt-4 border-t border-neutral-800">
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

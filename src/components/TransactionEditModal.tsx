'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { Modal } from './ui/Modal';
import { Transaction, Split, CreateTransactionRequest } from '@/lib/types';
import { formatCurrency } from '@/lib/format';
import { TransactionForm } from './TransactionForm';

interface TransactionEditModalProps {
    transactionGuid: string | null;
    isOpen: boolean;
    onClose: () => void;
    onSaved?: () => void;
    onDeleted?: () => void;
    mode?: 'view' | 'edit' | 'create';
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

export function TransactionEditModal({
    transactionGuid,
    isOpen,
    onClose,
    onSaved,
    onDeleted,
    mode: initialMode = 'view',
}: TransactionEditModalProps) {
    const [transaction, setTransaction] = useState<TransactionDetail | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [mode, setMode] = useState<'view' | 'edit' | 'create'>(initialMode);
    const [deleting, setDeleting] = useState(false);
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

    useEffect(() => {
        setMode(initialMode);
    }, [initialMode, isOpen]);

    useEffect(() => {
        if (!isOpen) {
            setTransaction(null);
            setShowDeleteConfirm(false);
            return;
        }

        if (mode === 'create' || !transactionGuid) {
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
    }, [isOpen, transactionGuid, mode]);

    const handleSave = useCallback(async (data: CreateTransactionRequest) => {
        const url = mode === 'create'
            ? '/api/transactions'
            : `/api/transactions/${transactionGuid}`;
        const method = mode === 'create' ? 'POST' : 'PUT';

        const res = await fetch(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
        });

        if (!res.ok) {
            const errorData = await res.json();
            throw new Error(errorData.errors?.[0]?.message || 'Failed to save transaction');
        }

        onSaved?.();
        onClose();
    }, [mode, transactionGuid, onSaved, onClose]);

    const handleDelete = useCallback(async () => {
        if (!transactionGuid) return;

        setDeleting(true);
        try {
            const res = await fetch(`/api/transactions/${transactionGuid}`, {
                method: 'DELETE',
            });

            if (!res.ok) {
                throw new Error('Failed to delete transaction');
            }

            onDeleted?.();
            onClose();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to delete');
        } finally {
            setDeleting(false);
        }
    }, [transactionGuid, onDeleted, onClose]);

    const getReconcileLabel = (state: string) => {
        switch (state) {
            case 'y': return { label: 'Reconciled', color: 'text-emerald-400 bg-emerald-500/10' };
            case 'c': return { label: 'Cleared', color: 'text-amber-400 bg-amber-500/10' };
            default: return { label: 'Not Reconciled', color: 'text-foreground-secondary bg-surface/10' };
        }
    };

    const getTitle = () => {
        if (mode === 'create') return 'New Transaction';
        if (mode === 'edit') return 'Edit Transaction';
        return 'Transaction Details';
    };

    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title={getTitle()}
            size="lg"
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
            ) : mode === 'create' || mode === 'edit' ? (
                <div className="p-6">
                    <TransactionForm
                        transaction={transaction}
                        onSave={handleSave}
                        onCancel={mode === 'edit' ? () => setMode('view') : onClose}
                        defaultCurrencyGuid={transaction?.currency_guid}
                    />
                </div>
            ) : transaction ? (
                <div className="p-6 space-y-6">
                    {/* Delete Confirmation */}
                    {showDeleteConfirm && (
                        <div className="bg-rose-500/10 border border-rose-500/30 rounded-lg p-4">
                            <p className="text-rose-400 mb-3">
                                Are you sure you want to delete this transaction? This action cannot be undone.
                            </p>
                            <div className="flex gap-2 justify-end">
                                <button
                                    onClick={() => setShowDeleteConfirm(false)}
                                    className="px-3 py-1.5 text-sm text-foreground-secondary hover:text-foreground transition-colors"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={handleDelete}
                                    disabled={deleting}
                                    className="px-3 py-1.5 text-sm bg-rose-600 hover:bg-rose-500 disabled:bg-rose-600/50 text-white rounded-lg transition-colors"
                                >
                                    {deleting ? 'Deleting...' : 'Yes, Delete'}
                                </button>
                            </div>
                        </div>
                    )}

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
                                        <th className="px-4 py-3 text-left">Action</th>
                                        <th className="px-4 py-3 text-center">Status</th>
                                        <th className="px-4 py-3 text-right">Amount</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-border">
                                    {transaction.splits.map(split => {
                                        const amount = parseFloat(split.quantity_decimal);
                                        const reconcile = getReconcileLabel(split.reconcile_state);
                                        return (
                                            <tr key={split.guid} className="hover:bg-surface-hover/30">
                                                <td className="px-4 py-3">
                                                    <Link
                                                        href={`/accounts/${split.account_guid}`}
                                                        className="text-foreground hover:text-cyan-400 transition-colors"
                                                        onClick={onClose}
                                                    >
                                                        {split.account_name}
                                                    </Link>
                                                </td>
                                                <td className="px-4 py-3 text-sm text-foreground-muted italic">
                                                    {split.memo || '—'}
                                                </td>
                                                <td className="px-4 py-3 text-sm text-foreground-secondary">
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
                    <div className="flex justify-end gap-3 pt-4 border-t border-border">
                        <button
                            onClick={() => setShowDeleteConfirm(true)}
                            className="px-4 py-2 text-sm text-rose-400 hover:text-rose-300 hover:bg-rose-500/10 rounded-lg transition-colors"
                        >
                            Delete
                        </button>
                        <button
                            onClick={() => setMode('edit')}
                            className="px-4 py-2 text-sm bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg transition-colors"
                        >
                            Edit Transaction
                        </button>
                    </div>
                </div>
            ) : null}
        </Modal>
    );
}

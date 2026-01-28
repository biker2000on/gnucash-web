'use client';

import { useState, useEffect } from 'react';
import { Modal } from './ui/Modal';
import { TransactionForm } from './TransactionForm';
import { Transaction, CreateTransactionRequest } from '@/lib/types';
import { useToast } from '@/contexts/ToastContext';

interface TransactionFormModalProps {
    isOpen: boolean;
    onClose: () => void;
    transaction?: Transaction | null;
    defaultAccountGuid?: string;
    onSuccess: () => void;
}

export function TransactionFormModal({
    isOpen,
    onClose,
    transaction,
    defaultAccountGuid,
    onSuccess,
}: TransactionFormModalProps) {
    const { success, error: showError } = useToast();
    const [fullTransaction, setFullTransaction] = useState<Transaction | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const isEditMode = transaction !== null && transaction !== undefined;

    // Fetch full transaction data with splits when in edit mode
    useEffect(() => {
        if (!isOpen) {
            setFullTransaction(null);
            setLoading(false);
            setError(null);
            return;
        }

        if (isEditMode && transaction) {
            setLoading(true);
            setError(null);

            fetch(`/api/transactions/${transaction.guid}`)
                .then((res) => {
                    if (!res.ok) {
                        throw new Error(`Failed to fetch transaction: ${res.statusText}`);
                    }
                    return res.json();
                })
                .then((data) => {
                    setFullTransaction(data);
                    setLoading(false);
                })
                .catch((err) => {
                    setError(err.message || 'Failed to load transaction');
                    setLoading(false);
                });
        }
    }, [isOpen, isEditMode, transaction]);

    const handleSave = async (data: CreateTransactionRequest) => {
        setError(null);

        try {
            const url = isEditMode && transaction
                ? `/api/transactions/${transaction.guid}`
                : '/api/transactions';

            const method = isEditMode ? 'PUT' : 'POST';

            const response = await fetch(url, {
                method,
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(data),
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.error || `Failed to ${isEditMode ? 'update' : 'create'} transaction`);
            }

            success(isEditMode ? 'Transaction updated successfully' : 'Transaction created successfully');
            onSuccess();
            onClose();
        } catch (err) {
            const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred';
            setError(errorMessage);
            showError(errorMessage);
            throw new Error(errorMessage);
        }
    };

    const handleCancel = () => {
        setError(null);
        onClose();
    };

    return (
        <Modal
            isOpen={isOpen}
            onClose={handleCancel}
            title={isEditMode ? 'Edit Transaction' : 'New Transaction'}
            size="2xl"
            closeOnBackdrop={false}
            closeOnEscape={true}
        >
            <div className="px-6 py-4">
                {error && (
                    <div className="mb-4 bg-rose-500/10 border border-rose-500/30 rounded-lg p-4">
                        <p className="text-sm text-rose-400">{error}</p>
                    </div>
                )}

                {loading ? (
                    <div className="flex items-center justify-center py-12">
                        <div className="flex flex-col items-center gap-3">
                            <div className="w-8 h-8 border-2 border-cyan-500/30 border-t-cyan-500 rounded-full animate-spin" />
                            <p className="text-sm text-neutral-400">Loading transaction...</p>
                        </div>
                    </div>
                ) : (
                    <TransactionForm
                        transaction={isEditMode ? fullTransaction : null}
                        onSave={handleSave}
                        onCancel={handleCancel}
                        defaultFromAccount={defaultAccountGuid}
                    />
                )}
            </div>
        </Modal>
    );
}

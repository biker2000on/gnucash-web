'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Modal } from './ui/Modal';
import { ConfirmationDialog } from './ui/ConfirmationDialog';
import { TransactionForm, type TransactionFormHandle } from './TransactionForm';
import { Transaction, CreateTransactionRequest } from '@/lib/types';
import { useToast } from '@/contexts/ToastContext';

interface TransactionFormModalProps {
    isOpen: boolean;
    onClose: () => void;
    transaction?: Transaction | null;
    defaultAccountGuid?: string;
    onSuccess: () => void;
    onRefresh?: () => void;
}

export function TransactionFormModal({
    isOpen,
    onClose,
    transaction,
    defaultAccountGuid,
    onSuccess,
    onRefresh,
}: TransactionFormModalProps) {
    const { success, error: showError } = useToast();
    const [fullTransaction, setFullTransaction] = useState<Transaction | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [discardPromptOpen, setDiscardPromptOpen] = useState(false);
    const formHandleRef = useRef<TransactionFormHandle>(null);
    // Where focus was when the discard prompt opened — the field the user was
    // typing in, or the button they clicked. Declining returns it there
    // instead of dropping focus on the page body.
    const focusBeforePromptRef = useRef<HTMLElement | null>(null);

    const isEditMode = transaction !== null && transaction !== undefined;

    // Fetch full transaction data with splits when in edit mode
    useEffect(() => {
        if (!isOpen) {
            setFullTransaction(null);
            setLoading(false);
            setError(null);
            setDiscardPromptOpen(false);
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

            // Optimistic-lock token: echo back the enter_date we loaded so
            // the server can detect concurrent edits (null = row had none).
            const loadedEnterDate = fullTransaction?.enter_date ?? transaction?.enter_date ?? null;
            const payload = isEditMode
                ? {
                    ...data,
                    original_enter_date: loadedEnterDate
                        ? new Date(loadedEnterDate).toISOString()
                        : null,
                }
                : data;

            const response = await fetch(url, {
                method,
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(payload),
            });

            if (response.status === 409 || response.status === 428) {
                // Reload the latest version so the user can redo their edit
                if (isEditMode && transaction) {
                    try {
                        const fresh = await fetch(`/api/transactions/${transaction.guid}`);
                        if (fresh.ok) setFullTransaction(await fresh.json());
                    } catch {
                        // keep the stale copy; the error message still shows
                    }
                }
                throw new Error('This transaction was changed by someone else — the latest version has been reloaded. Please review and save again.');
            }

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

    const handleSaveAndAnother = async (data: CreateTransactionRequest) => {
        setError(null);

        try {
            const response = await fetch('/api/transactions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(data),
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.error || 'Failed to create transaction');
            }

            // Refresh the list without closing the modal
            if (onRefresh) {
                onRefresh();
            }
        } catch (err) {
            const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred';
            setError(errorMessage);
            showError(errorMessage);
            throw new Error(errorMessage);
        }
    };

    /** Close for real, throwing away whatever is in the form. */
    const discardAndClose = useCallback(() => {
        setDiscardPromptOpen(false);
        focusBeforePromptRef.current = null;
        setError(null);
        onClose();
    }, [onClose]);

    /**
     * Every way out of this modal that is not a successful save — Escape, the
     * header close button and the form's own Cancel button all land here. A
     * pristine form closes straight away; one holding typed work asks first,
     * so a single keystroke cannot destroy a half-entered transaction.
     * (The backdrop is not an exit path: closeOnBackdrop is false below.)
     */
    const handleCancel = useCallback(() => {
        if (formHandleRef.current?.isDirty()) {
            focusBeforePromptRef.current = document.activeElement as HTMLElement | null;
            setDiscardPromptOpen(true);
            return;
        }
        discardAndClose();
    }, [discardAndClose]);

    const keepEditing = useCallback(() => {
        setDiscardPromptOpen(false);
    }, []);

    // Runs after the prompt has unmounted, so focus lands back on the field or
    // button the user left rather than on the page body.
    useEffect(() => {
        if (discardPromptOpen) return;
        const previous = focusBeforePromptRef.current;
        focusBeforePromptRef.current = null;
        if (previous?.isConnected) previous.focus({ preventScroll: true });
    }, [discardPromptOpen]);

    return (
        <Modal
            isOpen={isOpen}
            onClose={handleCancel}
            title={isEditMode ? 'Edit Transaction' : 'New Transaction'}
            size="2xl"
            closeOnBackdrop={false}
            // While the discard prompt is up it owns Escape; otherwise both
            // dialogs would answer the same keystroke.
            closeOnEscape={!discardPromptOpen}
            resetKey={transaction?.guid ?? 'new'}
        >
            <div className="px-6 py-4">
                {error && (
                    <div className="mb-4 bg-negative/10 border border-negative/30 rounded-lg p-4">
                        <p className="text-sm text-negative">{error}</p>
                    </div>
                )}

                {loading ? (
                    <div className="flex items-center justify-center py-12">
                        <div className="flex flex-col items-center gap-3">
                            <div className="w-8 h-8 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                            <p className="text-sm text-foreground-secondary">Loading transaction...</p>
                        </div>
                    </div>
                ) : (
                    <TransactionForm
                        ref={formHandleRef}
                        transaction={isEditMode ? fullTransaction : null}
                        onSave={handleSave}
                        onCancel={handleCancel}
                        defaultFromAccount={defaultAccountGuid}
                        onSaveAndAnother={!isEditMode ? handleSaveAndAnother : undefined}
                    />
                )}
            </div>

            <ConfirmationDialog
                isOpen={discardPromptOpen}
                onConfirm={discardAndClose}
                onCancel={keepEditing}
                title="Discard this transaction?"
                message={isEditMode
                    ? 'This transaction has unsaved changes. Closing now discards them.'
                    : 'This transaction has not been saved. Closing now discards what you entered.'}
                confirmLabel="Discard"
                cancelLabel="Keep editing"
                confirmVariant="danger"
                // Discarding is the irreversible half, so it is not the button
                // sitting under a reflexive Enter.
                defaultFocus="cancel"
                confirmOnEnter={false}
            />
        </Modal>
    );
}

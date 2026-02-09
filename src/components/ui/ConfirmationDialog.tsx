'use client';

import { useEffect, useRef } from 'react';
import { Modal } from './Modal';

interface ConfirmationDialogProps {
    isOpen: boolean;
    onConfirm: () => void;
    onCancel: () => void;
    title: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
    confirmVariant?: 'danger' | 'warning' | 'default';
    isLoading?: boolean;
}

const variantClasses = {
    danger: 'bg-red-600 hover:bg-red-700 focus:ring-red-500',
    warning: 'bg-amber-600 hover:bg-amber-700 focus:ring-amber-500',
    default: 'bg-blue-600 hover:bg-blue-700 focus:ring-blue-500',
};

export function ConfirmationDialog({
    isOpen,
    onConfirm,
    onCancel,
    title,
    message,
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    confirmVariant = 'default',
    isLoading = false,
}: ConfirmationDialogProps) {
    const confirmButtonRef = useRef<HTMLButtonElement>(null);

    // Focus confirm button when dialog opens
    useEffect(() => {
        if (isOpen && confirmButtonRef.current) {
            // Small delay to ensure modal animations complete
            setTimeout(() => {
                confirmButtonRef.current?.focus({ preventScroll: true });
            }, 100);
        }
    }, [isOpen]);

    // Handle keyboard shortcuts
    useEffect(() => {
        if (!isOpen || isLoading) return;

        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
                e.preventDefault();
                onConfirm();
            }
        };

        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [isOpen, isLoading, onConfirm]);

    return (
        <Modal
            isOpen={isOpen}
            onClose={isLoading ? () => {} : onCancel}
            title={title}
            size="sm"
            closeOnBackdrop={!isLoading}
            closeOnEscape={!isLoading}
        >
            <div className="px-6 py-4">
                <p className="text-foreground-secondary leading-relaxed">{message}</p>
            </div>

            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-border">
                <button
                    type="button"
                    onClick={onCancel}
                    disabled={isLoading}
                    className="px-4 py-2 text-sm font-medium text-foreground-secondary bg-background-tertiary border border-border-hover rounded-lg hover:bg-surface-hover hover:text-foreground focus:outline-none focus:ring-2 focus:ring-foreground-muted focus:ring-offset-2 focus:ring-offset-background-secondary disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    aria-label={cancelLabel}
                >
                    {cancelLabel}
                </button>
                <button
                    ref={confirmButtonRef}
                    type="button"
                    onClick={onConfirm}
                    disabled={isLoading}
                    className={`
                        px-4 py-2 text-sm font-medium text-white rounded-lg
                        focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-background-secondary
                        disabled:opacity-50 disabled:cursor-not-allowed
                        transition-colors
                        inline-flex items-center gap-2
                        ${variantClasses[confirmVariant]}
                    `}
                    aria-label={confirmLabel}
                >
                    {isLoading && (
                        <svg
                            className="animate-spin h-4 w-4"
                            xmlns="http://www.w3.org/2000/svg"
                            fill="none"
                            viewBox="0 0 24 24"
                            aria-hidden="true"
                        >
                            <circle
                                className="opacity-25"
                                cx="12"
                                cy="12"
                                r="10"
                                stroke="currentColor"
                                strokeWidth="4"
                            />
                            <path
                                className="opacity-75"
                                fill="currentColor"
                                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                            />
                        </svg>
                    )}
                    {confirmLabel}
                </button>
            </div>
        </Modal>
    );
}

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
    /**
     * Which button holds focus when the dialog opens. Defaults to 'confirm'.
     * Use 'cancel' when confirming destroys something the user cannot get
     * back, so the safe choice is the one already under the keyboard.
     */
    defaultFocus?: 'confirm' | 'cancel';
    /**
     * Whether a bare Enter anywhere in the dialog confirms. Defaults to true.
     * Turn it off for the same reason as above: a reflexive Enter must not be
     * able to trigger an irreversible action.
     */
    confirmOnEnter?: boolean;
}

const variantClasses = {
    danger: 'bg-error hover:bg-error/85 focus:ring-error',
    warning: 'bg-warning hover:bg-warning/85 focus:ring-warning',
    default: 'bg-secondary hover:bg-secondary-hover focus:ring-secondary',
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
    defaultFocus = 'confirm',
    confirmOnEnter = true,
}: ConfirmationDialogProps) {
    const confirmButtonRef = useRef<HTMLButtonElement>(null);
    const cancelButtonRef = useRef<HTMLButtonElement>(null);

    // Focus the chosen button when the dialog opens
    useEffect(() => {
        if (!isOpen) return;
        // Small delay to ensure modal animations complete. Cleared on close so
        // a dialog dismissed inside that window cannot pull focus back to a
        // button that is on its way out.
        const timer = setTimeout(() => {
            const target = defaultFocus === 'cancel' ? cancelButtonRef.current : confirmButtonRef.current;
            target?.focus({ preventScroll: true });
        }, 100);
        return () => clearTimeout(timer);
    }, [isOpen, defaultFocus]);

    // Handle keyboard shortcuts
    useEffect(() => {
        if (!isOpen || isLoading || !confirmOnEnter) return;

        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
                e.preventDefault();
                onConfirm();
            }
        };

        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [isOpen, isLoading, confirmOnEnter, onConfirm]);

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
                    ref={cancelButtonRef}
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
                        px-4 py-2 text-sm font-medium text-primary-foreground rounded-lg
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

'use client';

import { ReactNode, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useIsMobile } from '@/lib/hooks/useIsMobile';

interface ModalProps {
    isOpen: boolean;
    onClose: () => void;
    title?: string;
    children: ReactNode;
    size?: 'sm' | 'md' | 'lg' | 'xl' | '2xl' | 'fullscreen';
    closeOnBackdrop?: boolean;
    closeOnEscape?: boolean;
    /** Reset the scroll container when asynchronously loaded content changes identity. */
    resetKey?: string | number | null;
    /** Extra icon buttons rendered in the title bar, before the close button. */
    headerActions?: ReactNode;
}

const sizeClasses = {
    sm: 'max-w-md',
    md: 'max-w-lg',
    lg: 'max-w-2xl',
    xl: 'max-w-4xl',
    '2xl': 'max-w-5xl',
    fullscreen: 'max-w-[calc(100vw-2rem)] w-[calc(100vw-2rem)] h-[calc(100dvh-2rem)]',
};

export function Modal({
    isOpen,
    onClose,
    title,
    children,
    size = 'md',
    closeOnBackdrop = true,
    closeOnEscape = true,
    resetKey,
    headerActions,
}: ModalProps) {
    const modalRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef<HTMLDivElement>(null);
    const mounted = useSyncExternalStore(
        () => () => undefined,
        () => true,
        () => false
    );
    const isMobile = useIsMobile();
    const mobileFullscreen = isMobile;
    const effectiveSize = isMobile ? 'fullscreen' : size;

    // Handle escape key
    useEffect(() => {
        if (!isOpen || !closeOnEscape) return;

        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                onClose();
            }
        };

        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [isOpen, closeOnEscape, onClose]);

    // Lock body scroll when modal is open
    useEffect(() => {
        if (isOpen) {
            const previousOverflow = document.body.style.overflow;
            document.body.style.overflow = 'hidden';
            return () => {
                document.body.style.overflow = previousOverflow;
            };
        }
    }, [isOpen]);

    // Reset before paint and once more after async content has laid out. The
    // second reset prevents browsers from restoring the prior scroll offset
    // when a transaction fetch replaces the loading state.
    useLayoutEffect(() => {
        if (!isOpen) return;
        const reset = () => {
            if (!contentRef.current) return;
            contentRef.current.scrollTop = 0;
            contentRef.current.scrollLeft = 0;
        };
        reset();
        const frame = requestAnimationFrame(reset);
        return () => cancelAnimationFrame(frame);
    }, [isOpen, resetKey]);

    // Focus trap
    useEffect(() => {
        if (!isOpen) return;

        const focusableElements = modalRef.current?.querySelectorAll(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        const firstElement = focusableElements?.[0] as HTMLElement;
        const lastElement = focusableElements?.[focusableElements.length - 1] as HTMLElement;

        const handleTabKey = (e: KeyboardEvent) => {
            if (e.key !== 'Tab') return;

            if (e.shiftKey && document.activeElement === firstElement) {
                e.preventDefault();
                lastElement?.focus();
            } else if (!e.shiftKey && document.activeElement === lastElement) {
                e.preventDefault();
                firstElement?.focus();
            }
        };

        document.addEventListener('keydown', handleTabKey);
        // Use preventScroll to avoid unwanted scrolling when focusing
        firstElement?.focus({ preventScroll: true });

        return () => document.removeEventListener('keydown', handleTabKey);
    }, [isOpen]);

    // Don't render on server or when closed
    if (!mounted || !isOpen) return null;

    const modalContent = (
        <div className={`fixed inset-0 z-[9999] flex h-[100dvh] items-center justify-center overflow-hidden overscroll-contain ${mobileFullscreen ? '' : 'p-4'}`}>
            {/* Backdrop */}
            <div
                className="absolute inset-0 bg-black/70"
                onClick={closeOnBackdrop ? onClose : undefined}
            />

            {/* Modal */}
            <div
                ref={modalRef}
                className={`relative flex w-full min-w-0 flex-col overflow-hidden border border-border bg-surface-elevated shadow-xl ${
                    mobileFullscreen
                        ? 'w-full h-[100dvh] max-w-none max-h-none rounded-none'
                        : `my-auto rounded-lg ${sizeClasses[effectiveSize]} max-h-[calc(100dvh-2rem)]`
                }`}
                role="dialog"
                aria-modal="true"
                aria-labelledby={title ? 'modal-title' : undefined}
            >
                {/* Header */}
                {title && (
                    <div className="flex shrink-0 items-center justify-between border-b border-border px-5 py-4">
                        <h2 id="modal-title" className="text-lg font-semibold text-foreground">
                            {title}
                        </h2>
                        <div className="flex items-center gap-1">
                            {headerActions}
                            <button
                                onClick={onClose}
                                aria-label="Close dialog"
                                className="text-foreground-secondary hover:text-foreground transition-colors p-1 rounded-lg hover:bg-surface-hover"
                            >
                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                </svg>
                            </button>
                        </div>
                    </div>
                )}

                {/* Content */}
                <div ref={contentRef} className="min-w-0 flex-1 overflow-auto">
                    {children}
                </div>
            </div>
        </div>
    );

    // Use portal to render modal at document body level
    return createPortal(modalContent, document.body);
}

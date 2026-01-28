'use client';

import React from 'react';
import { useToast } from '@/contexts/ToastContext';
import { Toast } from './Toast';

export function ToastContainer() {
    const { toasts, removeToast } = useToast();

    return (
        <div
            className="fixed bottom-4 right-4 z-50 flex flex-col gap-2"
            aria-live="polite"
            aria-atomic="true"
        >
            {toasts.map((toast) => (
                <Toast key={toast.id} toast={toast} onClose={() => removeToast(toast.id)} />
            ))}
        </div>
    );
}

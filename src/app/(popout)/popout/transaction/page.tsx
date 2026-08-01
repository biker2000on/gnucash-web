'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { TransactionDetailContent } from '@/components/TransactionModal';
import { PopoutPaneHeader } from '@/components/popout/PopoutPaneHeader';
import { usePopoutChild } from '@/lib/popout/usePopout';

function TransactionPopoutPane() {
    const searchParams = useSearchParams();
    const [guid, setGuid] = useState<string | null>(searchParams.get('tx'));

    const handleShow = useCallback((payload: unknown) => {
        if (typeof payload === 'string' && payload) setGuid(payload);
    }, []);
    usePopoutChild('transaction', handleShow);

    useEffect(() => {
        document.title = 'Transaction Details — GnuCash Web';
    }, []);

    // Keep the URL current so a refresh of the pop-out restores the same view.
    useEffect(() => {
        if (guid) {
            window.history.replaceState(null, '', `/popout/transaction?tx=${encodeURIComponent(guid)}`);
        }
    }, [guid]);

    return (
        <div>
            <PopoutPaneHeader title="Transaction Details" />
            <div className="mx-auto max-w-4xl">
                {guid ? (
                    <TransactionDetailContent transactionGuid={guid} />
                ) : (
                    <p className="p-8 text-center text-sm text-foreground-secondary">
                        Select a transaction in the main window to view it here.
                    </p>
                )}
            </div>
        </div>
    );
}

export default function TransactionPopoutPage() {
    return (
        <Suspense fallback={null}>
            <TransactionPopoutPane />
        </Suspense>
    );
}

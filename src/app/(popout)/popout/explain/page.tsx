'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { ProvenanceTraceView, type ExplainPayload } from '@/components/provenance/ProvenanceModal';
import { PopoutPaneHeader } from '@/components/popout/PopoutPaneHeader';
import { usePopoutChild } from '@/lib/popout/usePopout';

function ExplainPopoutPane() {
    const searchParams = useSearchParams();
    const [payload, setPayload] = useState<ExplainPayload>(() => ({
        traceId: searchParams.get('trace'),
    }));

    const handleShow = useCallback((incoming: unknown) => {
        if (incoming && typeof incoming === 'object') {
            setPayload(incoming as ExplainPayload);
        }
    }, []);
    usePopoutChild('explain', handleShow);

    useEffect(() => {
        document.title = 'Explain this number — GnuCash Web';
    }, []);

    // Keep the URL current so a refresh of the pop-out restores the same trace
    // (persisted traces re-fetch by token; inline-only traces cannot).
    useEffect(() => {
        const id = payload.trace?.id ?? payload.traceId;
        if (id) {
            window.history.replaceState(null, '', `/popout/explain?trace=${encodeURIComponent(id)}`);
        }
    }, [payload]);

    const hasTrace = Boolean(payload.trace || payload.traceId);

    return (
        <div>
            <PopoutPaneHeader title="Explain this number" />
            <div className="mx-auto max-w-3xl">
                {hasTrace ? (
                    <ProvenanceTraceView traceId={payload.traceId} trace={payload.trace} />
                ) : (
                    <p className="p-8 text-center text-sm text-foreground-secondary">
                        Open “Explain this number” in the main window to view a calculation here.
                    </p>
                )}
            </div>
        </div>
    );
}

export default function ExplainPopoutPage() {
    return (
        <Suspense fallback={null}>
            <ExplainPopoutPane />
        </Suspense>
    );
}

interface SimpleFinSyncIndicatorProps {
    status: string | null;
    error?: string | null;
    compact?: boolean;
}

function isAuthorizationIssue(status: string | null, error?: string | null): boolean {
    if (status === 'revoked') return true;
    return /\b(auth|authenticate|authentication|authorization|reconnect|revoked)\b/i.test(error ?? '');
}

export function isSimpleFinSyncFailure(status: string | null): boolean {
    return status === 'failed' || status === 'revoked';
}

export default function SimpleFinSyncIndicator({
    status,
    error,
    compact = false,
}: SimpleFinSyncIndicatorProps) {
    const hasFailure = isSimpleFinSyncFailure(status);
    const needsAuthorization = hasFailure && isAuthorizationIssue(status, error);
    const isSyncing = status === 'running' || status === 'queued';
    const label = needsAuthorization
        ? 'SimpleFIN authorization required'
        : hasFailure
            ? 'SimpleFIN sync failed'
            : isSyncing
                ? 'SimpleFIN syncing'
                : 'Linked to SimpleFIN';
    const title = hasFailure && error ? `${label}: ${error}` : label;
    const colorClass = hasFailure
        ? 'text-error'
        : isSyncing
            ? 'text-primary'
            : 'text-foreground-muted';

    const icon = hasFailure ? (
        <svg
            className="h-3.5 w-3.5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
        >
            <circle cx="12" cy="12" r="9" strokeWidth={2} />
            <path strokeLinecap="round" strokeWidth={2} d="M12 7.5v5.5" />
            <path strokeLinecap="round" strokeWidth={2.5} d="M12 16.5h.01" />
        </svg>
    ) : (
        <svg
            className="h-3.5 w-3.5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
        >
            <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
            />
        </svg>
    );

    if (compact) {
        return (
            <span
                className={`inline-flex flex-shrink-0 items-center justify-center ${colorClass}`}
                role="img"
                aria-label={label}
                title={title}
            >
                {icon}
            </span>
        );
    }

    return (
        <span
            className={`inline-flex items-center gap-1.5 rounded-sm border px-2 py-1 text-xs font-medium ${
                hasFailure
                    ? 'border-error/30 bg-error/10 text-error'
                    : isSyncing
                        ? 'border-primary/20 bg-primary/10 text-primary'
                        : 'border-border bg-background-tertiary text-foreground-muted'
            }`}
            role="status"
            aria-label={label}
            title={title}
        >
            {icon}
            <span>{label}</span>
        </span>
    );
}

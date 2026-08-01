'use client';

/** Icon button that pops the surrounding pane out into a separate window. */
export function PopoutButton({
    onClick,
    label = 'Open in separate window',
}: {
    onClick: () => void;
    label?: string;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            aria-label={label}
            title={label}
            className="hidden text-foreground-secondary hover:text-foreground transition-colors p-1 rounded-lg hover:bg-surface-hover sm:block"
        >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 5h6m0 0v6m0-6L10.5 13.5" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14.5V18a2 2 0 01-2 2H6a2 2 0 01-2-2V7a2 2 0 012-2h3.5" />
            </svg>
        </button>
    );
}

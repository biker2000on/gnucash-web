'use client';

/** Sticky header for pop-out pane windows. */
export function PopoutPaneHeader({ title }: { title: string }) {
    return (
        <header className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-background-secondary px-5 py-3">
            <h1 className="text-sm font-semibold text-foreground">{title}</h1>
            <span className="text-[11px] text-foreground-muted">Synced with main window</span>
        </header>
    );
}

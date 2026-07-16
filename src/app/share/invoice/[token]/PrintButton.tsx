'use client';

/**
 * "Download PDF" for the public invoice page — window.print() with the page's
 * print CSS (same approach as ReportViewer; no PDF dependencies). Hidden in
 * the printout itself via print:hidden.
 */
export function PrintButton() {
    return (
        <button
            type="button"
            onClick={() => window.print()}
            className="px-4 py-2 text-sm bg-primary hover:bg-primary-hover text-primary-foreground rounded-lg transition-colors print:hidden"
        >
            Download PDF
        </button>
    );
}

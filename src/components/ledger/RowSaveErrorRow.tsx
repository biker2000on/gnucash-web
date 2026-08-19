'use client';

/**
 * The reason an inline row edit was rejected, shown on the row it belongs to.
 *
 * Inline-edit failures used to surface only as a toast. A toast is transient,
 * lands in a corner of the viewport, and — in a ledger that can show hundreds
 * of rows — never says *which* edit the server refused. The toast still fires
 * (it is what catches the eye); this is what stays put and says where.
 *
 * It renders as its own `<tr>` so it can sit directly under the failed row
 * without disturbing the column grid. `role="alert"` is deliberately NOT set
 * here: `AccountLedger` announces through a single `ErrorLiveRegion`, and a
 * second role would announce the same failure twice.
 */
export function RowSaveErrorRow({ message, colSpan }: { message?: string; colSpan: number }) {
    if (!message) return null;
    return (
        <tr data-testid="row-save-error" className="bg-error/10">
            <td colSpan={colSpan} className="border-l-2 border-l-error px-3 py-2 text-xs text-error">
                {message}
            </td>
        </tr>
    );
}

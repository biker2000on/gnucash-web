export type DateFormat = 'MM/DD/YYYY' | 'YYYY-MM-DD' | 'MM-DD-YYYY';

export function formatDateForDisplay(isoDate: string, format: DateFormat): string {
    if (!isoDate || !isoDate.includes('-')) return isoDate;
    const parts = isoDate.split('-');
    if (parts.length !== 3) return isoDate;
    const [y, m, d] = parts;
    switch (format) {
        case 'MM/DD/YYYY': return `${m}/${d}/${y}`;
        case 'MM-DD-YYYY': return `${m}-${d}-${y}`;
        case 'YYYY-MM-DD': return isoDate;
    }
}

export function parseDateInput(input: string, _preferredFormat?: DateFormat): string | null {
    if (!input || !input.trim()) return null;
    const s = input.trim();

    // Try YYYY-MM-DD (ISO)
    const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (isoMatch) {
        const [, y, m, d] = isoMatch;
        return validateAndBuild(parseInt(y), parseInt(m), parseInt(d));
    }

    // Try MM/DD/YYYY or M/D/YYYY
    const slashMatch = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (slashMatch) {
        const [, m, d, y] = slashMatch;
        const year = y.length === 2 ? 2000 + parseInt(y) : parseInt(y);
        return validateAndBuild(year, parseInt(m), parseInt(d));
    }

    // Try MM-DD-YYYY or M-D-YYYY
    const dashMatch = s.match(/^(\d{1,2})-(\d{1,2})-(\d{2,4})$/);
    if (dashMatch) {
        const [, m, d, y] = dashMatch;
        const year = y.length === 2 ? 2000 + parseInt(y) : parseInt(y);
        return validateAndBuild(year, parseInt(m), parseInt(d));
    }

    return null;
}

function validateAndBuild(year: number, month: number, day: number): string | null {
    if (month < 1 || month > 12) return null;
    if (day < 1) return null;
    // Validate day against actual days in month
    const daysInMonth = new Date(year, month, 0).getDate();
    if (day > daysInMonth) return null;
    const mm = String(month).padStart(2, '0');
    const dd = String(day).padStart(2, '0');
    const yyyy = String(year).padStart(4, '0');
    return `${yyyy}-${mm}-${dd}`;
}

export interface DateRange {
    startDate: string | null;
    endDate: string | null;
}

export interface DatePreset {
    label: string;
    getValue: () => DateRange;
}

/**
 * Format a Date to YYYY-MM-DD using local timezone (not UTC).
 * Exported as toLocalDateString for reuse across the app.
 */
export function toLocalDateString(date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/**
 * Format a Date to YYYY-MM-DD using UTC timezone.
 * Use for database dates (stored as midnight UTC) to avoid timezone shift.
 */
export function toUTCDateString(date: Date): string {
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function formatDate(date: Date): string {
    return toLocalDateString(date);
}

function startOfMonth(date: Date): Date {
    return new Date(date.getFullYear(), date.getMonth(), 1);
}

function endOfMonth(date: Date): Date {
    return new Date(date.getFullYear(), date.getMonth() + 1, 0);
}

function startOfQuarter(date: Date): Date {
    const quarter = Math.floor(date.getMonth() / 3);
    return new Date(date.getFullYear(), quarter * 3, 1);
}

function endOfQuarter(date: Date): Date {
    const quarter = Math.floor(date.getMonth() / 3);
    return new Date(date.getFullYear(), quarter * 3 + 3, 0);
}

function startOfYear(date: Date): Date {
    return new Date(date.getFullYear(), 0, 1);
}

function endOfYear(date: Date): Date {
    return new Date(date.getFullYear(), 11, 31);
}

function subYears(date: Date, years: number): Date {
    return new Date(date.getFullYear() - years, date.getMonth(), date.getDate());
}

function subMonths(date: Date, months: number): Date {
    const result = new Date(date);
    result.setMonth(result.getMonth() - months);
    return result;
}

export const DATE_PRESETS: DatePreset[] = [
    {
        label: 'This Month',
        getValue: () => {
            const now = new Date();
            return {
                startDate: formatDate(startOfMonth(now)),
                endDate: formatDate(endOfMonth(now))
            };
        }
    },
    {
        label: 'Last Month',
        getValue: () => {
            const lastMonth = subMonths(new Date(), 1);
            return {
                startDate: formatDate(startOfMonth(lastMonth)),
                endDate: formatDate(endOfMonth(lastMonth))
            };
        }
    },
    {
        label: 'This Quarter',
        getValue: () => {
            const now = new Date();
            return {
                startDate: formatDate(startOfQuarter(now)),
                endDate: formatDate(endOfQuarter(now))
            };
        }
    },
    {
        label: 'This Year',
        getValue: () => {
            const now = new Date();
            return {
                startDate: formatDate(startOfYear(now)),
                endDate: formatDate(endOfYear(now))
            };
        }
    },
    {
        label: 'Last Year',
        getValue: () => {
            const lastYear = subYears(new Date(), 1);
            return {
                startDate: formatDate(startOfYear(lastYear)),
                endDate: formatDate(endOfYear(lastYear))
            };
        }
    },
    {
        label: 'All Time',
        getValue: () => ({
            startDate: null,
            endDate: null
        })
    }
];

export function getPresetByLabel(label: string): DatePreset | undefined {
    return DATE_PRESETS.find(p => p.label === label);
}

export function formatDateForDisplay(dateStr: string | null): string {
    if (!dateStr) return '';
    const date = new Date(dateStr + 'T00:00:00');
    return date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric'
    });
}

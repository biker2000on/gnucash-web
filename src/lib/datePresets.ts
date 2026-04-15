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

export function startOfMonth(date: Date): Date {
    return new Date(date.getFullYear(), date.getMonth(), 1);
}

export function endOfMonth(date: Date): Date {
    return new Date(date.getFullYear(), date.getMonth() + 1, 0);
}

export function startOfQuarter(date: Date): Date {
    const quarter = Math.floor(date.getMonth() / 3);
    return new Date(date.getFullYear(), quarter * 3, 1);
}

export function endOfQuarter(date: Date): Date {
    const quarter = Math.floor(date.getMonth() / 3);
    return new Date(date.getFullYear(), quarter * 3 + 3, 0);
}

export function startOfYear(date: Date): Date {
    return new Date(date.getFullYear(), 0, 1);
}

export function endOfYear(date: Date): Date {
    return new Date(date.getFullYear(), 11, 31);
}

/**
 * Generate a sequence of period windows covering [startDate, endDate], aligned
 * to calendar boundaries for the chosen grouping. The first period starts at or
 * before startDate, the last period ends at or after endDate.
 */
export function generatePeriods(
    startDate: Date,
    endDate: Date,
    grouping: 'month' | 'quarter' | 'year'
): Array<{ label: string; startDate: string; endDate: string }> {
    const periods: Array<{ label: string; startDate: string; endDate: string }> = [];
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    let cursor: Date;
    if (grouping === 'month') cursor = startOfMonth(startDate);
    else if (grouping === 'quarter') cursor = startOfQuarter(startDate);
    else cursor = startOfYear(startDate);

    const hardStop = endDate.getTime();
    let safety = 0;
    while (cursor.getTime() <= hardStop && safety++ < 500) {
        let periodEnd: Date;
        let label: string;
        if (grouping === 'month') {
            periodEnd = endOfMonth(cursor);
            label = `${monthNames[cursor.getMonth()]} ${cursor.getFullYear()}`;
        } else if (grouping === 'quarter') {
            periodEnd = endOfQuarter(cursor);
            const q = Math.floor(cursor.getMonth() / 3) + 1;
            label = `Q${q} ${cursor.getFullYear()}`;
        } else {
            periodEnd = endOfYear(cursor);
            label = String(cursor.getFullYear());
        }
        periods.push({
            label,
            startDate: toLocalDateString(cursor),
            endDate: toLocalDateString(periodEnd),
        });
        // Advance cursor to the start of the next period
        if (grouping === 'month') {
            cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
        } else if (grouping === 'quarter') {
            cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 3, 1);
        } else {
            cursor = new Date(cursor.getFullYear() + 1, 0, 1);
        }
    }
    return periods;
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

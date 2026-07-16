'use client';

// NOTE: constants are mirrored from src/lib/services/home.service.ts rather
// than imported — a value import would pull Prisma/storage into the client
// bundle. Type-only imports from the service remain safe.
const ITEM_CATEGORIES = [
    'furniture',
    'electronics',
    'appliance',
    'jewelry',
    'tool',
    'clothing',
    'decor',
    'other',
] as const;

export const WARRANTY_WARNING_DAYS = 90;

export const TNUM = { fontFeatureSettings: "'tnum'" } as const;

export const inputClass =
    'w-full rounded-lg border border-border bg-input-bg px-2.5 py-1.5 text-sm text-foreground placeholder:text-foreground-muted focus:border-primary/50 focus:outline-none';
export const labelClass = 'block text-xs text-foreground-secondary mb-1';

export const CATEGORY_OPTIONS = ITEM_CATEGORIES.map((value) => ({
    value,
    label: value.charAt(0).toUpperCase() + value.slice(1),
}));

export function categoryLabel(category: string | null): string | null {
    if (!category) return null;
    return CATEGORY_OPTIONS.find((o) => o.value === category)?.label ?? category;
}

/**
 * Warranty pill: expired in error tone, expiring within 90 days in warning
 * tone, anything further out muted.
 */
export function WarrantyBadge({
    warrantyExpires,
    warrantyDays,
}: {
    warrantyExpires: string | null;
    warrantyDays: number | null;
}) {
    if (!warrantyExpires || warrantyDays === null) return null;
    if (warrantyDays < 0) {
        return (
            <span className="inline-block rounded-full border border-error/30 bg-error/10 px-2 py-0.5 text-[11px] font-medium text-error whitespace-nowrap">
                Warranty expired {warrantyExpires}
            </span>
        );
    }
    if (warrantyDays <= WARRANTY_WARNING_DAYS) {
        return (
            <span className="inline-block rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-warning whitespace-nowrap">
                Warranty ends in {warrantyDays}d
            </span>
        );
    }
    return (
        <span className="inline-block rounded-full border border-border bg-background-tertiary px-2 py-0.5 text-[11px] text-foreground-muted whitespace-nowrap">
            Warranty {warrantyExpires}
        </span>
    );
}

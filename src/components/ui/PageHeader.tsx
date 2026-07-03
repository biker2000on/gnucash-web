'use client';

import { ReactNode } from 'react';
import { ActionMenu, ActionMenuItem } from './ActionMenu';

interface PageHeaderProps {
    title: string;
    subtitle?: string;
    /**
     * Primary actions (1-2 buttons max). Rendered inline next to the title on
     * desktop; below the title on mobile.
     */
    actions?: ReactNode;
    /** Secondary actions, tucked into an overflow "..." menu on all sizes. */
    menuActions?: ActionMenuItem[];
    /**
     * Optional toolbar row (filters, pickers) rendered under the title row.
     * Prefer wrapping filters in <FilterBar> so they collapse on mobile.
     */
    toolbar?: ReactNode;
}

/**
 * Standard page header: title + subtitle on the left, a small number of
 * primary actions plus an overflow menu on the right, and an optional
 * toolbar row underneath. Keeps headers consistent and mobile-friendly —
 * pages should not hand-roll rows of buttons.
 */
export function PageHeader({ title, subtitle, actions, menuActions, toolbar }: PageHeaderProps) {
    const hasMenu = menuActions && menuActions.length > 0;
    return (
        <div className="space-y-3">
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <h1 className="text-xl sm:text-2xl font-bold text-foreground truncate">{title}</h1>
                    {subtitle && (
                        <p className="text-sm text-foreground-secondary mt-0.5 hidden sm:block">{subtitle}</p>
                    )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                    {actions && <div className="hidden sm:flex items-center gap-2">{actions}</div>}
                    {hasMenu && <ActionMenu items={menuActions} />}
                </div>
            </div>
            {/* Primary actions drop below the title on small screens */}
            {actions && <div className="flex sm:hidden items-center gap-2 flex-wrap">{actions}</div>}
            {toolbar}
        </div>
    );
}

'use client';

import type { ReactNode } from 'react';

/**
 * A labelled checkbox rendered as a tappable chip.
 *
 * Replaces the `☑`/`☐` glyph pattern. A plain `<button>` whose only state cue
 * is which Unicode character it happens to be rendering is invisible to
 * assistive technology twice over: the button exposes no checked state at all,
 * and the glyph itself is announced by name ("ballot box with check") or, with
 * many fonts, not at all — so a screen reader user could neither tell the
 * control was a checkbox nor tell whether it was on.
 *
 * `role="checkbox"` + `aria-checked` is what makes the state part of the
 * accessible name/role/value triple, so it is announced on focus and
 * re-announced on every toggle. A `<button>` is the host element because it is
 * already keyboard-operable (Space and Enter) and already in the tab order —
 * the ARIA role only re-labels what it is.
 *
 * The visual check is an inline SVG, not a glyph: it inherits `currentColor`,
 * renders identically on every platform, and is `aria-hidden` because the role
 * already carries the state.
 */
export function CheckboxChip({
    checked,
    onChange,
    children,
    className = '',
    disabled = false,
}: {
    checked: boolean;
    onChange: (next: boolean) => void;
    /** Visible label. It is the accessible name — do not add an aria-label too. */
    children: ReactNode;
    className?: string;
    disabled?: boolean;
}) {
    return (
        <button
            type="button"
            role="checkbox"
            aria-checked={checked}
            disabled={disabled}
            onClick={() => onChange(!checked)}
            className={`flex min-h-[44px] items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                checked
                    ? 'border-primary/30 bg-primary/10 text-primary'
                    : 'border-border text-foreground-secondary hover:border-border-hover'
            } ${className}`}
        >
            <CheckboxBox checked={checked} />
            <span>{children}</span>
        </button>
    );
}

/** The 16px box itself, for callers that own their own label markup. */
export function CheckboxBox({ checked }: { checked: boolean }) {
    return (
        <span
            aria-hidden="true"
            className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border transition-colors ${
                checked ? 'border-primary bg-primary text-primary-foreground' : 'border-border-hover bg-transparent'
            }`}
        >
            {checked && (
                <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M3.5 8.5l3 3 6-7" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
            )}
        </span>
    );
}

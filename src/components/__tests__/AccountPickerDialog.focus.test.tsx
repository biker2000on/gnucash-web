/**
 * Keyboard focus visibility for the account picker search input (WCAG 2.4.7).
 *
 * The input suppresses the browser focus ring with `focus:outline-none`, so it
 * must supply its own visible replacement. It previously used
 * `focus:border-accent`, and `--color-accent` is not defined in globals.css, so
 * the class resolved to nothing and a keyboard user saw no focus indicator at
 * all. These tests assert both halves: an indicator class is present, and every
 * colour it names is a token that actually exists in the theme.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import AccountPickerDialog from '../AccountPickerDialog';

/** Colour tokens Tailwind exposes as utilities, read from the @theme block. */
function themeColorTokens(): Set<string> {
    const css = readFileSync(resolve(process.cwd(), 'src/app/globals.css'), 'utf8');
    const theme = css.slice(css.indexOf('@theme'));
    return new Set(
        [...theme.matchAll(/--color-([a-z0-9-]+)\s*:/g)].map((m) => m[1])
    );
}

/** Tailwind's built-in palette, which needs no project token to resolve. */
const BUILTIN_COLORS =
    /^(?:white|black|transparent|current|inherit|(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-\d{2,3})$/;

interface FocusClasses {
    all: string[];
    indicators: string[];
    unresolvedColors: string[];
}

function analyseFocusClasses(className: string): FocusClasses {
    const tokens = themeColorTokens();
    const all = className
        .split(/\s+/)
        .filter((c) => /^focus(?:-visible)?:/.test(c));
    const indicators: string[] = [];
    const unresolvedColors: string[] = [];

    for (const cls of all) {
        const util = cls.replace(/^focus(?:-visible)?:/, '');
        const match = util.match(/^(ring|border|outline|shadow)-(.+)$/);
        if (!match) continue;
        const [, prefix, rest] = match;
        if (rest === 'none' || rest === 'hidden' || rest === '0') continue;

        // Width-only utilities (ring-2, border-2, outline-2) are indicators.
        if (/^\d+$/.test(rest)) {
            indicators.push(cls);
            continue;
        }
        const color = rest.split('/')[0];
        if (tokens.has(color) || BUILTIN_COLORS.test(color) || color.startsWith('[')) {
            indicators.push(cls);
        } else if (prefix !== 'shadow') {
            unresolvedColors.push(cls);
        }
    }
    return { all, indicators, unresolvedColors };
}

describe('AccountPickerDialog search input focus indicator', () => {
    beforeEach(() => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({ json: async () => [] })
        );
    });

    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    function searchInput(): HTMLInputElement {
        render(
            <AccountPickerDialog isOpen onClose={() => {}} onSelect={() => {}} />
        );
        return screen.getByPlaceholderText('Search accounts...') as HTMLInputElement;
    }

    it('suppresses the native ring only alongside a visible replacement', () => {
        const input = searchInput();
        const { all, indicators } = analyseFocusClasses(input.className);

        const suppresses = all.some((c) => /outline-(none|hidden)$/.test(c));
        expect(
            suppresses ? indicators.length : 1,
            `focus classes on the input: ${all.join(' ') || '(none)'}`
        ).toBeGreaterThan(0);
    });

    it('names only colour tokens that exist in globals.css', () => {
        const input = searchInput();
        const { unresolvedColors } = analyseFocusClasses(input.className);

        expect(
            unresolvedColors,
            'these focus classes reference a colour with no --color-* token, so they render nothing'
        ).toEqual([]);
    });

    it('uses the theme primary as the focus colour', () => {
        const input = searchInput();
        expect(themeColorTokens().has('primary')).toBe(true);
        expect(input.className).toMatch(/focus(?:-visible)?:ring-primary\b/);
    });
});

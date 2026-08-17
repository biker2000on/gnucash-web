/**
 * Unread-count badge legibility (WCAG 1.4.3).
 *
 * The badge paints itself `bg-error text-error-foreground`. `--error-foreground`
 * was never defined, so `text-error-foreground` resolved to nothing and the
 * count inherited `text-foreground-secondary` from the bell button — roughly
 * 1.57:1 on the error red in light mode and 1.08:1 in dark, i.e. invisible in
 * the app's default theme.
 *
 * These tests do not settle for "the class string is present". They parse the
 * theme out of globals.css, resolve each colour utility on the badge through
 * the `@theme` indirection to a literal hex in BOTH themes, and compute the
 * real contrast ratio. A missing token fails at the resolve step; a badly
 * chosen one fails at the ratio step.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { NotificationBell } from '../NotificationBell';

const AA_NORMAL_TEXT = 4.5;

/** The `:root`, `.dark` and `@theme` blocks of globals.css, as var maps. */
function readTheme() {
    const css = readFileSync(resolve(process.cwd(), 'src/app/globals.css'), 'utf8');

    function block(selector: string): Map<string, string> {
        const start = css.indexOf(selector);
        if (start === -1) throw new Error(`globals.css has no ${selector} block`);
        const open = css.indexOf('{', start);
        const end = css.indexOf('\n}', open);
        const body = css.slice(open + 1, end);
        return new Map(
            [...body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map((m) => [
                m[1],
                m[2].trim(),
            ])
        );
    }

    return { root: block(':root'), dark: block('.dark'), theme: block('@theme') };
}

type Theme = 'light' | 'dark';

/**
 * Resolve a Tailwind colour utility's suffix (`error`, `error-foreground`, ...)
 * to a literal hex, following `--color-x: var(--x)` and the `.dark` override.
 * Returns null when any link in the chain is undefined — which is exactly the
 * bug: an undefined token makes the utility render nothing.
 */
function resolveColor(name: string, mode: Theme): string | null {
    const { root, dark, theme } = readTheme();
    const lookup = (v: string): string | undefined =>
        (mode === 'dark' ? dark.get(v) : undefined) ?? root.get(v);

    let value = theme.get(`--color-${name}`);
    for (let hop = 0; value && hop < 5; hop++) {
        const ref = value.match(/^var\((--[a-z0-9-]+)\)$/);
        if (!ref) break;
        value = lookup(ref[1]);
    }
    return value && /^#[0-9a-f]{3,8}$/i.test(value) ? value : null;
}

function relativeLuminance(hex: string): number {
    const h =
        hex.length === 4
            ? hex.slice(1).split('').map((c) => parseInt(c + c, 16))
            : [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const [r, g, b] = h.map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(fg: string, bg: string): number {
    const [a, b] = [relativeLuminance(fg), relativeLuminance(bg)].sort((x, y) => y - x);
    return (a + 0.05) / (b + 0.05);
}

/** The rendered badge's colour utilities, e.g. { text: 'error-foreground' }. */
function badgeColorUtilities(className: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const cls of className.split(/\s+/)) {
        const m = cls.match(/^(text|bg|border)-([a-z][a-z0-9-]*)$/);
        if (m) out[m[1]] = m[2];
    }
    return out;
}

describe('NotificationBell unread badge', () => {
    beforeEach(() => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({ notifications: [], unreadCount: 3 }),
            })
        );
        vi.stubGlobal(
            'EventSource',
            class {
                addEventListener() {}
                close() {}
            }
        );
    });

    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    async function badge(): Promise<HTMLElement> {
        render(<NotificationBell />);
        return screen.findByText('3');
    }

    it('names only colour tokens that resolve to a real value in both themes', async () => {
        const utilities = badgeColorUtilities((await badge()).className);
        const unresolved: string[] = [];

        for (const [prefix, name] of Object.entries(utilities)) {
            for (const mode of ['light', 'dark'] as const) {
                if (resolveColor(name, mode) === null) {
                    unresolved.push(`${prefix}-${name} (${mode})`);
                }
            }
        }

        expect(
            unresolved,
            'these utilities name a --color-* token with no defined value, so they render nothing'
        ).toEqual([]);
    });

    it.each(['light', 'dark'] as const)(
        'meets WCAG AA contrast on the error background in %s mode',
        async (mode) => {
            const { text, bg } = badgeColorUtilities((await badge()).className);
            expect(text, 'badge must set its own text colour').toBeTruthy();
            expect(bg, 'badge must set its own background colour').toBeTruthy();

            const fgHex = resolveColor(text, mode);
            const bgHex = resolveColor(bg, mode);
            expect(fgHex, `text-${text} is undefined in ${mode} mode`).not.toBeNull();
            expect(bgHex, `bg-${bg} is undefined in ${mode} mode`).not.toBeNull();

            const ratio = contrastRatio(fgHex!, bgHex!);
            expect(
                Number(ratio.toFixed(2)),
                `${fgHex} on ${bgHex} in ${mode} mode`
            ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
        }
    );
});

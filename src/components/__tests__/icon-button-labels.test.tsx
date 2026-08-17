/**
 * Accessible names for icon-only controls (WCAG 4.1.2).
 *
 * DESIGN.md bans `title=` as a carrier of meaning: no mobile support, no
 * styling, no discoverability. `title` is only the LAST resort in the accname
 * algorithm, and one that never reaches a touch user and is mapped
 * inconsistently across AT. Where a control's only label was a `title` tooltip
 * — an SVG-only button, or a sidebar button whose text is hidden when
 * collapsed — that fallback was the whole accessible name. Those controls now
 * carry an explicit `aria-label`.
 *
 * This sweep is deliberately narrow. It does not police decorative or
 * duplicative titles (a tooltip beside a visible label is redundant, not
 * broken); it fails only when an interactive native element has a `title` and
 * no name from any other source.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import ExpandableChart from '../charts/ExpandableChart';

const COMPONENTS = resolve(process.cwd(), 'src/components');

/**
 * Owned by other work in flight; excluded so this suite reports our own
 * regressions rather than someone else's file.
 */
const NOT_OURS = ['src/components/TransactionForm.tsx'];

/**
 * A clickable table row, not a control. Its cells carry the row's text, so the
 * `title` is advisory ("Click to edit") rather than the row's only name.
 */
const ADVISORY = ['src/components/business/time/TimeEntryList.tsx'];

function tsxFiles(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) {
            if (name !== '__tests__') tsxFiles(p, out);
        } else if (name.endsWith('.tsx')) out.push(p);
    }
    return out;
}

/** Slice a JSX opening tag off at its matching `>`, honouring {} and quotes. */
function readTag(src: string, start: number): { tag: string; end: number } | null {
    let depth = 0;
    let quote: string | null = null;
    for (let i = start; i < src.length; i++) {
        const c = src[i];
        if (quote) {
            if (c === quote) quote = null;
            continue;
        }
        if (c === '"' || c === "'" || c === '`') quote = c;
        else if (c === '{') depth++;
        else if (c === '}') depth--;
        else if (c === '>' && depth === 0) return { tag: src.slice(start, i + 1), end: i + 1 };
    }
    return null;
}

/** Interactive native elements whose only possible name is a `title`. */
function unnamedTitleControls(): string[] {
    const offenders: string[] = [];
    for (const file of tsxFiles(COMPONENTS)) {
        const rel = relative(process.cwd(), file).replace(/\\/g, '/');
        if (NOT_OURS.includes(rel) || ADVISORY.includes(rel)) continue;
        const src = readFileSync(file, 'utf8');

        for (let i = 0; i < src.length; i++) {
            if (src[i] !== '<') continue;
            const open = /^<([a-z][\w-]*)[\s/>]/.exec(src.slice(i, i + 40));
            if (!open) continue;
            const read = readTag(src, i);
            if (!read) continue;
            const { tag, end } = read;
            if (!/\btitle\s*=/.test(tag)) continue;
            if (/aria-label|aria-labelledby/.test(tag)) continue;
            if (!/^(?:button|a)$/.test(open[1]) && !/onClick=/.test(tag)) continue;

            const rest = src.slice(end, end + 2000);
            const close = rest.indexOf(`</${open[1]}>`);
            if (close === -1) continue;
            // Anything left once the icon graphic is removed could name it.
            const text = rest
                .slice(0, close)
                .replace(/<svg[^]*?<\/svg>/g, ' ')
                .replace(/\{\s*\/\*[^]*?\*\/\s*\}/g, ' ')
                .replace(/<[^>]*>/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();
            if (text === '' || /^\{[^a-zA-Z]*\}$/.test(text)) {
                offenders.push(`${rel}:${src.slice(0, i).split('\n').length} <${open[1]}>`);
            }
        }
    }
    return offenders;
}

describe('icon-only controls carry an accessible name', () => {
    it('leaves no interactive element named only by its title tooltip', () => {
        expect(
            unnamedTitleControls(),
            'a screen reader announces these as an unnamed "button"; give each an aria-label'
        ).toEqual([]);
    });
});

describe('ExpandableChart expand button', () => {
    afterEach(cleanup);

    it('is named explicitly, not by the title fallback', () => {
        render(
            <ExpandableChart title="Net worth">
                <p>chart</p>
            </ExpandableChart>
        );
        expect(screen.getByRole('button', { name: 'Expand chart' })).toHaveAttribute(
            'aria-label',
            'Expand chart'
        );
    });
});

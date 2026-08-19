/**
 * Tripwire: native `title=` is banned as a hint mechanism (DESIGN.md,
 * "Abbreviations" — "Native `title=` attributes are banned for this purpose
 * (no mobile support, no styling, no discoverability)").
 *
 * It is also worse than it looks: `title` never appears on touch, cannot be
 * opened or dismissed from the keyboard, cannot be styled, waits about a
 * second before appearing, and is exposed to screen readers inconsistently and
 * only when the user has opted in. Any hint worth writing therefore goes
 * through `Tip` (src/components/ui/Tooltip.tsx), and any hint that is really a
 * control's NAME goes through `aria-label`.
 *
 * This test parses every .tsx file with the TypeScript compiler rather than
 * grepping, because `title` is a legitimate PROP on plenty of components
 * (`<StatCard title=…>`, `<PageHeader title=…>`, `<Modal title=…>`) and a
 * regex cannot tell those from a host element's attribute. Only lowercase JSX
 * tags — real DOM elements — are checked.
 */
import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

/**
 * Tags where `title` is the platform's own mechanism, not a hover hint:
 * `<abbr title>` is the HTML expansion for an abbreviation (and `<Abbr>` is
 * built on it), `<iframe title>` is a required accessible name, and inside SVG
 * `<title>` is an element, not an attribute.
 */
const ALLOWED_TAGS = new Set(['abbr', 'iframe', 'svg', 'title', 'g', 'path', 'symbol', 'marker', 'area', 'link']);

/**
 * Known, reviewed exceptions. This list must not grow: a new entry means a new
 * inaccessible hint. Fix the site with `Tip` or `aria-label` instead.
 */
const ALLOWLIST: ReadonlySet<string> = new Set<string>([]);

const repoRoot = resolve(__dirname, '../..');

function tsxFiles(): string[] {
    return execSync('git ls-files src', { cwd: repoRoot, encoding: 'utf8' })
        .trim()
        .split('\n')
        .filter(f => f.endsWith('.tsx'));
}

function findNativeTitles(file: string): string[] {
    const src = readFileSync(resolve(repoRoot, file), 'utf8');
    if (!/\btitle\s*=/.test(src)) return [];
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const found: string[] = [];

    const visit = (node: ts.Node): void => {
        if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
            const tag = node.tagName.getText(sf);
            if (/^[a-z]/.test(tag) && !ALLOWED_TAGS.has(tag)) {
                for (const attr of node.attributes.properties) {
                    if (ts.isJsxAttribute(attr) && attr.name.getText(sf) === 'title') {
                        const { line } = sf.getLineAndCharacterOfPosition(attr.getStart(sf));
                        found.push(`${file}:${line + 1} <${tag} title=…>`);
                    }
                }
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);
    return found;
}

describe('native title= tooltips', () => {
    it('are not used on any DOM element', () => {
        const offenders = tsxFiles()
            .flatMap(findNativeTitles)
            .filter(entry => !ALLOWLIST.has(entry));

        expect(
            offenders,
            `Native title= is banned (DESIGN.md). Use <Tip content={…}> from ` +
                `@/components/ui/Tooltip for an explanatory hint, or aria-label when the ` +
                `text is the control's name:\n${offenders.join('\n')}`,
        ).toEqual([]);
        // Parsing ~700 .tsx files comfortably beats the 5s default on its own,
        // but not while the rest of the suite is saturating the worker pool.
    }, 60_000);

    it('detects a violation when one is introduced', () => {
        // Guards the guard: a parser bug that silently found nothing would
        // otherwise let the suite pass forever.
        const sf = ts.createSourceFile(
            'sample.tsx',
            'const a = <div title="hint">x</div>;\nconst b = <StatCard title="fine" />;\nconst c = <abbr title="ok">x</abbr>;',
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.TSX,
        );
        const hits: string[] = [];
        const visit = (node: ts.Node): void => {
            if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
                const tag = node.tagName.getText(sf);
                if (/^[a-z]/.test(tag) && !ALLOWED_TAGS.has(tag)) {
                    for (const attr of node.attributes.properties) {
                        if (ts.isJsxAttribute(attr) && attr.name.getText(sf) === 'title') hits.push(tag);
                    }
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(sf);
        // The <div> is caught; the component prop and the <abbr> are not.
        expect(hits).toEqual(['div']);
    });
});

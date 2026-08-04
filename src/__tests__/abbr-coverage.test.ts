/**
 * Lint-style sweep (DESIGN.md "Abbreviations"): known glossary abbreviations
 * rendered as bare JSX text in user-facing surfaces must go through
 * `<Abbr term="..." />` (src/components/ui/Abbr.tsx).
 *
 * A file::term pair is only flagged when the file does NOT already contain an
 * `<Abbr term="...">` for that term — the coverage rule is first occurrence per
 * view; repeats after a covered first occurrence are intentionally plain.
 *
 * ALLOWLIST is for genuine false positives only (each entry needs a comment
 * explaining why it is not a user-facing abbreviation). Every pre-glossary
 * surface has been retrofitted; do NOT add entries for new code — add `<Abbr>`
 * at the first occurrence instead.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GLOSSARY } from '@/lib/glossary';

const ROOT = process.cwd();
const SCAN_DIRS = ['src/components', 'src/app/(main)'];

/**
 * Glossary terms distinctive enough to sweep for as bare JSX text without
 * drowning in false positives (short/ambiguous ones like ES, SE, ST, LT, AR,
 * AP, FX, G/L are enforced by review instead).
 */
const SWEEP_TERMS = [
    'QBI', 'MAGI', 'NIIT', 'SALT', 'LTCG', 'STCG', 'OASDI', 'FICA', 'COGS',
    'OBBBA', 'DRIP', 'RMD', '1040-ES', 'TXF', '990-N', 'FIFO', 'LIFO', 'SWR',
    'PUV', 'QDI', '8949', 'HSA', 'AGI', 'YTD', 'KPI', 'FIRE', 'IRMAA',
];

/** Genuine false positives only (file::term) — comment each entry. */
const ALLOWLIST = new Set<string>([]);

function* walkTsx(dir: string): Generator<string> {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
            yield* walkTsx(p);
        } else if (entry.name.endsWith('.tsx')) {
            yield p;
        }
    }
}

function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
}

/** Extract approximate JSX text segments (line number + text) from a source file. */
function jsxTextSegments(content: string): Array<[number, string]> {
    // Anything already inside an <Abbr> element is covered.
    const stripped = content.replace(/<Abbr\b[^>]*(?:\/>|>[\s\S]*?<\/Abbr>)/g, ' ');
    const segments: Array<[number, string]> = [];
    const lines = stripped.split(/\r?\n/);
    let prevEndsOpen = false;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        if (/^(\/\/|\/\*|\*)/.test(trimmed)) {
            prevEndsOpen = false;
            continue;
        }
        const re = />([^<>{}]*)</g;
        let m: RegExpExecArray | null;
        let hadTagText = false;
        while ((m = re.exec(line)) !== null) {
            segments.push([i + 1, m[1]]);
            hadTagText = true;
        }
        const lastGt = line.lastIndexOf('>');
        const lastLt = line.lastIndexOf('<');
        if (lastGt > lastLt && !/=>\s*$/.test(trimmed)) {
            const tail = line.slice(lastGt + 1);
            if (!/[{}=;]/.test(tail)) segments.push([i + 1, tail]);
            prevEndsOpen = true;
        } else if (!hadTagText && prevEndsOpen && !/[<>{}=;`]/.test(line) && /[A-Za-z]/.test(line)) {
            // Continuation prose line inside a multi-line JSX text block.
            segments.push([i + 1, line]);
        } else {
            prevEndsOpen = false;
        }
    }
    return segments;
}

function findBareTerms(): Map<string, number> {
    const hits = new Map<string, number>();
    const termRes = new Map(
        SWEEP_TERMS.map(t => [t, new RegExp(`(?<![\\w§-])${escapeRe(t)}(?![\\w-])`)] as const),
    );
    for (const dir of SCAN_DIRS) {
        for (const file of walkTsx(join(ROOT, dir))) {
            const rel = relative(ROOT, file).replace(/\\/g, '/');
            const content = readFileSync(file, 'utf8');
            const covered = new Set(
                SWEEP_TERMS.filter(t => content.includes(`<Abbr term="${t}"`)),
            );
            for (const [lineNo, seg] of jsxTextSegments(content)) {
                for (const term of SWEEP_TERMS) {
                    if (covered.has(term)) continue;
                    const key = `${rel}::${term}`;
                    if (hits.has(key)) continue;
                    if (termRes.get(term)!.test(seg)) hits.set(key, lineNo);
                }
            }
        }
    }
    return hits;
}

describe('abbreviation coverage sweep', () => {
    it('sweep terms all exist in the glossary', () => {
        for (const term of SWEEP_TERMS) {
            expect(GLOSSARY[term], `sweep term ${term} missing from glossary`).toBeDefined();
        }
    });

    it('no NEW bare glossary abbreviations in user-facing JSX (use <Abbr>)', () => {
        const hits = findBareTerms();
        const violations = [...hits.entries()]
            .filter(([key]) => !ALLOWLIST.has(key))
            .map(([key, line]) => `${key} (line ${line})`)
            .sort();
        expect(
            violations,
            'Bare abbreviation(s) found. Render the first occurrence in the view with ' +
                '<Abbr term="..."> from @/components/ui/Abbr (see DESIGN.md "Abbreviations"). ' +
                'Do not add new entries to the allowlist.',
        ).toEqual([]);
    });

    it('allowlist has no stale entries (retrofitted files should be removed)', () => {
        const hits = findBareTerms();
        const stale = [...ALLOWLIST].filter(key => !hits.has(key)).sort();
        expect(
            stale,
            'These allowlist entries no longer match a bare occurrence — remove them.',
        ).toEqual([]);
    });
});

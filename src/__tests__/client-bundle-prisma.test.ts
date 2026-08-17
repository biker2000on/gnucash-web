/**
 * Build guard: no Client Component may transitively reach a Node-only database
 * module.
 *
 * `next build` resolves the import graph of every `'use client'` module for the
 * browser. If that graph reaches `@/lib/prisma` or `@/lib/db`, Turbopack tries
 * to bundle the `pg` driver and fails with module-not-found on `tls`/`net`/
 * `dns`/`fs`. This has now shipped to main TWICE (holdings coverage via
 * `@/lib/commodities`, then the 1099 tracker via `@/lib/reports/irs-limits`)
 * because typecheck, lint and vitest all pass while the app does not build.
 *
 * This test reproduces the bundler's reachability question statically, so the
 * regression is caught by `vitest run` instead of by a failed deploy.
 *
 * WHY IT MATCHES THE BUNDLER: it walks the same edges SWC emits. `import type`
 * and inline `{ type X }` are erased; and because this repo has
 * `verbatimModuleSyntax` off, an import whose every named binding resolves to a
 * type-only export in the target is elided too. Unresolvable names are treated
 * as VALUES, so the guard errs toward reporting an edge rather than dropping
 * one. Validated against a known-bad tree: at 27888c0 it reported exactly the
 * one chain `next build` reported, and nothing else, across 434 entrypoints.
 *
 * FIXING A FAILURE: split the module. Put the pure, dependency-free half in a
 * leaf module the client may import and keep the DB half in a server-only
 * sibling that re-exports it (see `@/lib/reports/irs-limit-tables` next to
 * `@/lib/reports/irs-limits`, or `@/lib/holdings-coverage` next to
 * `@/lib/commodities`). Do NOT add an ALLOWLIST entry to silence it.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SRC = path.join(ROOT, 'src');
const EXTS = ['.ts', '.tsx', '.js', '.jsx'];

/** Node-only modules that must never enter a browser bundle. */
const SENTINELS = ['src/lib/prisma.ts', 'src/lib/db.ts'].map(p => path.join(ROOT, p));

/**
 * Per-SITE exceptions. Each entry is ONE import edge, not a whole file or
 * module, and needs a justification explaining why the bundler does not
 * actually follow it. An entry whose edge no longer exists fails as stale, so
 * this list cannot rot into a blanket mute.
 *
 * Empty by design: every known case is fixable by splitting the module.
 */
const ALLOWLIST: { from: string; to: string; why: string }[] = [];

function walk(dir: string, out: string[] = []): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (e.name === 'node_modules' || e.name === '__tests__') continue;
            walk(p, out);
        } else if (EXTS.includes(path.extname(e.name)) && !/\.(test|spec)\.[jt]sx?$/.test(e.name)) {
            out.push(p);
        }
    }
    return out;
}

function resolveSpec(spec: string, fromFile: string): string | null {
    let base: string;
    if (spec.startsWith('@/')) base = path.join(SRC, spec.slice(2));
    else if (spec.startsWith('.')) base = path.resolve(path.dirname(fromFile), spec);
    else return null; // bare package specifier — not part of the first-party graph
    for (const ext of EXTS) if (fs.existsSync(base + ext)) return base + ext;
    for (const ext of EXTS) {
        const idx = path.join(base, 'index' + ext);
        if (fs.existsSync(idx)) return idx;
    }
    if (fs.existsSync(base) && fs.statSync(base).isFile()) return base;
    return null;
}

const STATIC_RE = /(?:^|\n)\s*import\s+([^'"]*?)from\s*['"]([^'"]+)['"]/g;
const SIDE_EFFECT_RE = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
const REEXPORT_RE = /(?:^|\n)\s*export\s+(\*|\{[^}]*\})\s*from\s*['"]([^'"]+)['"]/g;
const DYNAMIC_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

const readCache = new Map<string, string>();
function read(file: string): string {
    let s = readCache.get(file);
    if (s === undefined) { s = fs.readFileSync(file, 'utf8'); readCache.set(file, s); }
    return s;
}

const typeExportCache = new Map<string, Set<string>>();
function typeExportsOf(file: string): Set<string> {
    let names = typeExportCache.get(file);
    if (names) return names;
    names = new Set<string>();
    const src = read(file);
    for (const m of src.matchAll(/export\s+(?:declare\s+)?(?:interface|type)\s+([A-Za-z0-9_$]+)/g)) {
        names.add(m[1]);
    }
    for (const m of src.matchAll(/export\s+type\s*\{([^}]*)\}/g)) {
        for (const part of m[1].split(',')) {
            const n = part.trim().split(/\s+as\s+/).pop()?.trim();
            if (n) names.add(n);
        }
    }
    typeExportCache.set(file, names);
    return names;
}

/** True when the whole import statement is erased before bundling. */
function isElided(clause: string, targetFile: string): boolean {
    const c = clause.trim();
    if (/^type\s/.test(c)) return true;
    const braced = c.match(/^\{([\s\S]*)\}$/);
    if (!braced) return false; // default / namespace import — always a value edge
    const specs = braced[1].split(',').map(s => s.trim()).filter(Boolean);
    if (specs.length === 0) return false;
    const types = typeExportsOf(targetFile);
    return specs.every(s => {
        if (/^type\s/.test(s)) return true;
        const local = s.split(/\s+as\s+/)[0].trim();
        return types.has(local); // unknown name => value => edge kept (conservative)
    });
}

const edgeCache = new Map<string, string[]>();
function edgesOf(file: string): string[] {
    let out = edgeCache.get(file);
    if (out) return out;
    const src = read(file);
    out = [];
    const add = (spec: string, clause: string | null) => {
        const target = resolveSpec(spec, file);
        if (!target) return;
        if (clause !== null && isElided(clause, target)) return;
        if (ALLOWLIST.some(a => path.join(ROOT, a.from) === file && a.to === spec)) return;
        out!.push(target);
    };
    for (const m of src.matchAll(STATIC_RE)) add(m[2], m[1]);
    for (const m of src.matchAll(SIDE_EFFECT_RE)) add(m[1], null);
    for (const m of src.matchAll(REEXPORT_RE)) add(m[2], m[1] === '*' ? null : m[1]);
    for (const m of src.matchAll(DYNAMIC_RE)) add(m[1], null);
    edgeCache.set(file, out);
    return out;
}

const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join('/');

/** Shortest import chain from `entry` to any sentinel, or null. */
function chainToSentinel(entry: string): string[] | null {
    const parent = new Map<string, string | null>([[entry, null]]);
    const queue = [entry];
    for (let i = 0; i < queue.length; i++) {
        const cur = queue[i];
        if (SENTINELS.includes(cur) && cur !== entry) {
            const chain: string[] = [];
            for (let c: string | null = cur; c; c = parent.get(c) ?? null) chain.push(rel(c));
            return chain.reverse();
        }
        for (const next of edgesOf(cur)) {
            if (!parent.has(next)) { parent.set(next, cur); queue.push(next); }
        }
    }
    return null;
}

const ALL_FILES = walk(SRC);
const CLIENT_ENTRIES = ALL_FILES.filter(f => /^\s*['"]use client['"]/m.test(read(f).slice(0, 400)));

describe('client bundle must not reach a Node-only database module', () => {
    // --- Anti-vacuity: prove the machinery works before trusting a pass. ---

    it('resolves the sentinel modules', () => {
        for (const s of SENTINELS) expect(fs.existsSync(s), `${rel(s)} missing`).toBe(true);
        expect(resolveSpec('@/lib/prisma', path.join(SRC, 'lib/x.ts'))).toBe(SENTINELS[0]);
        expect(resolveSpec('./irs-limit-tables', path.join(SRC, 'lib/reports/irs-limits.ts')))
            .toBe(path.join(SRC, 'lib/reports/irs-limit-tables.ts'));
    });

    it('discovers a realistic number of client entrypoints', () => {
        // If a refactor breaks discovery this fails loudly instead of passing
        // vacuously with zero entrypoints to check.
        expect(CLIENT_ENTRIES.length).toBeGreaterThan(100);
    });

    it('DOES detect reachability on a module that legitimately uses prisma', () => {
        // Positive control: if this stops finding a chain, the traversal is
        // broken and every negative result below is meaningless.
        const serverModule = path.join(SRC, 'lib/reports/irs-limits.ts');
        expect(chainToSentinel(serverModule)).not.toBeNull();
    });

    it('keeps the pure IRS tables module free of the database', () => {
        expect(chainToSentinel(path.join(SRC, 'lib/reports/irs-limit-tables.ts'))).toBeNull();
    });

    // --- The guard itself. ---

    it('has no client entrypoint that transitively imports prisma or db', () => {
        const violations = CLIENT_ENTRIES
            .map(e => chainToSentinel(e))
            .filter((c): c is string[] => c !== null)
            .map(c => c.join('\n      -> '));

        expect(
            violations,
            violations.length
                ? `Client Components reach a Node-only DB module — 'next build' WILL fail:\n\n    ` +
                  violations.join('\n\n    ') +
                  '\n\nSplit the module (pure leaf + server-only sibling that re-exports it).'
                : '',
        ).toStrictEqual([]);
    });

    // --- Allowlist hygiene. ---

    it('has no stale ALLOWLIST entries', () => {
        const stale = ALLOWLIST.filter(a => {
            const file = path.join(ROOT, a.from);
            if (!fs.existsSync(file)) return true;
            return !read(file).includes(a.to);
        }).map(a => `${a.from} -> ${a.to}`);
        expect(stale, `Stale client-bundle ALLOWLIST entries (edge no longer exists): ${stale.join(', ')}`)
            .toStrictEqual([]);
    });

    it('requires a justification on every ALLOWLIST entry', () => {
        for (const a of ALLOWLIST) {
            expect(a.why?.trim().length ?? 0, `${a.from} -> ${a.to} needs a justification`)
                .toBeGreaterThan(20);
        }
    });

    it('stale-entry detection actually fires', () => {
        // Self-test so the hygiene rule is load-bearing while ALLOWLIST is empty.
        const fake = [
            { from: 'src/lib/prisma.ts', to: '@/does/not/exist', why: 'synthetic' },
            { from: 'src/no/such/file.ts', to: '@/lib/prisma', why: 'synthetic' },
        ];
        const stale = fake.filter(a => {
            const file = path.join(ROOT, a.from);
            if (!fs.existsSync(file)) return true;
            return !read(file).includes(a.to);
        });
        expect(stale).toHaveLength(2);
    });
});

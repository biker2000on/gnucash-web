/**
 * Guard: every <Modal> body is padded.
 *
 * The shared Modal (src/components/ui/Modal.tsx) deliberately adds no padding
 * to its content area — each dialog pads its own body (`p-6`, `p-4`, or
 * `px-6 py-4`). Several business dialogs forgot, so their fields ran flush to
 * the dialog edges (reported 2026-10-01 on the voucher "Reimburse" dialog).
 * This scans every .tsx file for a <Modal …> whose first child element
 * carries no padding class.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Dialogs that pad inner regions instead of the body (file::line of <Modal). Comment each. */
const ALLOWLIST = new Set<string>([
    // Tab bar and panes carry their own px-4 / p-4; the body is a full-height flex column.
    'src/components/receipts/ReceiptModal.tsx',
]);

function* walk(dir: string): Generator<string> {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
            yield* walk(p);
        } else if (entry.name.endsWith('.tsx')) {
            yield p;
        }
    }
}

const PADDED = /(^|\s)p[xytrbl]?-\d/;

export function unpaddedModals(source: string): number[] {
    const lines: number[] = [];
    for (const m of source.matchAll(/<Modal\b/g)) {
        const rest = source.slice(m.index! + 6, m.index! + 3000);
        // Close of the opening tag: a '>' (not part of '=>') followed by the child.
        const end = /(?<![=-])>\s*(?=\{|<)/.exec(rest);
        if (!end) continue;
        const child = /^\s*(?:\{[^\n]*\n\s*)?<(form|div|section)\b((?:=>|[^>])*?)>/.exec(rest.slice(end.index + 1));
        if (!child) continue;
        const cls = /className=(?:"([^"]*)"|\{`([^`]*)`\})/.exec(child[2]);
        const classes = cls ? cls[1] ?? cls[2] ?? '' : '';
        if (!PADDED.test(classes)) lines.push(source.slice(0, m.index).split('\n').length);
    }
    return lines;
}

describe('modal bodies are padded', () => {
    it('detects an unpadded body and accepts padded ones', () => {
        expect(unpaddedModals('<Modal isOpen={o} onClose={() => x()}>\n  <form className="space-y-4">')).toEqual([1]);
        expect(unpaddedModals('<Modal isOpen={o}>\n  <form className="space-y-4 p-6">')).toEqual([]);
        expect(unpaddedModals('<Modal\n  isOpen={o}\n>\n  <form\n    onSubmit={(e) => go(e)}\n    className="p-6 space-y-4"\n  >')).toEqual([]);
    });

    it('every <Modal> in the app pads its body', () => {
        const root = process.cwd();
        const offenders: string[] = [];
        for (const file of walk(join(root, 'src'))) {
            const rel = relative(root, file).replace(/\\/g, '/');
            if (ALLOWLIST.has(rel)) continue;
            for (const line of unpaddedModals(readFileSync(file, 'utf8'))) offenders.push(`${rel}:${line}`);
        }
        expect(offenders, 'Pad the dialog body (e.g. className="space-y-4 p-6")').toEqual([]);
    });
});

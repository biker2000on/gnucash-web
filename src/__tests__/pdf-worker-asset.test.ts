import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * public/pdf.min.mjs and public/pdf.worker.min.mjs are COMMITTED copies of the
 * installed pdfjs-dist build: the vault preview loads them with a native
 * browser import because webpack cannot evaluate pdfjs-dist's ESM builds (see
 * src/lib/pdfjs-client.ts). A pdfjs-dist version bump without refreshing the
 * copies would pair a new API with old files — pdf.js hard-fails on that
 * mismatch at runtime, so catch it here:
 *
 *   cp node_modules/pdfjs-dist/build/pdf.min.mjs public/pdf.min.mjs
 *   cp node_modules/pdfjs-dist/build/pdf.worker.min.mjs public/pdf.worker.min.mjs
 */
describe('vendored pdf.js assets', () => {
    const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

    it.each(['pdf.min.mjs', 'pdf.worker.min.mjs'])('%s matches the installed pdfjs-dist build', (file) => {
        expect(sha(resolve('public', file))).toBe(
            sha(resolve('node_modules/pdfjs-dist/build', file)),
        );
    });
});

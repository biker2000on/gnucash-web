import { afterAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TextDecoder, TextEncoder } from 'node:util';

const tempDirectory = mkdtempSync(path.join(tmpdir(), 'gnucash-pdf-extract-'));
const bundledExtractorPath = path.join(tempDirectory, 'pdf-text-extract.cjs');
symlinkSync(
  path.resolve('node_modules'),
  path.join(tempDirectory, 'node_modules'),
  process.platform === 'win32' ? 'junction' : 'dir',
);

afterAll(() => {
  rmSync(tempDirectory, { recursive: true, force: true });
});

function createMinimalPdf(text: string): Buffer {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(pdf);
  pdf += 'xref\n0 6\n0000000000 65535 f \n';
  pdf += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('');
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(pdf);
}

describe('extractTextFromPdf production bundle', () => {
  it('extracts real PDF text repeatedly when PDF.js remains external', async () => {
    const dockerfile = readFileSync(path.resolve('Dockerfile'), 'utf8');
    expect(dockerfile).toContain('--external:pdfjs-dist/*');
    expect(dockerfile).toContain(
      'COPY --from=prod-deps /app/node_modules/pdfjs-dist .next/standalone/node_modules/pdfjs-dist',
    );
    expect(dockerfile).toContain(
      'COPY --from=prod-deps /app/node_modules/@napi-rs .next/standalone/node_modules/@napi-rs',
    );

    // jsdom's typed arrays come from a different realm, which esbuild rejects.
    const originalTextEncoder = globalThis.TextEncoder;
    const originalTextDecoder = globalThis.TextDecoder;
    const originalUint8Array = globalThis.Uint8Array;
    try {
      globalThis.TextEncoder = TextEncoder;
      globalThis.TextDecoder = TextDecoder as typeof globalThis.TextDecoder;
      globalThis.Uint8Array = new TextEncoder().encode('').constructor as Uint8ArrayConstructor;
      const { build } = await import('esbuild');
      await build({
        entryPoints: [path.resolve('src/lib/pdf-text-extract.ts')],
        bundle: true,
        platform: 'node',
        target: 'node24',
        format: 'cjs',
        external: ['pdfjs-dist/*'],
        outfile: bundledExtractorPath,
        logLevel: 'silent',
      });

      const require = createRequire(import.meta.url);
      const { extractTextFromPdf } = require(bundledExtractorPath) as {
        extractTextFromPdf(buffer: Buffer): Promise<string>;
      };
      const pdf = createMinimalPdf('Bundled worker PDF text');

      await expect(extractTextFromPdf(pdf)).resolves.toBe('Bundled worker PDF text');
      await expect(extractTextFromPdf(pdf)).resolves.toBe('Bundled worker PDF text');
      await expect(extractTextFromPdf(pdf)).resolves.toBe('Bundled worker PDF text');
    } finally {
      globalThis.TextEncoder = originalTextEncoder;
      globalThis.TextDecoder = originalTextDecoder;
      globalThis.Uint8Array = originalUint8Array;
    }
  });
});

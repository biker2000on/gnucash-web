import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

interface BundledExtractor {
  extractTextFromPdf(buffer: Buffer): Promise<string>;
  extractPdfText(
    buffer: Buffer,
    options?: { ocr?: (buffer: Buffer) => Promise<string> },
  ): Promise<{ text: string; source: string; ocrError: string | null }>;
}

let bundled: BundledExtractor;
const originalTextEncoder = globalThis.TextEncoder;
const originalTextDecoder = globalThis.TextDecoder;
const originalUint8Array = globalThis.Uint8Array;

// Bundling is hoisted out of the tests: spawning the esbuild service is the
// slowest and most load-sensitive step here, and every test reuses one bundle.
beforeAll(async () => {
  // jsdom's typed arrays come from a different realm, which esbuild rejects.
  // The swap stays in place for the whole file — pdf.js runs against them too.
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

  bundled = createRequire(import.meta.url)(bundledExtractorPath) as BundledExtractor;
}, 30_000);

afterAll(() => {
  globalThis.TextEncoder = originalTextEncoder;
  globalThis.TextDecoder = originalTextDecoder;
  globalThis.Uint8Array = originalUint8Array;
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
  // Explicit budget: the first extraction pays for pdf.js's cold load from disk,
  // which is load-sensitive when the full suite runs in parallel. This test
  // timed out against the 5s default on 2026-08-01/02.
  it('extracts real PDF text repeatedly when PDF.js remains external', async () => {
    const dockerfile = readFileSync(path.resolve('Dockerfile'), 'utf8');
    expect(dockerfile).toContain('--external:pdfjs-dist/*');
    expect(dockerfile).toContain(
      'COPY --from=prod-deps /app/node_modules/pdfjs-dist .next/standalone/node_modules/pdfjs-dist',
    );
    expect(dockerfile).toContain(
      'COPY --from=prod-deps /app/node_modules/@napi-rs .next/standalone/node_modules/@napi-rs',
    );

    const pdf = createMinimalPdf('Bundled worker PDF text');

    await expect(bundled.extractTextFromPdf(pdf)).resolves.toBe('Bundled worker PDF text');
    await expect(bundled.extractTextFromPdf(pdf)).resolves.toBe('Bundled worker PDF text');
    await expect(bundled.extractTextFromPdf(pdf)).resolves.toBe('Bundled worker PDF text');
  }, 20_000);
});

describe('extractPdfText OCR fallback', () => {
  // The content stream draws an empty string, so pdf.js finds no usable text —
  // the same shape a scanned, image-only PDF presents to the extractor.
  const scannedPdf = () => createMinimalPdf('');

  it('uses the injected OCR hook when there is no usable text layer', async () => {
    const ocr = async () => '  Scanned invoice total 42.00  ';

    await expect(bundled.extractPdfText(scannedPdf(), { ocr })).resolves.toEqual({
      text: 'Scanned invoice total 42.00',
      source: 'ocr',
      ocrError: null,
    });
  });

  it('never calls OCR when the text layer already has content', async () => {
    let ocrCalls = 0;
    const ocr = async () => { ocrCalls += 1; return 'from ocr'; };

    await expect(
      bundled.extractPdfText(createMinimalPdf('Has a text layer'), { ocr }),
    ).resolves.toMatchObject({ text: 'Has a text layer', source: 'text-layer' });
    expect(ocrCalls).toBe(0);
  });

  it('reports an explicit failure when no OCR hook is available', async () => {
    const result = await bundled.extractPdfText(scannedPdf());
    expect(result).toMatchObject({ text: '', source: 'none' });
    expect(result.ocrError).toContain('no OCR fallback');
  });

  it('reports an explicit failure when OCR throws or finds nothing', async () => {
    const thrown = await bundled.extractPdfText(scannedPdf(), {
      ocr: async () => { throw new Error('tesseract unavailable'); },
    });
    expect(thrown).toMatchObject({ text: '', source: 'none' });
    expect(thrown.ocrError).toContain('tesseract unavailable');

    const empty = await bundled.extractPdfText(scannedPdf(), { ocr: async () => '   ' });
    expect(empty).toMatchObject({ text: '', source: 'none' });
    expect(empty.ocrError).toContain('OCR produced no text');
  });
});

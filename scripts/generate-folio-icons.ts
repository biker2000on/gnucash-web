import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import sharp from 'sharp';

const ROOT = process.cwd();
const BACKGROUND = '#0c1322';
const REAR_TILE = '#176f78';
const FRONT_TILE = '#2dd4bf';

type MarkVariant = 'micro' | 'stack';

interface SvgOptions {
  renderedSize: number;
  variant: MarkVariant;
  geometryInset: number;
}

function renderMarkSvg({ renderedSize, variant, geometryInset }: SvgOptions): string {
  const geometrySize = 512 - geometryInset * 2;
  const scale = geometrySize / 64;
  const transform = `translate(${geometryInset} ${geometryInset}) scale(${scale})`;
  const geometry =
    variant === 'micro'
      ? `<g transform="${transform}">
  <rect x="12" y="8" width="40" height="48" rx="4" fill="${FRONT_TILE}"/>
  <path d="M22 18h24v8H30v8h13v8H30v12h-8z" fill="${BACKGROUND}"/>
</g>`
      : `<g transform="${transform}">
  <rect x="10" y="8" width="38" height="44" rx="4" fill="${REAR_TILE}"/>
  <rect x="16" y="12" width="38" height="44" rx="4" fill="${FRONT_TILE}"/>
  <path d="M26 22h22v7H33v7h12v7H33v11h-7z" fill="${BACKGROUND}"/>
</g>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${renderedSize}" height="${renderedSize}" viewBox="0 0 512 512">
<rect width="512" height="512" fill="${BACKGROUND}"/>
${geometry}
</svg>
`;
}

async function renderPng(options: SvgOptions): Promise<Buffer> {
  return sharp(Buffer.from(renderMarkSvg(options)))
    .flatten({ background: BACKGROUND })
    .png({ compressionLevel: 9, palette: false })
    .toBuffer();
}

function packIco(microPng: Buffer, stackPng: Buffer): Buffer {
  const directorySize = 6 + 16 * 2;
  const ico = Buffer.alloc(directorySize + microPng.length + stackPng.length);

  ico.writeUInt16LE(0, 0);
  ico.writeUInt16LE(1, 2);
  ico.writeUInt16LE(2, 4);

  const writeEntry = (
    entryOffset: number,
    dimension: number,
    png: Buffer,
    payloadOffset: number,
  ) => {
    ico.writeUInt8(dimension, entryOffset);
    ico.writeUInt8(dimension, entryOffset + 1);
    ico.writeUInt8(0, entryOffset + 2);
    ico.writeUInt8(0, entryOffset + 3);
    ico.writeUInt16LE(1, entryOffset + 4);
    ico.writeUInt16LE(32, entryOffset + 6);
    ico.writeUInt32LE(png.length, entryOffset + 8);
    ico.writeUInt32LE(payloadOffset, entryOffset + 12);
  };

  writeEntry(6, 16, microPng, directorySize);
  writeEntry(22, 32, stackPng, directorySize + microPng.length);
  microPng.copy(ico, directorySize);
  stackPng.copy(ico, directorySize + microPng.length);

  return ico;
}

async function writeAsset(relativePath: string, contents: Buffer | string): Promise<void> {
  const outputPath = join(ROOT, relativePath);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, contents);
}

async function main(): Promise<void> {
  const [stack192, stack512, maskable512, apple180, micro16, stack32] =
    await Promise.all([
      renderPng({ renderedSize: 192, variant: 'stack', geometryInset: 64 }),
      renderPng({ renderedSize: 512, variant: 'stack', geometryInset: 64 }),
      renderPng({ renderedSize: 512, variant: 'stack', geometryInset: 104 }),
      renderPng({ renderedSize: 180, variant: 'stack', geometryInset: 72 }),
      renderPng({ renderedSize: 16, variant: 'micro', geometryInset: 32 }),
      renderPng({ renderedSize: 32, variant: 'stack', geometryInset: 32 }),
    ]);

  await Promise.all([
    writeAsset('public/icons/folio-stack-192.png', stack192),
    writeAsset('public/icons/folio-stack-512.png', stack512),
    writeAsset('public/icons/folio-stack-maskable-512.png', maskable512),
    writeAsset('public/icons/folio-apple-touch-icon-180.png', apple180),
    writeAsset(
      'public/favicon.svg',
      renderMarkSvg({ renderedSize: 64, variant: 'stack', geometryInset: 32 }),
    ),
    writeAsset('public/favicon.ico', packIco(micro16, stack32)),
  ]);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

import { readFile } from 'node:fs/promises';

import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

const BACKGROUND = { r: 12, g: 19, b: 34 };
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

describe('Folio raster assets', () => {
  it.each([
    ['public/icons/folio-stack-192.png', 192, 192],
    ['public/icons/folio-stack-512.png', 512, 512],
    ['public/icons/folio-stack-maskable-512.png', 512, 512],
    ['public/icons/folio-apple-touch-icon-180.png', 180, 180],
  ] as const)('%s is an opaque %ix%i PNG', async (file, width, height) => {
    await expect(sharp(file).metadata()).resolves.toMatchObject({
      width,
      height,
      format: 'png',
      hasAlpha: false,
    });
  });

  it('keeps all maskable mark geometry inside the central 60 percent', async () => {
    const { data, info } = await sharp('public/icons/folio-stack-maskable-512.png')
      .raw()
      .toBuffer({ resolveWithObject: true });
    const changedPixels: Array<[number, number]> = [];

    for (let y = 0; y < info.height; y += 1) {
      for (let x = 0; x < info.width; x += 1) {
        const offset = (y * info.width + x) * info.channels;
        if (
          data[offset] !== BACKGROUND.r ||
          data[offset + 1] !== BACKGROUND.g ||
          data[offset + 2] !== BACKGROUND.b
        ) {
          changedPixels.push([x, y]);
        }
      }
    }

    expect(changedPixels.length).toBeGreaterThan(0);
    expect(Math.min(...changedPixels.map(([x]) => x))).toBeGreaterThanOrEqual(102);
    expect(Math.max(...changedPixels.map(([x]) => x))).toBeLessThanOrEqual(410);
    expect(Math.min(...changedPixels.map(([, y]) => y))).toBeGreaterThanOrEqual(102);
    expect(Math.max(...changedPixels.map(([, y]) => y))).toBeLessThanOrEqual(410);
  });
});

describe('Folio favicon ICO', () => {
  it('packs 16px Micro and 32px Stack PNG payloads at deterministic offsets', async () => {
    const ico = await readFile('public/favicon.ico');

    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(2);

    const firstLength = ico.readUInt32LE(14);
    const secondLength = ico.readUInt32LE(30);
    const firstOffset = ico.readUInt32LE(18);
    const secondOffset = ico.readUInt32LE(34);

    expect({
      first: {
        width: ico.readUInt8(6),
        height: ico.readUInt8(7),
        planes: ico.readUInt16LE(10),
        bitCount: ico.readUInt16LE(12),
        offset: firstOffset,
      },
      second: {
        width: ico.readUInt8(22),
        height: ico.readUInt8(23),
        planes: ico.readUInt16LE(26),
        bitCount: ico.readUInt16LE(28),
        offset: secondOffset,
      },
    }).toEqual({
      first: { width: 16, height: 16, planes: 1, bitCount: 32, offset: 38 },
      second: {
        width: 32,
        height: 32,
        planes: 1,
        bitCount: 32,
        offset: 38 + firstLength,
      },
    });
    expect(ico.subarray(firstOffset, firstOffset + 8)).toEqual(PNG_SIGNATURE);
    expect(ico.subarray(secondOffset, secondOffset + 8)).toEqual(PNG_SIGNATURE);
    expect(firstOffset + firstLength).toBe(secondOffset);
    expect(secondOffset + secondLength).toBe(ico.length);
  });
});

import { describe, expect, it } from 'vitest';
import manifest from '@/app/manifest';
import { product } from '@/lib/product';

describe('Folio web manifest', () => {
  it('derives manifest identity fields from product', () => {
    const value = manifest();

    expect([value.name, value.short_name, value.description]).toEqual([
      product.brand,
      product.shortName,
      product.description,
    ]);
    expect(value.icons).toEqual(expect.arrayContaining([
      expect.objectContaining({ src: '/icons/folio-stack-192.png', purpose: 'any' }),
      expect.objectContaining({ src: '/icons/folio-stack-maskable-512.png', purpose: 'maskable' }),
    ]));
  });
});

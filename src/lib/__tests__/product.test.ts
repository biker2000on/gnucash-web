import { describe, expect, it } from 'vitest';
import { product } from '@/lib/product';

describe('product identity', () => {
  it('keeps the complete identity in one immutable product export', () => {
    expect(product).toEqual({
      name: 'Folio',
      descriptor: 'for GnuCash',
      brand: 'Folio for GnuCash',
      shortName: 'Folio',
      description: 'A self-hosted, GnuCash-compatible personal finance platform.',
    });
  });
});

import { describe, expect, it } from 'vitest';
import { product } from '@/lib/product';

describe('product identity', () => {
  it('keeps the complete identity in one immutable product export', () => {
    expect(product).toEqual({
      name: 'Folio',
      descriptor: '',
      brand: 'Folio',
      shortName: 'Folio',
      description: 'A self-hosted personal and small-business finance platform.',
    });
  });

  it('prevents runtime mutation of the shared identity', () => {
    expect(Object.isFrozen(product)).toBe(true);
    expect(Reflect.set(product, 'name', 'Not Folio')).toBe(false);
    expect(product.name).toBe('Folio');
  });
});

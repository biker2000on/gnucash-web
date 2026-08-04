/**
 * originalPayeeLine: the transaction detail surface shows the preserved
 * import-time payee as a secondary line only when it exists and differs from
 * the display description (i.e. the user renamed an imported transaction).
 */
import { describe, it, expect } from 'vitest';
import { originalPayeeLine } from '../TransactionModal';

describe('originalPayeeLine', () => {
  it('returns the preserved payee when the import was renamed', () => {
    expect(originalPayeeLine({
      description: 'pajamas',
      original_description: 'HARBOR FREIGHT PAYMENT',
    })).toBe('HARBOR FREIGHT PAYMENT');
  });

  it('is hidden when the display description still matches the import', () => {
    expect(originalPayeeLine({
      description: 'Publix #1548 Boone Nc',
      original_description: 'Publix #1548 Boone Nc',
    })).toBeNull();
    expect(originalPayeeLine({
      description: '  Publix #1548 Boone Nc ',
      original_description: 'Publix #1548 Boone Nc',
    })).toBeNull();
  });

  it('is hidden for manual transactions (no preserved payee)', () => {
    expect(originalPayeeLine({ description: 'pajamas', original_description: null })).toBeNull();
    expect(originalPayeeLine({ description: 'pajamas' })).toBeNull();
    expect(originalPayeeLine({ description: 'pajamas', original_description: '  ' })).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import {
  mergeReceiptExtraction,
  shouldReextractReceipt,
} from '@/lib/receipt-reextract';

describe('receipt re-extraction helpers', () => {
  it('targets missing and regex-derived data but protects AI results by default', () => {
    expect(shouldReextractReceipt(null, false)).toBe(true);
    expect(shouldReextractReceipt({ extraction_method: 'regex' }, false)).toBe(true);
    expect(shouldReextractReceipt({ extraction_method: 'ai_fallback_regex' }, false)).toBe(true);
    expect(shouldReextractReceipt({ extraction_method: 'ai' }, false)).toBe(false);
    expect(shouldReextractReceipt({ extraction_method: 'ai' }, true)).toBe(true);
  });

  it('preserves workflow metadata while replacing extracted fields', () => {
    const merged = mergeReceiptExtraction(
      { extraction_method: 'regex', dismissed_guids: ['tx-1'], custom: 'keep' },
      {
        amount: 42.17,
        currency: 'USD',
        date: '2026-07-26',
        vendor: 'Market',
        vendor_normalized: 'market',
        extraction_method: 'ai',
        confidence: 0.9,
      },
    );
    expect(merged).toMatchObject({
      amount: 42.17,
      extraction_method: 'ai',
      dismissed_guids: ['tx-1'],
      custom: 'keep',
    });
  });
});

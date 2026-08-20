import { describe, expect, it } from 'vitest';
import { deriveSuggestedTags, withSuggestedTags } from '../suggested-tags';

describe('deriveSuggestedTags', () => {
  it('pulls tax form, issuer, and doc type as advisory labels', () => {
    expect(deriveSuggestedTags({
      suggestionKind: 'tax_record',
      suggestions: { taxForm: '1099_int', issuer: 'Ally Bank' },
      docType: 'tax',
    })).toEqual(['1099_int', 'ally-bank', 'tax']);
  });

  it('keeps explicit AI tags first and de-dupes later fields', () => {
    expect(deriveSuggestedTags({
      suggestions: {
        tags: ['farm', 'Schedule F'],
        documentClass: 'farm',
        parties: ['Acme LLC'],
      },
      docType: 'license',
    })).toEqual(['farm', 'schedule-f', 'acme-llc', 'license']);
  });

  it('drops names that cannot be stored as tags', () => {
    expect(deriveSuggestedTags({
      suggestions: { issuer: '???', documentClass: '' },
      docType: 'other',
    })).toEqual(['other']);
  });

  it('is empty when nothing usable is present', () => {
    expect(deriveSuggestedTags({})).toEqual([]);
  });
});

describe('withSuggestedTags', () => {
  it('preserves existing suggestion fields', () => {
    const wrapped = withSuggestedTags(
      { taxForm: 'w2', taxYear: 2024, issuer: 'Acme' },
      { suggestionKind: 'tax_record', docType: 'tax' },
    );
    expect(wrapped.taxForm).toBe('w2');
    expect(wrapped.taxYear).toBe(2024);
    expect(wrapped.suggestedTags).toEqual(['w2', 'acme', 'tax']);
  });
});

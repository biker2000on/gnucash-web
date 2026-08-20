import { describe, expect, it } from 'vitest';
import {
  isDocumentTagMatchField,
  matchingRules,
  matchingTagNames,
  normalizeMatchValue,
  ruleMatches,
  type DocumentTagRule,
} from '../tag-rules';

const filename: DocumentTagRule = {
  matchField: 'filename',
  matchValue: '1099',
  tag: 'tax-form',
};
const issuer: DocumentTagRule = {
  matchField: 'issuer',
  matchValue: 'Fidelity',
  tag: 'brokerage',
};
const text: DocumentTagRule = {
  matchField: 'text',
  matchValue: 'schedule F',
  tag: 'farm',
};

describe('isDocumentTagMatchField', () => {
  it('accepts the three contract fields and nothing else', () => {
    expect(isDocumentTagMatchField('filename')).toBe(true);
    expect(isDocumentTagMatchField('issuer')).toBe(true);
    expect(isDocumentTagMatchField('text')).toBe(true);
    expect(isDocumentTagMatchField('title')).toBe(false);
    expect(isDocumentTagMatchField('FILENAME')).toBe(false);
    expect(isDocumentTagMatchField('')).toBe(false);
    expect(isDocumentTagMatchField(null)).toBe(false);
  });
});

describe('ruleMatches', () => {
  it('matches a case-insensitive substring on filename', () => {
    expect(ruleMatches(filename, { filename: 'Ally-1099-INT.pdf' })).toBe(true);
    expect(ruleMatches(filename, { filename: 'w2.pdf' })).toBe(false);
  });

  it('matches issuer independently of filename and text', () => {
    expect(ruleMatches(issuer, {
      filename: 'Fidelity.pdf',
      issuer: 'fidelity investments',
      text: 'nothing',
    })).toBe(true);
    expect(ruleMatches(issuer, {
      filename: 'Fidelity.pdf',
      issuer: 'Vanguard',
      text: 'Fidelity is mentioned in the body',
    })).toBe(false);
  });

  it('matches extracted text as a case-insensitive substring', () => {
    expect(ruleMatches(text, { text: 'Filed Schedule f for 2024' })).toBe(true);
    expect(ruleMatches(text, { text: 'Schedule C only' })).toBe(false);
  });

  it('never matches an empty or whitespace needle', () => {
    expect(ruleMatches({ ...filename, matchValue: '' }, { filename: 'a.pdf' })).toBe(false);
    expect(ruleMatches({ ...filename, matchValue: '   ' }, { filename: 'a.pdf' })).toBe(false);
    expect(normalizeMatchValue('  x  ')).toBe('x');
  });

  it('never matches a null or empty field', () => {
    expect(ruleMatches(filename, { filename: null })).toBe(false);
    expect(ruleMatches(filename, { filename: '' })).toBe(false);
    expect(ruleMatches(filename, {})).toBe(false);
    expect(ruleMatches(issuer, { issuer: null, filename: 'Fidelity.pdf' })).toBe(false);
    expect(ruleMatches(text, { text: null })).toBe(false);
  });

  it('treats % and _ as literals, not LIKE wildcards', () => {
    expect(ruleMatches(
      { matchField: 'filename', matchValue: '100%', tag: 'pct' },
      { filename: 'gain-100%-realized.pdf' },
    )).toBe(true);
    expect(ruleMatches(
      { matchField: 'filename', matchValue: 'a%b', tag: 'wild' },
      { filename: 'axb.pdf' },
    )).toBe(false);
    expect(ruleMatches(
      { matchField: 'filename', matchValue: 'w_2', tag: 'w2' },
      { filename: 'w-2.pdf' },
    )).toBe(false);
    expect(ruleMatches(
      { matchField: 'filename', matchValue: 'w_2', tag: 'w2' },
      { filename: 'w_2.pdf' },
    )).toBe(true);
  });

  it('rejects an unknown match field', () => {
    expect(ruleMatches(
      { matchField: 'title' as DocumentTagRule['matchField'], matchValue: 'x', tag: 'x' },
      { filename: 'x' },
    )).toBe(false);
  });
});

describe('matchingRules', () => {
  const rules: DocumentTagRule[] = [filename, issuer, text, {
    matchField: 'filename',
    matchValue: 'INT',
    tag: 'Tax-Form',
  }];

  it('returns firing rules in input order and collapses duplicate tags', () => {
    const matched = matchingRules(rules, {
      filename: '1099-INT.pdf',
      issuer: 'Ally',
      text: 'interest',
    });
    expect(matched.map((rule) => rule.tag)).toEqual(['tax-form']);
  });

  it('can fire several distinct tags', () => {
    expect(matchingTagNames(rules, {
      filename: '1099.pdf',
      issuer: 'Fidelity',
      text: 'Schedule F expenses',
    })).toEqual(['tax-form', 'brokerage', 'farm']);
  });

  it('drops rules whose tag would be invalid after normalize', () => {
    expect(matchingTagNames([{
      matchField: 'filename',
      matchValue: 'x',
      tag: '!!!',
    }], { filename: 'x.pdf' })).toEqual([]);
  });

  it('returns nothing when no rule fires', () => {
    expect(matchingRules(rules, { filename: 'photo.jpg' })).toEqual([]);
  });
});

import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/prisma', () => ({
  default: {},
}));

import {
  matchRule,
  normalizeDescription,
  derivePattern,
  validateRuleFields,
  isMatchType,
  type CategorizationRule,
} from '../categorization.service';

let nextId = 1;

function makeRule(overrides: Partial<CategorizationRule> = {}): CategorizationRule {
  return {
    id: nextId++,
    bookGuid: 'b'.repeat(32),
    pattern: 'amazon',
    matchType: 'contains',
    accountGuid: 'a'.repeat(32),
    priority: 0,
    enabled: true,
    hitCount: 0,
    lastHitAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('matchRule', () => {
  describe('contains', () => {
    it('matches a substring case-insensitively', () => {
      const rule = makeRule({ pattern: 'king soopers', matchType: 'contains' });
      expect(matchRule([rule], 'KING SOOPERS #0123 DENVER CO')).toBe(rule);
    });

    it('matches when the pattern has different casing than the description', () => {
      const rule = makeRule({ pattern: 'AMAZON MKTP', matchType: 'contains' });
      expect(matchRule([rule], 'amazon mktp us*1a2b3c')).toBe(rule);
    });

    it('does not match when the substring is absent', () => {
      const rule = makeRule({ pattern: 'costco', matchType: 'contains' });
      expect(matchRule([rule], 'KING SOOPERS #0123')).toBeNull();
    });
  });

  describe('exact', () => {
    it('matches the full string case-insensitively', () => {
      const rule = makeRule({ pattern: 'Payroll Deposit', matchType: 'exact' });
      expect(matchRule([rule], 'PAYROLL DEPOSIT')).toBe(rule);
    });

    it('matches with surrounding whitespace trimmed', () => {
      const rule = makeRule({ pattern: 'payroll deposit', matchType: 'exact' });
      expect(matchRule([rule], '  Payroll Deposit  ')).toBe(rule);
    });

    it('does not match a partial string', () => {
      const rule = makeRule({ pattern: 'payroll', matchType: 'exact' });
      expect(matchRule([rule], 'PAYROLL DEPOSIT')).toBeNull();
    });
  });

  describe('regex', () => {
    it('matches a regular expression case-insensitively', () => {
      const rule = makeRule({ pattern: '^king\\s+soopers\\s+#\\d+', matchType: 'regex' });
      expect(matchRule([rule], 'KING SOOPERS #0123 DENVER CO')).toBe(rule);
    });

    it('does not match when the regex fails', () => {
      const rule = makeRule({ pattern: '^costco', matchType: 'regex' });
      expect(matchRule([rule], 'KING SOOPERS #0123')).toBeNull();
    });

    it('never matches (and never throws) on an invalid regex', () => {
      const rule = makeRule({ pattern: '([unclosed', matchType: 'regex' });
      expect(() => matchRule([rule], '([unclosed anything')).not.toThrow();
      expect(matchRule([rule], '([unclosed anything')).toBeNull();
    });

    it('an invalid regex does not shadow a lower-priority valid rule', () => {
      const bad = makeRule({ pattern: '([bad', matchType: 'regex', priority: 100 });
      const good = makeRule({ pattern: 'amazon', matchType: 'contains', priority: 0 });
      expect(matchRule([bad, good], 'AMAZON MKTP')).toBe(good);
    });
  });

  describe('priority and tie-breaking', () => {
    it('higher priority wins regardless of array order', () => {
      const low = makeRule({ pattern: 'amazon', priority: 0 });
      const high = makeRule({ pattern: 'amazon mktp', priority: 10 });
      expect(matchRule([low, high], 'AMAZON MKTP US')).toBe(high);
      expect(matchRule([high, low], 'AMAZON MKTP US')).toBe(high);
    });

    it('breaks priority ties by lower id', () => {
      const older = makeRule({ id: 5, pattern: 'amazon', priority: 3 });
      const newer = makeRule({ id: 9, pattern: 'amazon mktp', priority: 3 });
      expect(matchRule([newer, older], 'AMAZON MKTP US')).toBe(older);
    });
  });

  describe('enabled / edge cases', () => {
    it('skips disabled rules', () => {
      const disabled = makeRule({ pattern: 'amazon', enabled: false, priority: 10 });
      const enabled = makeRule({ pattern: 'amazon', enabled: true, priority: 0 });
      expect(matchRule([disabled, enabled], 'AMAZON MKTP')).toBe(enabled);
      expect(matchRule([disabled], 'AMAZON MKTP')).toBeNull();
    });

    it('returns null for an empty or blank description', () => {
      const rule = makeRule({ pattern: 'amazon' });
      expect(matchRule([rule], '')).toBeNull();
      expect(matchRule([rule], '   ')).toBeNull();
    });

    it('ignores rules with an empty pattern', () => {
      const rule = makeRule({ pattern: '   ' });
      expect(matchRule([rule], 'anything')).toBeNull();
    });

    it('returns null when no rules are provided', () => {
      expect(matchRule([], 'AMAZON MKTP')).toBeNull();
    });
  });
});

describe('normalizeDescription', () => {
  it('lowercases, strips digit runs, and collapses whitespace', () => {
    expect(normalizeDescription('KING SOOPERS #0123 DENVER CO')).toBe('king soopers # denver co');
    expect(normalizeDescription('AMAZON  MKTP   US*1A2B3')).toBe('amazon mktp us*ab');
  });

  it('trims the result', () => {
    expect(normalizeDescription('  12345  ')).toBe('');
  });
});

describe('derivePattern', () => {
  it('uses the longest common prefix of samples, trimming trailing digits/punctuation', () => {
    const samples = [
      'king soopers #0123 denver co',
      'king soopers #0456 aurora co',
      'king soopers #0789 boulder co',
    ];
    expect(derivePattern(samples, 'king soopers # denver co')).toBe('king soopers');
  });

  it('falls back to the normalized description when the prefix is too short', () => {
    const samples = ['abc store', 'xyz store'];
    expect(derivePattern(samples, 'some normalized desc')).toBe('some normalized desc');
  });

  it('falls back to the normalized description when there are no samples', () => {
    expect(derivePattern([], 'fallback')).toBe('fallback');
  });

  it('returns the single sample with trailing digits/punctuation trimmed', () => {
    expect(derivePattern(['netflix.com 866-1234'], 'netflix.com -')).toBe('netflix.com');
  });
});

describe('validateRuleFields', () => {
  it('accepts valid fields', () => {
    expect(validateRuleFields({ pattern: 'amazon', matchType: 'contains', priority: 5 })).toBeNull();
    expect(validateRuleFields({})).toBeNull();
  });

  it('rejects an empty pattern', () => {
    expect(validateRuleFields({ pattern: '' })).toMatch(/pattern/);
    expect(validateRuleFields({ pattern: '   ' })).toMatch(/pattern/);
  });

  it('rejects an unknown match type', () => {
    expect(validateRuleFields({ matchType: 'fuzzy' })).toMatch(/matchType/);
  });

  it('rejects an invalid regex when matchType is regex', () => {
    expect(validateRuleFields({ pattern: '([bad', matchType: 'regex' })).toMatch(/regular expression/);
    expect(validateRuleFields({ pattern: '([bad', matchType: 'contains' })).toBeNull();
  });

  it('rejects a non-integer priority', () => {
    expect(validateRuleFields({ priority: 1.5 })).toMatch(/priority/);
    expect(validateRuleFields({ priority: 'high' })).toMatch(/priority/);
  });
});

describe('isMatchType', () => {
  it('accepts the three known types and rejects others', () => {
    expect(isMatchType('contains')).toBe(true);
    expect(isMatchType('exact')).toBe(true);
    expect(isMatchType('regex')).toBe(true);
    expect(isMatchType('fuzzy')).toBe(false);
    expect(isMatchType(null)).toBe(false);
    expect(isMatchType(3)).toBe(false);
  });
});

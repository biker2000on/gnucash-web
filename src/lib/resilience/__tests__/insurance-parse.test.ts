import { describe, it, expect } from 'vitest';
import { buildInsuranceParsePrompt, parseInsuranceAiResponse } from '../insurance-parse';

describe('buildInsuranceParsePrompt', () => {
  it('asks for structured policy fields and masked policy number only', () => {
    const prompt = buildInsuranceParsePrompt();
    expect(prompt).toContain('policy_type');
    expect(prompt).toContain('coverage_limit');
    expect(prompt).toContain('renewal_date');
    expect(prompt).toContain('sublimits');
    expect(prompt).toContain('policy_number_last4');
    expect(prompt).toContain('NEVER return the full policy number');
    expect(prompt).toContain('YYYY-MM-DD');
  });
});

describe('parseInsuranceAiResponse', () => {
  it('parses a complete response into a suggestion', () => {
    const raw = JSON.stringify({
      provider: 'Acme Mutual',
      policy_type: 'home',
      covered_entity: '123 Main St, Raleigh NC',
      coverage_limit: 350000,
      deductible: 2500,
      annual_premium: 1840.5,
      renewal_date: '2027-03-01',
      policy_number_last4: '4821',
      sublimits: [
        { category: 'Jewelry', limit: 5000 },
        { category: 'Electronics', limit: 10000 },
      ],
    });
    const result = parseInsuranceAiResponse(raw);
    expect(result).toEqual({
      provider: 'Acme Mutual',
      policyType: 'home',
      coveredEntity: '123 Main St, Raleigh NC',
      coverageLimit: 350000,
      deductible: 2500,
      annualPremium: 1840.5,
      renewalDate: '2027-03-01',
      policyNumberMasked: '…4821',
      sublimits: [
        { category: 'Jewelry', limit: 5000 },
        { category: 'Electronics', limit: 10000 },
      ],
    });
  });

  it('handles markdown-fenced JSON', () => {
    const raw = '```json\n{"provider":"Acme","policy_type":"auto"}\n```';
    const result = parseInsuranceAiResponse(raw);
    expect(result.provider).toBe('Acme');
    expect(result.policyType).toBe('auto');
    expect(result.coverageLimit).toBeNull();
  });

  it('re-masks a full policy number the model returned despite instructions', () => {
    const raw = JSON.stringify({ policy_number_last4: 'HO-3 99887766' });
    const result = parseInsuranceAiResponse(raw);
    expect(result.policyNumberMasked).toBe('…7766');
    expect(result.policyNumberMasked).not.toContain('99887766');
  });

  it('maps unknown policy types to "other" and keeps nulls null', () => {
    const raw = JSON.stringify({ policy_type: 'boat', provider: null });
    const result = parseInsuranceAiResponse(raw);
    expect(result.policyType).toBe('other');
    expect(result.provider).toBeNull();
    expect(result.policyNumberMasked).toBeNull();
  });

  it('rejects malformed renewal dates and negative or non-numeric money', () => {
    const raw = JSON.stringify({
      renewal_date: 'March 1st 2027',
      coverage_limit: -5,
      deductible: 'a lot',
      annual_premium: '1,840.50',
    });
    const result = parseInsuranceAiResponse(raw);
    expect(result.renewalDate).toBeNull();
    expect(result.coverageLimit).toBeNull();
    expect(result.deductible).toBeNull();
    // Currency-formatted strings are tolerated.
    expect(result.annualPremium).toBe(1840.5);
  });

  it('drops invalid sublimit entries', () => {
    const raw = JSON.stringify({
      sublimits: [
        { category: 'Jewelry', limit: 5000 },
        { category: '', limit: 100 },
        { category: 'Firearms' },
        'nonsense',
        { limit: 3 },
      ],
    });
    const result = parseInsuranceAiResponse(raw);
    expect(result.sublimits).toEqual([{ category: 'Jewelry', limit: 5000 }]);
  });

  it('throws on non-JSON responses', () => {
    expect(() => parseInsuranceAiResponse('I could not read the document')).toThrow();
  });
});

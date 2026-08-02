import { describe, it, expect } from 'vitest';
import {
  buildEstateParsePrompt,
  classifyEstateDocumentKind,
  matchEstateMemberRole,
  parseEstateAiResponse,
} from '../estate-parse';

describe('buildEstateParsePrompt', () => {
  it('asks for the structured estate fields and names the NC directive spellings', () => {
    const prompt = buildEstateParsePrompt();
    expect(prompt).toContain('principal_name');
    expect(prompt).toContain('execution_date');
    expect(prompt).toContain('agent_names');
    expect(prompt).toContain('notarized');
    expect(prompt).toContain('healthcare_directive');
    expect(prompt).toContain('Advance Directive for a Natural Death');
    expect(prompt).toContain('ND and Treatment Instructions');
    expect(prompt).toContain('YYYY-MM-DD');
  });
});

describe('classifyEstateDocumentKind', () => {
  it('maps the real vault document titles to the right kinds', () => {
    expect(classifyEstateDocumentKind('[Executed 3.26.2026] Durable POA-CNC')).toBe('financial_poa');
    expect(classifyEstateDocumentKind('Cara Healthcare POA')).toBe('healthcare_poa');
    expect(classifyEstateDocumentKind('Cara Last Will and Testament')).toBe('will');
    expect(classifyEstateDocumentKind('Justin ND and Treatment Instructions')).toBe('healthcare_directive');
    expect(classifyEstateDocumentKind('Advance Directive for a Natural Death')).toBe('healthcare_directive');
  });

  it('keeps health care powers of attorney out of the financial POA bucket', () => {
    expect(classifyEstateDocumentKind('Health Care Power of Attorney')).toBe('healthcare_poa');
    expect(classifyEstateDocumentKind('Medical Power of Attorney')).toBe('healthcare_poa');
    expect(classifyEstateDocumentKind('Durable Power of Attorney')).toBe('financial_poa');
    expect(classifyEstateDocumentKind('General Power of Attorney')).toBe('financial_poa');
  });

  it('accepts enum values verbatim and returns null for nothing recognizable', () => {
    expect(classifyEstateDocumentKind('healthcare_directive')).toBe('healthcare_directive');
    expect(classifyEstateDocumentKind('revocable trust')).toBe('revocable_trust');
    expect(classifyEstateDocumentKind('')).toBeNull();
    expect(classifyEstateDocumentKind(null)).toBeNull();
    expect(classifyEstateDocumentKind('grocery receipt')).toBeNull();
  });
});

describe('parseEstateAiResponse', () => {
  it('parses a complete response into a suggestion', () => {
    const raw = JSON.stringify({
      kind: 'healthcare_directive',
      document_title: 'Advance Directive for a Natural Death',
      principal_name: 'Cara Crawford',
      execution_date: '2026-03-26',
      state: 'nc',
      agent_names: ['Justin Crawford', 'Jane Doe'],
      notarized: true,
    });
    expect(parseEstateAiResponse(raw)).toEqual({
      kind: 'healthcare_directive',
      principalName: 'Cara Crawford',
      executionDate: '2026-03-26',
      state: 'NC',
      agentNames: ['Justin Crawford', 'Jane Doe'],
      notarized: true,
      memberRole: null,
      memberName: null,
    });
  });

  it('handles markdown-fenced JSON', () => {
    const raw = '```json\n{"kind":"will","principal_name":"Justin Crawford"}\n```';
    const result = parseEstateAiResponse(raw);
    expect(result.kind).toBe('will');
    expect(result.principalName).toBe('Justin Crawford');
    expect(result.executionDate).toBeNull();
  });

  it('falls back to the document title when the model returns a useless kind', () => {
    const raw = JSON.stringify({ kind: 'other', document_title: 'ND and Treatment Instructions' });
    expect(parseEstateAiResponse(raw).kind).toBe('healthcare_directive');
    const unknown = JSON.stringify({ kind: 'estate paperwork', document_title: 'Last Will and Testament' });
    expect(parseEstateAiResponse(unknown).kind).toBe('will');
  });

  it('keeps "other" when neither the kind nor the title is recognizable', () => {
    expect(parseEstateAiResponse(JSON.stringify({ kind: 'other', document_title: 'Scan 001' })).kind).toBe('other');
    expect(parseEstateAiResponse(JSON.stringify({})).kind).toBeNull();
  });

  it('rejects loose dates, bad state codes, and non-string agent entries', () => {
    const raw = JSON.stringify({
      execution_date: 'March 26, 2026',
      state: 'North Carolina',
      agent_names: ['Justin Crawford', '', 42, null, { name: 'nope' }],
      notarized: 'yes',
    });
    const result = parseEstateAiResponse(raw);
    expect(result.executionDate).toBeNull();
    expect(result.state).toBeNull();
    expect(result.agentNames).toEqual(['Justin Crawford']);
    // Only a real boolean counts; anything else is undeterminable.
    expect(result.notarized).toBeNull();
  });

  it('throws on garbage that is not JSON', () => {
    expect(() => parseEstateAiResponse('I could not read the document')).toThrow();
  });
});

describe('matchEstateMemberRole', () => {
  const roster = [
    { role: 'self', name: 'Justin Crawford' },
    { role: 'spouse', name: 'Cara Crawford' },
    { role: 'owner', name: 'Justin Crawford' },
  ];

  it('matches a full name case-insensitively and ignores business roles', () => {
    expect(matchEstateMemberRole('cara crawford', roster)).toEqual({ memberRole: 'spouse', memberName: 'Cara Crawford' });
    expect(matchEstateMemberRole('JUSTIN CRAWFORD', roster)).toEqual({ memberRole: 'self', memberName: 'Justin Crawford' });
  });

  it('matches a unique first name and tolerates punctuation', () => {
    expect(matchEstateMemberRole('Cara', roster)?.memberRole).toBe('spouse');
    expect(matchEstateMemberRole('Justin  Crawford.', roster)?.memberRole).toBe('self');
  });

  it('returns null when there is no confident match', () => {
    expect(matchEstateMemberRole('Robert Crawford', roster)).toBeNull();
    expect(matchEstateMemberRole(null, roster)).toBeNull();
    expect(matchEstateMemberRole('   ', roster)).toBeNull();
    expect(matchEstateMemberRole('Cara Crawford', [])).toBeNull();
    // An ambiguous first name shared by two members stays unmatched.
    expect(matchEstateMemberRole('Chris', [
      { role: 'self', name: 'Chris Adams' },
      { role: 'spouse', name: 'Chris Baker' },
    ])).toBeNull();
  });
});

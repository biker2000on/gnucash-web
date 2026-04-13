import { describe, it, expect } from 'vitest';
import { parsePayslipAiResponse, buildPayslipExtractionPrompt } from '../payslip-extraction';

describe('parsePayslipAiResponse', () => {
  it('parses valid JSON response with line items', () => {
    const raw = JSON.stringify({
      employer_name: 'Acme Corp',
      pay_date: '2026-01-15',
      pay_period_start: '2026-01-01',
      pay_period_end: '2026-01-15',
      gross_pay: 4000,
      net_pay: 3002,
      line_items: [
        { category: 'earnings', label: 'Regular Pay', normalized_label: 'regular_pay', amount: 4000, hours: 80, rate: 50 },
        { category: 'tax', label: 'Federal Income Tax', normalized_label: 'federal_income_tax', amount: -600 },
        { category: 'deduction', label: '401(k)', normalized_label: '401k', amount: -398 },
      ],
    });
    const result = parsePayslipAiResponse(raw);
    expect(result.employer_name).toBe('Acme Corp');
    expect(result.gross_pay).toBe(4000);
    expect(result.net_pay).toBe(3002);
    expect(result.line_items).toHaveLength(3);
    expect(result.line_items[0].category).toBe('earnings');
    expect(result.line_items[0].normalized_label).toBe('regular_pay');
    expect(result.line_items[1].amount).toBe(-600);
  });

  it('handles markdown-wrapped JSON', () => {
    const raw = '```json\n{"employer_name":"Acme","pay_date":"2026-01-15","gross_pay":4000,"net_pay":3000,"line_items":[]}\n```';
    const result = parsePayslipAiResponse(raw);
    expect(result.employer_name).toBe('Acme');
  });

  it('throws on invalid JSON', () => {
    expect(() => parsePayslipAiResponse('not json')).toThrow();
  });

  it('throws on missing required fields', () => {
    const raw = JSON.stringify({ employer_name: 'Acme' });
    expect(() => parsePayslipAiResponse(raw)).toThrow();
  });
});

describe('buildPayslipExtractionPrompt', () => {
  it('returns system and user messages', () => {
    const { system, user } = buildPayslipExtractionPrompt('Regular Pay: $4,000.00\nFed Tax: -$600');
    expect(system).toContain('payslip');
    expect(system).toContain('normalized_label');
    expect(user).toContain('Regular Pay');
  });
});

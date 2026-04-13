import { describe, it, expect } from 'vitest';
import { extractAmountForLabel, extractPayslipFields, applyTemplateWithRegex } from '../payslip-regex';

describe('extractAmountForLabel', () => {
  const sampleText = `
    Regular Pay          80.00 hrs    $4,000.00
    Federal Income Tax                  -$600.00
    Social Security                     -$248.00
    401(k)                              -$400.00
    Net Pay                           $2,752.00
  `;

  it('extracts amount for an exact label match', () => {
    expect(extractAmountForLabel(sampleText, 'Regular Pay')).toBe(4000.00);
  });

  it('extracts negative amount for tax label', () => {
    expect(extractAmountForLabel(sampleText, 'Federal Income Tax')).toBe(-600.00);
  });

  it('extracts amount for label with special chars', () => {
    expect(extractAmountForLabel(sampleText, '401(k)')).toBe(-400.00);
  });

  it('returns null for label not found', () => {
    expect(extractAmountForLabel(sampleText, 'Dental Insurance')).toBeNull();
  });
});

describe('extractPayslipFields', () => {
  const sampleText = `
    ACME CORPORATION
    Pay Date: 01/15/2026
    Pay Period: 01/01/2026 - 01/15/2026
    Gross Pay: $4,000.00
    Net Pay: $2,752.00
    Regular Pay          80.00 hrs    $4,000.00
    Federal Income Tax                  -$600.00
  `;

  it('extracts employer name from first substantive line', () => {
    expect(extractPayslipFields(sampleText).employer_name).toBe('ACME CORPORATION');
  });

  it('extracts pay date', () => {
    expect(extractPayslipFields(sampleText).pay_date).toBe('2026-01-15');
  });

  it('extracts gross pay', () => {
    expect(extractPayslipFields(sampleText).gross_pay).toBe(4000.00);
  });

  it('extracts net pay', () => {
    expect(extractPayslipFields(sampleText).net_pay).toBe(2752.00);
  });
});

describe('applyTemplateWithRegex', () => {
  const template = [
    { category: 'earnings', label: 'Regular Pay', normalized_label: 'regular_pay' },
    { category: 'tax', label: 'Federal Income Tax', normalized_label: 'federal_income_tax' },
    { category: 'deduction', label: '401(k)', normalized_label: '401k' },
  ] as const;

  const ocrText = `
    Regular Pay          80.00 hrs    $4,000.00
    Federal Income Tax                  $600.00
    401(k)                              $400.00
  `;

  it('returns line items with amounts from OCR text', () => {
    const items = applyTemplateWithRegex(template, ocrText);
    expect(items).toHaveLength(3);
    expect(items[0].amount).toBe(4000.00);
    expect(items[1].amount).toBe(-600.00); // taxes negated
    expect(items[2].amount).toBe(-400.00); // deductions negated
  });

  it('sets amount to 0 for labels not found in text', () => {
    const extraTemplate = [
      ...template,
      { category: 'deduction', label: 'Dental Insurance', normalized_label: 'dental_insurance' },
    ] as const;
    const items = applyTemplateWithRegex(extraTemplate, ocrText);
    const dental = items.find(i => i.normalized_label === 'dental_insurance');
    expect(dental?.amount).toBe(0);
  });
});

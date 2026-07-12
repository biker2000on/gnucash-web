/**
 * Tax Schedule Report + TXF export — pure-logic tests.
 *
 *   - TXF code table integrity: unique codes, N-prefix shape, known forms,
 *     required reference codes present.
 *   - Category → code mapping: every tax category resolves (code or null),
 *     override precedence, exclude/null handling.
 *   - Override change validation (partitionTxfOverrideChanges).
 *   - Sign handling: income accounts flip positive, expenses pass through.
 *   - buildTaxScheduleItems: grouping, totals, ordering, unmapped
 *     tax-related collection.
 *   - TXF V042 file output: header, record structure, ^ separators, CRLF,
 *     amount formatting (2 decimals, no thousands separators), payer
 *     detail records.
 */

import { describe, it, expect } from 'vitest';
import {
  TXF_CODES,
  TXF_FORM_ORDER,
  getTxfCode,
  isValidTxfCode,
  txfCodesByForm,
} from '../tax/txf-codes';
import {
  CATEGORY_TXF_CODES,
  resolveTxfCode,
  partitionTxfOverrideChanges,
  TxfOverrideValidationError,
} from '../tax/txf';
import {
  buildTaxScheduleItems,
  presentAmount,
  type TaxScheduleAccountInput,
} from '../tax/tax-schedule';
import { buildTxfFile, formatTxfAmount, formatTxfDate } from '../tax/txf-file';
import { TAX_CATEGORIES } from '../tax/types';

const GUID_A = 'a'.repeat(32);
const GUID_B = 'b'.repeat(32);
const GUID_C = 'c'.repeat(32);

/* ------------------------------------------------------------------ */
/* Code table integrity                                                 */
/* ------------------------------------------------------------------ */

describe('TXF code table', () => {
  it('has unique codes', () => {
    const codes = TXF_CODES.map(c => c.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('codes are N-prefixed numbers with non-empty metadata', () => {
    for (const c of TXF_CODES) {
      expect(c.code).toMatch(/^N\d{3}$/);
      expect(c.form.length).toBeGreaterThan(0);
      expect(c.description.length).toBeGreaterThan(0);
      expect(['income', 'deduction']).toContain(c.sign);
    }
  });

  it('only uses forms listed in TXF_FORM_ORDER', () => {
    for (const c of TXF_CODES) {
      expect(TXF_FORM_ORDER).toContain(c.form);
    }
  });

  it('contains the core reference codes', () => {
    for (const code of ['N256', 'N287', 'N488', 'N286', 'N683', 'N684', 'N261', 'N304', 'N521', 'N522', 'N565', 'N372']) {
      expect(isValidTxfCode(code)).toBe(true);
    }
  });

  it('flags payer support on 1099/W-2 style codes only', () => {
    expect(getTxfCode('N287')?.payerSupported).toBe(true); // 1099-INT
    expect(getTxfCode('N488')?.payerSupported).toBe(true); // 1099-DIV
    expect(getTxfCode('N256')?.payerSupported).toBe(true); // W-2
    expect(getTxfCode('N565')?.payerSupported).toBe(false); // charitable cash
    expect(getTxfCode('N523')?.payerSupported).toBe(false); // 1040-ES
  });

  it('rejects unknown codes', () => {
    expect(isValidTxfCode('N999')).toBe(false);
    expect(isValidTxfCode('287')).toBe(false);
    expect(isValidTxfCode('')).toBe(false);
    expect(isValidTxfCode(null)).toBe(false);
  });

  it('groups by form in 1040-first order', () => {
    const groups = txfCodesByForm();
    expect(groups[0].form).toBe('1040');
    const forms = groups.map(g => g.form);
    expect(forms.indexOf('Schedule A')).toBeLessThan(forms.indexOf('Schedule B'));
    for (const g of groups) expect(g.codes.length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ */
/* Category → code mapping                                              */
/* ------------------------------------------------------------------ */

describe('CATEGORY_TXF_CODES / resolveTxfCode', () => {
  it('covers every tax category with a valid code or an explicit null', () => {
    for (const category of TAX_CATEGORIES) {
      expect(CATEGORY_TXF_CODES).toHaveProperty(category);
      const code = CATEGORY_TXF_CODES[category];
      if (code !== null) expect(isValidTxfCode(code)).toBe(true);
    }
  });

  it('maps the headline categories to the expected codes', () => {
    expect(CATEGORY_TXF_CODES.w2_wages).toBe('N256');
    expect(CATEGORY_TXF_CODES.interest_income).toBe('N287');
    expect(CATEGORY_TXF_CODES.ordinary_dividends).toBe('N488');
    expect(CATEGORY_TXF_CODES.qualified_dividends).toBe('N286');
    expect(CATEGORY_TXF_CODES.federal_withholding).toBe('N522');
    expect(CATEGORY_TXF_CODES.state_withholding).toBe('N521');
    expect(CATEGORY_TXF_CODES.charitable_donation).toBe('N565');
    expect(CATEGORY_TXF_CODES.self_employment_income).toBe('N261');
    expect(CATEGORY_TXF_CODES.trad_ira_contribution).toBe('N304');
    expect(CATEGORY_TXF_CODES.rental_income).toBe('N372');
  });

  it('maps W-2 box-12 style and no-federal-line categories to null', () => {
    expect(CATEGORY_TXF_CODES.trad_401k_contribution).toBeNull();
    expect(CATEGORY_TXF_CODES.fica_social_security).toBeNull();
    expect(CATEGORY_TXF_CODES.fica_medicare).toBeNull();
    expect(CATEGORY_TXF_CODES.education_529_contribution).toBeNull();
    expect(CATEGORY_TXF_CODES.exclude).toBeNull();
  });

  it('override beats category default; invalid override falls back', () => {
    expect(resolveTxfCode('interest_income', 'N488')).toBe('N488');
    expect(resolveTxfCode('interest_income', null)).toBe('N287');
    expect(resolveTxfCode('interest_income', 'N999')).toBe('N287');
    expect(resolveTxfCode(null, 'N565')).toBe('N565');
    expect(resolveTxfCode(null, null)).toBeNull();
    expect(resolveTxfCode('exclude', null)).toBeNull();
    expect(resolveTxfCode('fica_medicare', null)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Override change validation                                           */
/* ------------------------------------------------------------------ */

describe('partitionTxfOverrideChanges', () => {
  const book = new Set([GUID_A, GUID_B]);

  it('splits valid changes into upserts and deletes', () => {
    const result = partitionTxfOverrideChanges(
      [
        { accountGuid: GUID_A, code: 'N287' },
        { accountGuid: GUID_B, code: null },
      ],
      book,
    );
    expect(result.upserts).toEqual([{ accountGuid: GUID_A, code: 'N287' }]);
    expect(result.deletes).toEqual([GUID_B]);
  });

  it('rejects out-of-book and malformed guids', () => {
    expect(() =>
      partitionTxfOverrideChanges([{ accountGuid: GUID_C, code: 'N287' }], book),
    ).toThrow(TxfOverrideValidationError);
    expect(() =>
      partitionTxfOverrideChanges([{ accountGuid: 'short', code: 'N287' }], book),
    ).toThrow(TxfOverrideValidationError);
  });

  it('rejects unknown codes', () => {
    expect(() =>
      partitionTxfOverrideChanges([{ accountGuid: GUID_A, code: 'N999' }], book),
    ).toThrow(TxfOverrideValidationError);
  });
});

/* ------------------------------------------------------------------ */
/* Sign handling + report aggregation                                   */
/* ------------------------------------------------------------------ */

const input = (over: Partial<TaxScheduleAccountInput>): TaxScheduleAccountInput => ({
  guid: GUID_A,
  path: 'Income:Interest',
  accountType: 'INCOME',
  rawTotal: -100,
  category: 'interest_income',
  overrideCode: null,
  taxRelated: false,
  ...over,
});

describe('presentAmount / buildTaxScheduleItems', () => {
  it('flips income negative → positive, leaves expenses as stored', () => {
    expect(presentAmount('INCOME', -1234.56)).toBe(1234.56);
    expect(presentAmount('INCOME', 50)).toBe(-50); // refund-style debit
    expect(presentAmount('EXPENSE', 321.09)).toBe(321.09);
    expect(presentAmount('BANK', -10)).toBe(-10);
  });

  it('groups accounts by resolved code with cent-exact totals', () => {
    const { items } = buildTaxScheduleItems([
      input({ guid: GUID_A, path: 'Income:Interest:Chase', rawTotal: -100.1 }),
      input({ guid: GUID_B, path: 'Income:Interest:Ally', rawTotal: -200.2 }),
      input({
        guid: GUID_C,
        path: 'Expenses:Charity',
        accountType: 'EXPENSE',
        category: 'charitable_donation',
        rawTotal: 500.05,
      }),
    ]);
    expect(items).toHaveLength(2);

    const interest = items.find(i => i.code === 'N287')!;
    expect(interest.total).toBe(300.3);
    expect(interest.accounts).toHaveLength(2);
    // Sorted by |amount| descending
    expect(interest.accounts[0].path).toBe('Income:Interest:Ally');

    const charity = items.find(i => i.code === 'N565')!;
    expect(charity.total).toBe(500.05);
    expect(charity.sign).toBe('deduction');
  });

  it('sorts items by form order (1040 before schedules), then code', () => {
    const { items } = buildTaxScheduleItems([
      input({ guid: GUID_A, category: 'interest_income' }), // Schedule B
      input({
        guid: GUID_B,
        path: 'Income:Salary',
        category: 'w2_wages',
        rawTotal: -5000,
      }), // 1040
      input({
        guid: GUID_C,
        path: 'Expenses:Charity',
        accountType: 'EXPENSE',
        category: 'charitable_donation',
        rawTotal: 10,
      }), // Schedule A
    ]);
    expect(items.map(i => i.form)).toEqual(['1040', 'Schedule A', 'Schedule B']);
  });

  it('an override moves the account onto the chosen code', () => {
    const { items } = buildTaxScheduleItems([
      input({ overrideCode: 'N488' }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].code).toBe('N488');
    expect(items[0].accounts[0].source).toBe('override');
  });

  it('collects tax-related accounts with no code as unmapped, keeps zero-activity ones', () => {
    const { items, unmappedTaxRelated } = buildTaxScheduleItems([
      input({ guid: GUID_A, category: null, taxRelated: true, rawTotal: -42 }),
      input({ guid: GUID_B, category: null, taxRelated: true, rawTotal: 0, path: 'Expenses:Idle', accountType: 'EXPENSE' }),
      input({ guid: GUID_C, category: null, taxRelated: false, rawTotal: -99 }),
    ]);
    expect(items).toHaveLength(0);
    expect(unmappedTaxRelated).toHaveLength(2);
    const paths = unmappedTaxRelated.map(u => u.path);
    expect(paths).toContain('Expenses:Idle');
    expect(unmappedTaxRelated.find(u => u.accountGuid === GUID_A)?.amount).toBe(42);
  });

  it('drops zero-activity mapped accounts from line items', () => {
    const { items } = buildTaxScheduleItems([input({ rawTotal: 0 })]);
    expect(items).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* TXF file format                                                      */
/* ------------------------------------------------------------------ */

describe('formatTxfAmount', () => {
  it('formats 2 decimals with no thousands separators', () => {
    expect(formatTxfAmount(1234567.891)).toBe('1234567.89');
    expect(formatTxfAmount(100)).toBe('100.00');
    expect(formatTxfAmount(0.1 + 0.2)).toBe('0.30');
  });

  it('handles negatives and negative zero', () => {
    expect(formatTxfAmount(-42.5)).toBe('-42.50');
    expect(formatTxfAmount(-0)).toBe('0.00');
    expect(formatTxfAmount(-0.001)).toBe('0.00');
  });
});

describe('buildTxfFile', () => {
  const fixedDate = new Date(2026, 3, 15); // April 15, 2026 (local time)

  it('formats the D header date as MM/DD/YYYY', () => {
    expect(formatTxfDate(fixedDate)).toBe('04/15/2026');
    expect(formatTxfDate(new Date(2026, 11, 1))).toBe('12/01/2026');
  });

  it('emits a V042 header record terminated by ^', () => {
    const txf = buildTxfFile([], { date: fixedDate, software: 'GnuCash Web' });
    expect(txf).toBe('V042\r\nAGnuCash Web\r\nD04/15/2026\r\n^\r\n');
  });

  it('uses CRLF for every line ending', () => {
    const txf = buildTxfFile(
      [{ code: 'N565', payerSupported: false, total: 10, accounts: [{ path: 'Expenses:Charity', amount: 10 }] }],
      { date: fixedDate },
    );
    // No bare \n or \r anywhere
    expect(txf.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    expect(txf.endsWith('\r\n')).toBe(true);
  });

  it('emits a summary record (TD/N/C1/L1/$) for non-payer codes', () => {
    const txf = buildTxfFile(
      [{
        code: 'N565',
        payerSupported: false,
        total: 1500.5,
        accounts: [
          { path: 'Expenses:Charity:Red Cross', amount: 1000 },
          { path: 'Expenses:Charity:Food Bank', amount: 500.5 },
        ],
      }],
      { date: fixedDate },
    );
    expect(txf).toContain('TD\r\nN565\r\nC1\r\nL1\r\n$1500.50\r\n^\r\n');
    // Single record for the code — no per-account detail, no P lines
    expect(txf.match(/N565/g)).toHaveLength(1);
    expect(txf).not.toContain('PRed Cross');
  });

  it('emits one detail record per account with a P payer line for payer codes', () => {
    const txf = buildTxfFile(
      [{
        code: 'N287',
        payerSupported: true,
        total: 300,
        accounts: [
          { path: 'Income:Interest:Chase Savings', amount: 100 },
          { path: 'Income:Interest:Ally', amount: 200 },
        ],
      }],
      { date: fixedDate },
    );
    expect(txf).toContain('TD\r\nN287\r\nC1\r\nL1\r\n$100.00\r\nPChase Savings\r\n^\r\n');
    expect(txf).toContain('TD\r\nN287\r\nC1\r\nL1\r\n$200.00\r\nPAlly\r\n^\r\n');
    expect(txf.match(/N287/g)).toHaveLength(2);
  });

  it('skips zero-amount records and formats negatives as $-', () => {
    const txf = buildTxfFile(
      [
        { code: 'N565', payerSupported: false, total: 0, accounts: [] },
        {
          code: 'N287',
          payerSupported: true,
          total: -25,
          accounts: [
            { path: 'Income:Interest:Adjustment', amount: -25 },
            { path: 'Income:Interest:Zero', amount: 0.001 },
          ],
        },
      ],
      { date: fixedDate },
    );
    expect(txf).not.toContain('N565');
    expect(txf).toContain('$-25.00');
    expect(txf).not.toContain('PZero');
  });

  it('every record is terminated by ^ on its own line', () => {
    const txf = buildTxfFile(
      [
        { code: 'N565', payerSupported: false, total: 10, accounts: [] },
        { code: 'N287', payerSupported: true, total: 5, accounts: [{ path: 'A:B', amount: 5 }] },
      ],
      { date: fixedDate },
    );
    const records = txf.split('^\r\n').filter(s => s.length > 0);
    // header + 2 records
    expect(records).toHaveLength(3);
    for (const r of records) expect(r.endsWith('\r\n')).toBe(true);
  });
});

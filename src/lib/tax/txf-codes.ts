/**
 * TXF (Tax Exchange Format) V042 reference-code table.
 *
 * TXF is the plain-text interchange format consumed by TurboTax / TaxCut /
 * H&R Block desktop software. Each exportable amount is tagged with an
 * "N" reference number that identifies an IRS form + line.
 *
 * IMPORTANT — code provenance: the TXF V042 specification is a de-facto
 * standard originally published by the Tax Data Exchange consortium and
 * mirrored in GnuCash desktop's txf.scm tables. The reference numbers below
 * follow the codes commonly used by GnuCash desktop and other exporters
 * (N287 interest, N488 ordinary dividends, N286 qualified dividends,
 * N683/N684 long/short-term 1099-B, N261 Schedule C gross receipts, ...).
 * A few less-common assignments (Schedule C expense lines, HSA, SEP/SIMPLE)
 * are plausible standard codes; verify against the tax software's TXF
 * import list before filing. See docs comment on each entry.
 *
 * Sign convention: `sign: 'income'` items are credit-normal in GnuCash
 * (stored negative) and are presented/exported positive; `sign: 'deduction'`
 * items are debit-normal (expenses, withholding, contributions) and are
 * presented/exported positive as stored.
 *
 * `payerSupported: true` marks codes whose 1099/W-2 semantics carry a payer
 * name (interest, dividends, wages, pensions). For these the TXF export
 * emits one detail record per source account with a "P" payer line instead
 * of a single anonymous summary record.
 */

export type TxfSign = 'income' | 'deduction';

export interface TxfCode {
  /** Reference number including the leading N, e.g. 'N287' */
  code: string;
  /** Human form grouping: '1040', 'Schedule A', 'Schedule B', ... */
  form: string;
  /** Form line label (best-effort; forms shift lines between years) */
  line: string;
  description: string;
  sign: TxfSign;
  /** Emit per-payer detail records (P line) in the .txf export */
  payerSupported: boolean;
}

export const TXF_CODES: readonly TxfCode[] = [
  /* ---------------- Form 1040 core ---------------- */
  { code: 'N256', form: '1040', line: '1a', description: 'W-2 wages and salary', sign: 'income', payerSupported: true },
  { code: 'N522', form: '1040', line: '25a', description: 'Federal income tax withheld (W-2 / 1099)', sign: 'deduction', payerSupported: true },
  { code: 'N523', form: '1040', line: '26', description: 'Federal estimated tax payments (1040-ES)', sign: 'deduction', payerSupported: false },
  { code: 'N262', form: '1040', line: 'Sch 1 line 8', description: 'Other income, miscellaneous', sign: 'income', payerSupported: false },
  { code: 'N473', form: '1040', line: '4a/5a', description: 'Pension / IRA distributions (1099-R)', sign: 'income', payerSupported: true },
  { code: 'N483', form: '1040', line: '6a', description: 'Social Security benefits (SSA-1099)', sign: 'income', payerSupported: false },
  { code: 'N304', form: '1040', line: 'Sch 1 line 20', description: 'Traditional IRA contribution', sign: 'deduction', payerSupported: false },
  { code: 'N432', form: '1040', line: 'Sch 1 line 16', description: 'SEP-IRA / Keogh contribution (self-employed)', sign: 'deduction', payerSupported: false },
  { code: 'N433', form: '1040', line: 'Sch 1 line 16', description: 'SIMPLE IRA elective deferral (self-employed)', sign: 'deduction', payerSupported: false },
  { code: 'N625', form: '1040', line: 'Form 8889 line 2', description: 'HSA contribution (made outside payroll)', sign: 'deduction', payerSupported: false },

  /* ---------------- Schedule B — interest & dividends ---------------- */
  { code: 'N287', form: 'Schedule B', line: 'Part I', description: 'Taxable interest income (1099-INT box 1)', sign: 'income', payerSupported: true },
  { code: 'N489', form: 'Schedule B', line: '1040 line 2a', description: 'Tax-exempt interest (1099-INT box 8)', sign: 'income', payerSupported: true },
  { code: 'N488', form: 'Schedule B', line: 'Part II', description: 'Ordinary dividends (1099-DIV box 1a)', sign: 'income', payerSupported: true },
  { code: 'N286', form: 'Schedule B', line: '1040 line 3a', description: 'Qualified dividends (1099-DIV box 1b)', sign: 'income', payerSupported: true },

  /* ---------------- Schedule D / 1099-B ---------------- */
  { code: 'N683', form: 'Schedule D', line: 'Part II', description: 'Long-term gain/loss (1099-B)', sign: 'income', payerSupported: false },
  { code: 'N684', form: 'Schedule D', line: 'Part I', description: 'Short-term gain/loss (1099-B)', sign: 'income', payerSupported: false },

  /* ---------------- Schedule C — sole proprietor ---------------- */
  { code: 'N261', form: 'Schedule C', line: '1', description: 'Gross receipts or sales', sign: 'income', payerSupported: false },
  { code: 'N293', form: 'Schedule C', line: '8', description: 'Advertising', sign: 'deduction', payerSupported: false },
  { code: 'N294', form: 'Schedule C', line: '9', description: 'Car and truck expenses', sign: 'deduction', payerSupported: false },
  { code: 'N295', form: 'Schedule C', line: '10', description: 'Commissions and fees', sign: 'deduction', payerSupported: false },
  { code: 'N296', form: 'Schedule C', line: '15', description: 'Insurance (other than health)', sign: 'deduction', payerSupported: false },
  { code: 'N297', form: 'Schedule C', line: '17', description: 'Legal and professional services', sign: 'deduction', payerSupported: false },
  { code: 'N298', form: 'Schedule C', line: '18', description: 'Office expense', sign: 'deduction', payerSupported: false },
  { code: 'N299', form: 'Schedule C', line: '20b', description: 'Rent or lease — other business property', sign: 'deduction', payerSupported: false },
  { code: 'N300', form: 'Schedule C', line: '21', description: 'Repairs and maintenance', sign: 'deduction', payerSupported: false },
  { code: 'N301', form: 'Schedule C', line: '22', description: 'Supplies', sign: 'deduction', payerSupported: false },
  { code: 'N302', form: 'Schedule C', line: '23', description: 'Taxes and licenses', sign: 'deduction', payerSupported: false },
  { code: 'N303', form: 'Schedule C', line: '24a', description: 'Travel', sign: 'deduction', payerSupported: false },
  { code: 'N305', form: 'Schedule C', line: '25', description: 'Utilities', sign: 'deduction', payerSupported: false },
  { code: 'N306', form: 'Schedule C', line: '26', description: 'Wages paid', sign: 'deduction', payerSupported: false },
  { code: 'N307', form: 'Schedule C', line: '27a', description: 'Other business expenses', sign: 'deduction', payerSupported: false },

  /* ---------------- Schedule E — rentals & royalties ---------------- */
  { code: 'N372', form: 'Schedule E', line: '3', description: 'Rents received', sign: 'income', payerSupported: false },
  { code: 'N373', form: 'Schedule E', line: '4', description: 'Royalties received', sign: 'income', payerSupported: false },

  /* ---------------- Schedule A — itemized deductions ---------------- */
  { code: 'N521', form: 'Schedule A', line: '5a', description: 'State and local income taxes (withheld or paid)', sign: 'deduction', payerSupported: false },
  { code: 'N524', form: 'Schedule A', line: '5a', description: 'State estimated tax payments', sign: 'deduction', payerSupported: false },
  { code: 'N540', form: 'Schedule A', line: '5b', description: 'Real estate (property) taxes', sign: 'deduction', payerSupported: false },
  { code: 'N545', form: 'Schedule A', line: '1', description: 'Medical and dental expenses', sign: 'deduction', payerSupported: false },
  { code: 'N564', form: 'Schedule A', line: '8a', description: 'Home mortgage interest (Form 1098)', sign: 'deduction', payerSupported: true },
  { code: 'N565', form: 'Schedule A', line: '11', description: 'Charitable contributions — cash', sign: 'deduction', payerSupported: false },
  { code: 'N566', form: 'Schedule A', line: '12', description: 'Charitable contributions — non-cash', sign: 'deduction', payerSupported: false },
  { code: 'N568', form: 'Schedule A', line: '16', description: 'Other itemized deductions', sign: 'deduction', payerSupported: false },
] as const;

/** Display ordering for the grouped report (1040 first, then schedules). */
export const TXF_FORM_ORDER: readonly string[] = [
  '1040',
  'Schedule A',
  'Schedule B',
  'Schedule C',
  'Schedule D',
  'Schedule E',
] as const;

const CODE_MAP: ReadonlyMap<string, TxfCode> = new Map(TXF_CODES.map(c => [c.code, c]));

export function getTxfCode(code: string): TxfCode | undefined {
  return CODE_MAP.get(code);
}

export function isValidTxfCode(code: unknown): code is string {
  return typeof code === 'string' && CODE_MAP.has(code);
}

/** Codes grouped by form in TXF_FORM_ORDER order (for pickers / tables). */
export function txfCodesByForm(): Array<{ form: string; codes: TxfCode[] }> {
  const groups = new Map<string, TxfCode[]>();
  for (const c of TXF_CODES) {
    const arr = groups.get(c.form) ?? [];
    arr.push(c);
    groups.set(c.form, arr);
  }
  const order = (form: string) => {
    const idx = TXF_FORM_ORDER.indexOf(form);
    return idx === -1 ? TXF_FORM_ORDER.length : idx;
  };
  return [...groups.entries()]
    .sort((a, b) => order(a[0]) - order(b[0]) || a[0].localeCompare(b[0]))
    .map(([form, codes]) => ({ form, codes }));
}

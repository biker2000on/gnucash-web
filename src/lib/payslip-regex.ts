import { PayslipLineItem, PayslipLineItemCategory } from '@/lib/types';

/**
 * Escape special regex characters in a string so it can be used as a literal pattern.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Parse a raw dollar string (e.g. "-$1,234.56" or "$1,234.56") into a number.
 * Returns null if parsing fails.
 */
function parseDollarAmount(raw: string): number | null {
  const cleaned = raw.replace(/[$,\s]/g, '');
  const value = parseFloat(cleaned);
  return isNaN(value) ? null : value;
}

/**
 * Find the label in OCR text (case-insensitive, flexible whitespace) and extract
 * the nearest dollar amount within ~80 chars after it.
 * Prefers amounts with a $ sign. Falls back to any decimal amount if no $ is found.
 * Pattern matches: optional minus, optional $, digits with commas, decimal point, 2 digits.
 */
export function extractAmountForLabel(ocrText: string, label: string): number | null {
  const escapedLabel = escapeRegex(label);
  // Allow flexible whitespace between words in the label
  const labelPattern = escapedLabel.replace(/\s+/g, '\\s+');

  // First pass: prefer amounts with an explicit $ sign (more reliable)
  const dollarRegex = new RegExp(
    `${labelPattern}[\\s\\S]{0,80}?(-?\\$\\s*[\\d,]+\\.\\d{2})`,
    'i'
  );
  const dollarMatch = ocrText.match(dollarRegex);
  if (dollarMatch) return parseDollarAmount(dollarMatch[1]);

  // Second pass: any decimal-looking number (may be hours/rate, less reliable)
  const anyRegex = new RegExp(
    `${labelPattern}[\\s\\S]{0,80}?(-?[\\d,]+\\.\\d{2})`,
    'i'
  );
  const anyMatch = ocrText.match(anyRegex);
  if (!anyMatch) return null;
  return parseDollarAmount(anyMatch[1]);
}

/**
 * Parsed fields from a payslip's OCR text.
 */
export interface PayslipFields {
  employer_name: string | null;
  pay_date: string | null;
  pay_period_start: string | null;
  pay_period_end: string | null;
  gross_pay: number | null;
  net_pay: number | null;
}

/** Keywords that indicate a header/field line rather than an employer name. */
const FIELD_KEYWORDS = [
  'pay date', 'check date', 'payment date',
  'pay period', 'period',
  'gross', 'net pay', 'net',
  'employee', 'employer',
  'ssn', 'social security number',
  'address', 'department', 'position',
];

/**
 * Parse a date string in MM/DD/YYYY or YYYY-MM-DD format into YYYY-MM-DD.
 * Returns null if parsing fails.
 */
function parseDate(raw: string): string | null {
  // MM/DD/YYYY
  const mdyMatch = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdyMatch) {
    const [, m, d, y] = mdyMatch;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  // YYYY-MM-DD
  const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    return raw;
  }
  return null;
}

/**
 * Extract a date string near a keyword in the text.
 * Looks for the keyword then finds the first date pattern within ~60 chars.
 */
function extractDateNear(text: string, keywords: string[]): string | null {
  for (const keyword of keywords) {
    const escapedKw = escapeRegex(keyword);
    // Date patterns: MM/DD/YYYY or YYYY-MM-DD
    const regex = new RegExp(
      `${escapedKw}[\\s\\S]{0,60}?(\\d{1,2}\\/\\d{1,2}\\/\\d{4}|\\d{4}-\\d{2}-\\d{2})`,
      'i'
    );
    const match = text.match(regex);
    if (match) {
      return parseDate(match[1]);
    }
  }
  return null;
}

/**
 * Extract structured fields from payslip OCR text.
 */
export function extractPayslipFields(ocrText: string): PayslipFields {
  const lines = ocrText
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0);

  // Employer name: first substantive line that:
  // - is more than 2 chars
  // - not purely numeric
  // - not a date
  // - not starting with common field keywords
  let employer_name: string | null = null;
  for (const line of lines) {
    if (line.length <= 2) continue;
    if (/^\d+$/.test(line)) continue;
    if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(line)) continue;
    if (/^\d{4}-\d{2}-\d{2}$/.test(line)) continue;
    const lower = line.toLowerCase();
    const isFieldLine = FIELD_KEYWORDS.some(kw => lower.startsWith(kw));
    if (isFieldLine) continue;
    employer_name = line;
    break;
  }

  // Pay date
  const pay_date = extractDateNear(ocrText, ['pay date', 'check date', 'payment date']);

  // Pay period start and end
  let pay_period_start: string | null = null;
  let pay_period_end: string | null = null;
  const periodKeywords = ['pay period', 'period'];
  for (const kw of periodKeywords) {
    const escapedKw = escapeRegex(kw);
    const datePattern = `(\\d{1,2}\\/\\d{1,2}\\/\\d{4}|\\d{4}-\\d{2}-\\d{2})`;
    const regex = new RegExp(
      `${escapedKw}[\\s\\S]{0,80}?${datePattern}[\\s\\S]{0,20}-[\\s\\S]{0,20}${datePattern}`,
      'i'
    );
    const match = ocrText.match(regex);
    if (match) {
      pay_period_start = parseDate(match[1]);
      pay_period_end = parseDate(match[2]);
      break;
    }
  }

  // Gross pay — always positive
  const rawGross = extractAmountForLabel(ocrText, 'Gross Pay');
  const gross_pay = rawGross !== null ? Math.abs(rawGross) : null;

  // Net pay — always positive
  const rawNet = extractAmountForLabel(ocrText, 'Net Pay');
  const net_pay = rawNet !== null ? Math.abs(rawNet) : null;

  return { employer_name, pay_date, pay_period_start, pay_period_end, gross_pay, net_pay };
}

interface TemplateItem {
  category: PayslipLineItemCategory | string;
  label: string;
  normalized_label: string;
}

/**
 * Apply a payslip template to OCR text, returning line items with extracted amounts.
 * Sign convention:
 *   - earnings/reimbursement/employer_contribution → positive
 *   - tax/deduction → negative
 * Amount defaults to 0 if the label is not found.
 */
export function applyTemplateWithRegex(
  template: readonly TemplateItem[],
  ocrText: string
): PayslipLineItem[] {
  return template.map(item => {
    const raw = extractAmountForLabel(ocrText, item.label);
    let amount = raw ?? 0;

    const cat = item.category as PayslipLineItemCategory;
    if (cat === 'tax' || cat === 'deduction') {
      // Ensure negative (but keep 0 as +0, not -0)
      amount = amount === 0 ? 0 : -Math.abs(amount);
    } else {
      // Ensure positive for earnings / employer_contribution / reimbursement
      amount = Math.abs(amount);
    }

    return {
      category: cat,
      label: item.label,
      normalized_label: item.normalized_label,
      amount,
    };
  });
}

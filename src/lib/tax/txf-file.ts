/**
 * TXF (Tax Exchange Format) V042 file builder — pure, no I/O.
 *
 * Format assumptions (documented because the V042 spec is a de-facto
 * standard; this mirrors what GnuCash desktop and Quicken emit and what
 * TurboTax / TaxCut import):
 *
 *   - The file is plain ASCII text with CRLF ("\r\n") line endings.
 *   - It opens with a header record:
 *         V042            format version
 *         A<software>     exporting application name
 *         D<MM/DD/YYYY>   export date
 *         ^               record terminator
 *   - Every subsequent record is a sequence of single-letter-prefixed lines
 *     terminated by "^":
 *         TD              record type (detail record carrying an amount)
 *         N<code>         TXF reference number (e.g. N287)
 *         C1              copy number (copy 1 of the form)
 *         L1              line indicator
 *         $<amount>       amount: plain decimal, 2 places, no thousands
 *                         separators; negative as $-123.45
 *         P<payer>        optional payer/description line (payer-supported
 *                         codes only, e.g. 1099-INT/DIV payer names)
 *   - For payer-supported codes we emit ONE record PER SOURCE ACCOUNT with a
 *     P line naming the payer (the account's leaf name), matching how tax
 *     software builds per-payer 1099 worksheets. For all other codes we emit
 *     a single summary record with the code's total.
 *   - Zero-amount items are skipped entirely (tax software treats an
 *     explicit $0.00 record as a real entry).
 */

export interface TxfExportAccount {
  /** Colon-separated full account path; leaf segment is used as the payer. */
  path: string;
  amount: number;
}

export interface TxfExportItem {
  /** TXF reference number including the leading N, e.g. 'N287'. */
  code: string;
  /** Emit one per-account record with a P payer line instead of a summary. */
  payerSupported: boolean;
  total: number;
  accounts: TxfExportAccount[];
}

export interface TxfFileOptions {
  /** Exporting application name for the A header line. */
  software?: string;
  /** Export date for the D header line. Defaults to now. */
  date?: Date;
}

const CRLF = '\r\n';

/**
 * Format an amount for a TXF $ line: fixed 2 decimals, no thousands
 * separators, '-' prefix for negatives, and no negative zero.
 */
export function formatTxfAmount(amount: number): string {
  let value = Math.round(amount * 100) / 100;
  if (Object.is(value, -0) || value === 0) value = 0;
  return value.toFixed(2);
}

/** Format the D header date as MM/DD/YYYY. */
export function formatTxfDate(date: Date): string {
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${mm}/${dd}/${date.getFullYear()}`;
}

/**
 * Payer text for a P line: the leaf segment of the account path, with the
 * characters TXF readers treat as control text (^ and CR/LF) stripped.
 */
function payerFromPath(path: string): string {
  const leaf = path.split(':').pop() ?? path;
  return leaf.replace(/[\^\r\n]/g, ' ').trim();
}

function record(lines: string[]): string {
  return lines.join(CRLF) + CRLF + '^' + CRLF;
}

/**
 * Build a complete TXF V042 file from coded line items.
 * Pure: same inputs (+ fixed date) always produce byte-identical output.
 */
export function buildTxfFile(items: readonly TxfExportItem[], options: TxfFileOptions = {}): string {
  const software = options.software ?? 'GnuCash Web';
  const date = options.date ?? new Date();

  let out = record([`V042`, `A${software}`, `D${formatTxfDate(date)}`]);

  for (const item of items) {
    if (item.payerSupported) {
      for (const account of item.accounts) {
        if (Math.round(account.amount * 100) === 0) continue;
        out += record([
          'TD',
          item.code,
          'C1',
          'L1',
          `$${formatTxfAmount(account.amount)}`,
          `P${payerFromPath(account.path)}`,
        ]);
      }
    } else {
      if (Math.round(item.total * 100) === 0) continue;
      out += record([
        'TD',
        item.code,
        'C1',
        'L1',
        `$${formatTxfAmount(item.total)}`,
      ]);
    }
  }

  return out;
}

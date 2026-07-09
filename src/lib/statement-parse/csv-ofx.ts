/**
 * Deterministic statement parsers — PURE, no I/O, no DB.
 *
 * parseStatementCsv(text) and parseStatementOfx(text) both return a
 * ParsedStatement. Heavily unit-tested against messy real-world inputs.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * AMOUNT SIGN CONVENTION (shared with statement.service.ts / reconcile engine)
 * ─────────────────────────────────────────────────────────────────────────
 *   amount is SIGNED:
 *     • POSITIVE = money INTO the account   (deposit / credit)
 *     • NEGATIVE = money OUT of the account (withdrawal / debit)
 *   This matches the OFX TRNAMT convention.
 *
 * DATE AMBIGUITY: ISO (YYYY-MM-DD) and any format where the first numeric
 * component is > 12 (→ day-first) are parsed unambiguously. For a genuinely
 * ambiguous slashed date like 03/04/2024 we default to MM/DD/YYYY (US), the
 * dominant convention for the US bank/CC statements this app targets.
 */

export interface ParsedStatementLine {
  /** ISO 'YYYY-MM-DD'. */
  date: string;
  description: string;
  /** Signed: positive = into account, negative = out of account. */
  amount: number;
  runningBalance?: number;
}

export interface ParsedStatement {
  startDate?: string;
  endDate?: string;
  openingBalance?: number;
  closingBalance?: number;
  currency?: string;
  lines: ParsedStatementLine[];
}

// ===========================================================================
// Shared helpers
// ===========================================================================

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * Parse a wide variety of date strings into ISO 'YYYY-MM-DD', or null.
 * Handles: ISO, YYYY/MM/DD, slash/dash/dot numeric (MM/DD or DD/MM disambiguated
 * by value), OFX YYYYMMDD, and month-name forms ("Jan 5, 2024", "5 Jan 2024").
 */
export function parseStatementDate(raw: string): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;

  // ISO: YYYY-MM-DD (optionally with time)
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) {
    const y = +m[1], mo = +m[2], d = +m[3];
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return `${y}-${pad2(mo)}-${pad2(d)}`;
  }

  // YYYY/MM/DD or YYYY.MM.DD
  m = s.match(/^(\d{4})[/.](\d{1,2})[/.](\d{1,2})/);
  if (m) {
    const y = +m[1], mo = +m[2], d = +m[3];
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return `${y}-${pad2(mo)}-${pad2(d)}`;
  }

  // Compact OFX: YYYYMMDD (possibly followed by time/timezone). ISO and
  // slashed forms are handled above, so an 8+ digit run here is unambiguous.
  m = s.match(/^(\d{4})(\d{2})(\d{2})(\d|$|[^\d/.\-])/);
  if (m) {
    const y = +m[1], mo = +m[2], d = +m[3];
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return `${y}-${pad2(mo)}-${pad2(d)}`;
  }

  // Numeric with separators: a/b/c (day/month/year in some order)
  m = s.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})/);
  if (m) {
    const a = +m[1];
    const b = +m[2];
    let y = +m[3];
    if (m[3].length === 2) y += y < 70 ? 2000 : 1900;
    let mo: number, d: number;
    if (a > 12 && b <= 12) {
      // day-first (DD/MM)
      d = a; mo = b;
    } else if (b > 12 && a <= 12) {
      // month-first (MM/DD)
      mo = a; d = b;
    } else {
      // ambiguous → default MM/DD (US)
      mo = a; d = b;
    }
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return `${y}-${pad2(mo)}-${pad2(d)}`;
  }

  // Month name forms: "Jan 5, 2024" / "January 5 2024"
  m = s.match(/^([A-Za-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})/);
  if (m) {
    const mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
    const d = +m[2];
    const y = +m[3];
    if (mo && d >= 1 && d <= 31) return `${y}-${pad2(mo)}-${pad2(d)}`;
  }

  // "5 Jan 2024" / "05-Jan-2024"
  m = s.match(/^(\d{1,2})[\s-]+([A-Za-z]{3,})\.?[\s-]+(\d{2,4})/);
  if (m) {
    const d = +m[1];
    const mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
    let y = +m[3];
    if (m[3].length === 2) y += y < 70 ? 2000 : 1900;
    if (mo && d >= 1 && d <= 31) return `${y}-${pad2(mo)}-${pad2(d)}`;
  }

  return null;
}

/**
 * Parse a monetary string into a number, or null.
 * Strips currency symbols, thousands separators, and whitespace. Treats
 * parentheses and a trailing/leading 'DR'/'CR' as sign hints:
 *   (123.45) → -123.45,   "123.45 DR" → -123.45,   "123.45 CR" → 123.45
 */
export function parseStatementAmount(raw: string | undefined | null): number | null {
  if (raw === undefined || raw === null) return null;
  let s = String(raw).trim();
  if (!s) return null;

  let sign = 1;

  // Parenthesized negatives
  if (/^\(.*\)$/.test(s)) {
    sign = -1;
    s = s.slice(1, -1);
  }

  // DR/CR suffix or prefix
  if (/(^|\s)dr\b/i.test(s)) sign = -1;
  else if (/(^|\s)cr\b/i.test(s)) sign = 1;
  s = s.replace(/\b[dc]r\b/gi, '');

  // Explicit leading minus
  if (s.trim().startsWith('-')) sign = -1;

  // Strip everything except digits, dot, comma, minus
  s = s.replace(/[^0-9.,-]/g, '');
  if (!s || s === '-' || s === '.' ) return null;

  // Normalize thousands/decimal separators.
  // If both ',' and '.' present, the last one is the decimal separator.
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma !== -1 && lastDot !== -1) {
    if (lastComma > lastDot) {
      // European: 1.234,56 → 1234.56
      s = s.replace(/\./g, '').replace(',', '.');
    } else {
      // US: 1,234.56 → 1234.56
      s = s.replace(/,/g, '');
    }
  } else if (lastComma !== -1) {
    // Only commas. If it looks like a decimal (one comma, <=2 trailing digits) treat as decimal.
    const parts = s.split(',');
    if (parts.length === 2 && parts[1].length <= 2) {
      s = parts[0] + '.' + parts[1];
    } else {
      s = s.replace(/,/g, '');
    }
  }

  s = s.replace(/-/g, '');
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return sign * n;
}

// ===========================================================================
// CSV
// ===========================================================================

/** Parse a single CSV line respecting quoted fields (RFC-4180-ish). */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields.map((f) => f.trim());
}

/** Split CSV content into logical rows (quoted fields may span newlines). */
function splitCsvRows(content: string): string[] {
  const rows: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
    } else if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (ch === '\r' && content[i + 1] === '\n') i++;
      if (current.trim().length > 0) rows.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim().length > 0) rows.push(current);
  return rows;
}

interface ColumnMap {
  date: number;
  description: number;
  amount: number;
  debit: number;
  credit: number;
  balance: number;
  currency: number;
}

function findColumns(header: string[]): ColumnMap {
  const h = header.map((c) => c.toLowerCase().trim());
  const find = (pred: (c: string) => boolean) => h.findIndex(pred);

  // date: prefer "transaction date"/"posted date"/"date", never a "time" column alone
  let date = find((c) => c === 'date' || c === 'transaction date' || c === 'posted date' || c === 'post date');
  if (date === -1) date = find((c) => c.includes('date'));

  const description = find(
    (c) =>
      !c.includes('date') &&
      (c.includes('description') || c.includes('payee') || c === 'name' ||
        c.includes('memo') || c.includes('details') || c.includes('narrative') ||
        c.includes('reference') || c === 'transaction' || c.includes('particulars')),
  );

  const amount = find(
    (c) => !c.includes('balance') && (c === 'amount' || c.includes('amount') || c === 'value'),
  );

  const debit = find(
    (c) => c === 'debit' || c.includes('withdrawal') || c === 'debit amount' || c.includes('paid out') || c.includes('money out'),
  );
  const credit = find(
    (c) => c === 'credit' || c.includes('deposit') || c === 'credit amount' || c.includes('paid in') || c.includes('money in'),
  );

  const balance = find((c) => c.includes('balance'));
  const currency = find((c) => c === 'currency' || c === 'ccy');

  return { date, description, amount, debit, credit, balance, currency };
}

/**
 * Parse a bank/credit-card CSV export.
 *
 * Auto-detects columns from the header row (date / description / amount, OR
 * separate debit + credit columns). Falls back to a headerless
 * [date, description, amount] layout if the first cell of the first row is a
 * parseable date and no header keywords are found.
 */
export function parseStatementCsv(text: string): ParsedStatement {
  const clean = text.replace(/^﻿/, ''); // strip BOM
  const rows = splitCsvRows(clean);
  if (rows.length === 0) return { lines: [] };

  const firstCells = parseCsvLine(rows[0]);
  let cols = findColumns(firstCells);
  let dataStart = 1;
  let currency: string | undefined;

  const hasHeader =
    cols.date !== -1 && (cols.amount !== -1 || cols.debit !== -1 || cols.credit !== -1);

  if (!hasHeader) {
    // Maybe headerless: [date, description, amount]
    if (firstCells.length >= 3 && parseStatementDate(firstCells[0])) {
      cols = { date: 0, description: 1, amount: 2, debit: -1, credit: -1, balance: -1, currency: -1 };
      dataStart = 0;
    } else {
      // Unrecognized — nothing we can do deterministically.
      return { lines: [] };
    }
  }

  const lines: ParsedStatementLine[] = [];
  for (let r = dataStart; r < rows.length; r++) {
    const cells = parseCsvLine(rows[r]);
    if (cells.length === 0) continue;

    const dateRaw = cols.date >= 0 ? cells[cols.date] : '';
    const date = parseStatementDate(dateRaw ?? '');
    if (!date) continue; // skip non-transaction rows (totals, blanks, sub-headers)

    let amount: number | null = null;
    if (cols.amount >= 0 && cells[cols.amount]) {
      amount = parseStatementAmount(cells[cols.amount]);
    }
    if (amount === null && (cols.debit >= 0 || cols.credit >= 0)) {
      const debit = cols.debit >= 0 ? parseStatementAmount(cells[cols.debit]) : null;
      const credit = cols.credit >= 0 ? parseStatementAmount(cells[cols.credit]) : null;
      if (debit !== null || credit !== null) {
        // credit = into account (+), debit = out (-). Use magnitudes.
        amount = (credit !== null ? Math.abs(credit) : 0) - (debit !== null ? Math.abs(debit) : 0);
      }
    }
    if (amount === null) continue; // no usable amount

    const description = cols.description >= 0 ? (cells[cols.description] ?? '').trim() : '';

    const line: ParsedStatementLine = { date, description, amount };
    if (cols.balance >= 0) {
      const bal = parseStatementAmount(cells[cols.balance]);
      if (bal !== null) line.runningBalance = bal;
    }
    if (!currency && cols.currency >= 0 && cells[cols.currency]) {
      currency = cells[cols.currency].trim().toUpperCase();
    }
    lines.push(line);
  }

  const result: ParsedStatement = { lines };
  if (currency) result.currency = currency;
  if (lines.length > 0) {
    // Sort ascending by date to derive statement period.
    const dates = lines.map((l) => l.date).sort();
    result.startDate = dates[0];
    result.endDate = dates[dates.length - 1];
    // If running balance present, use last row's balance as closing.
    const withBal = lines.filter((l) => l.runningBalance !== undefined);
    if (withBal.length > 0) {
      result.closingBalance = withBal[withBal.length - 1].runningBalance;
    }
  }
  return result;
}

// ===========================================================================
// OFX / QFX
// ===========================================================================

/** Read the first value of an SGML/XML tag (handles unclosed SGML tags). */
function ofxTag(block: string, tag: string): string | undefined {
  // Matches <TAG>value  (value ends at next '<', CR, or LF) — works for both
  // SGML (unclosed) and XML (<TAG>value</TAG>) forms.
  const re = new RegExp(`<${tag}>([^<\r\n]*)`, 'i');
  const m = block.match(re);
  if (!m) return undefined;
  const v = m[1].trim();
  return v.length > 0 ? v : undefined;
}

function decodeOfxEntities(s: string): string {
  return s
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d));
}

/**
 * Parse an OFX/QFX statement (SGML or XML variants).
 *
 * Extracts STMTTRN blocks (DTPOSTED, TRNAMT, NAME/MEMO), the statement period
 * (BANKTRANLIST DTSTART/DTEND), ledger balance (LEDGERBAL), and default
 * currency (CURDEF). TRNAMT is already signed per our convention
 * (positive = credit/into account).
 */
export function parseStatementOfx(text: string): ParsedStatement {
  const result: ParsedStatement = { lines: [] };
  if (!text) return result;

  const currency = ofxTag(text, 'CURDEF');
  if (currency) result.currency = currency.toUpperCase();

  // Statement period from the transaction list envelope.
  const listMatch = text.match(/<BANKTRANLIST>([\s\S]*?)<\/BANKTRANLIST>/i);
  const listHeader = listMatch ? listMatch[1] : text;
  const dtStart = ofxTag(listHeader, 'DTSTART');
  const dtEnd = ofxTag(listHeader, 'DTEND');
  if (dtStart) {
    const d = parseStatementDate(dtStart);
    if (d) result.startDate = d;
  }
  if (dtEnd) {
    const d = parseStatementDate(dtEnd);
    if (d) result.endDate = d;
  }

  // Ledger balance → closing balance (+ as-of date fills end date if missing).
  const ledgerMatch = text.match(/<LEDGERBAL>([\s\S]*?)<\/LEDGERBAL>/i);
  if (ledgerMatch) {
    const bal = parseStatementAmount(ofxTag(ledgerMatch[1], 'BALAMT'));
    if (bal !== null) result.closingBalance = bal;
    if (!result.endDate) {
      const asOf = ofxTag(ledgerMatch[1], 'DTASOF');
      if (asOf) {
        const d = parseStatementDate(asOf);
        if (d) result.endDate = d;
      }
    }
  }

  // Transactions.
  const txnRe = /<STMTTRN>([\s\S]*?)<\/STMTTRN>/gi;
  let m: RegExpExecArray | null;
  while ((m = txnRe.exec(text)) !== null) {
    const block = m[1];
    const dateRaw = ofxTag(block, 'DTPOSTED') ?? ofxTag(block, 'DTUSER');
    const date = dateRaw ? parseStatementDate(dateRaw) : null;
    const amount = parseStatementAmount(ofxTag(block, 'TRNAMT'));
    if (!date || amount === null) continue;

    const name = ofxTag(block, 'NAME');
    const memo = ofxTag(block, 'MEMO');
    let description = '';
    if (name && memo && name !== memo) description = `${name} ${memo}`;
    else description = name ?? memo ?? '';
    description = decodeOfxEntities(description).trim();

    result.lines.push({ date, description, amount });
  }

  // Derive period from transactions if the envelope didn't supply it.
  if (result.lines.length > 0) {
    const dates = result.lines.map((l) => l.date).sort();
    if (!result.startDate) result.startDate = dates[0];
    if (!result.endDate) result.endDate = dates[dates.length - 1];
  }

  return result;
}

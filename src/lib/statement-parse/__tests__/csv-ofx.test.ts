import { describe, it, expect } from 'vitest';
import {
  parseStatementCsv,
  parseStatementOfx,
  parseStatementDate,
  parseStatementAmount,
} from '../csv-ofx';

describe('parseStatementDate', () => {
  it('parses ISO dates unambiguously', () => {
    expect(parseStatementDate('2024-03-05')).toBe('2024-03-05');
    expect(parseStatementDate('2024-3-5')).toBe('2024-03-05');
    expect(parseStatementDate('2024-01-31T00:00:00Z')).toBe('2024-01-31');
  });

  it('parses YYYY/MM/DD', () => {
    expect(parseStatementDate('2024/03/05')).toBe('2024-03-05');
  });

  it('parses OFX compact YYYYMMDD (with trailing time)', () => {
    expect(parseStatementDate('20240305')).toBe('2024-03-05');
    expect(parseStatementDate('20240305120000.000[-5:EST]')).toBe('2024-03-05');
  });

  it('disambiguates day-first when first component > 12', () => {
    expect(parseStatementDate('25/12/2024')).toBe('2024-12-25');
    expect(parseStatementDate('13/01/2024')).toBe('2024-01-13');
  });

  it('disambiguates month-first when second component > 12', () => {
    expect(parseStatementDate('03/25/2024')).toBe('2024-03-25');
  });

  it('defaults ambiguous slashed dates to MM/DD (US)', () => {
    expect(parseStatementDate('03/04/2024')).toBe('2024-03-04');
  });

  it('handles 2-digit years', () => {
    expect(parseStatementDate('03/04/24')).toBe('2024-03-04');
    expect(parseStatementDate('03/04/99')).toBe('1999-03-04');
  });

  it('parses month-name forms', () => {
    expect(parseStatementDate('Jan 5, 2024')).toBe('2024-01-05');
    expect(parseStatementDate('January 5 2024')).toBe('2024-01-05');
    expect(parseStatementDate('5 Jan 2024')).toBe('2024-01-05');
    expect(parseStatementDate('05-Jan-2024')).toBe('2024-01-05');
  });

  it('returns null for garbage', () => {
    expect(parseStatementDate('')).toBeNull();
    expect(parseStatementDate('not a date')).toBeNull();
    expect(parseStatementDate('99/99/9999')).toBeNull();
  });
});

describe('parseStatementAmount', () => {
  it('parses plain and signed numbers', () => {
    expect(parseStatementAmount('123.45')).toBe(123.45);
    expect(parseStatementAmount('-123.45')).toBe(-123.45);
    expect(parseStatementAmount('0')).toBe(0);
  });

  it('strips currency symbols and thousands separators (US)', () => {
    expect(parseStatementAmount('$1,234.56')).toBe(1234.56);
    expect(parseStatementAmount('USD 1,234.56')).toBe(1234.56);
  });

  it('handles European decimal comma', () => {
    expect(parseStatementAmount('1.234,56')).toBe(1234.56);
    expect(parseStatementAmount('1234,56')).toBe(1234.56);
  });

  it('treats parentheses as negative', () => {
    expect(parseStatementAmount('(123.45)')).toBe(-123.45);
    expect(parseStatementAmount('($1,000.00)')).toBe(-1000);
  });

  it('honors DR/CR suffixes', () => {
    expect(parseStatementAmount('123.45 DR')).toBe(-123.45);
    expect(parseStatementAmount('123.45 CR')).toBe(123.45);
  });

  it('returns null for empty/garbage', () => {
    expect(parseStatementAmount('')).toBeNull();
    expect(parseStatementAmount(null)).toBeNull();
    expect(parseStatementAmount('abc')).toBeNull();
  });
});

describe('parseStatementCsv — single amount column', () => {
  it('parses a standard date/description/amount CSV', () => {
    const csv = [
      'Date,Description,Amount',
      '2024-03-01,Paycheck,2500.00',
      '2024-03-02,Grocery Store,-84.20',
      '2024-03-03,Coffee Shop,-4.50',
    ].join('\n');
    const result = parseStatementCsv(csv);
    expect(result.lines).toHaveLength(3);
    expect(result.lines[0]).toMatchObject({ date: '2024-03-01', description: 'Paycheck', amount: 2500 });
    expect(result.lines[1].amount).toBe(-84.2); // out of account stays negative
    expect(result.startDate).toBe('2024-03-01');
    expect(result.endDate).toBe('2024-03-03');
  });

  it('handles quoted fields with embedded commas', () => {
    const csv = [
      'Date,Description,Amount',
      '2024-03-01,"ACME, Inc. Payment",1200.00',
    ].join('\n');
    const result = parseStatementCsv(csv);
    expect(result.lines[0].description).toBe('ACME, Inc. Payment');
    expect(result.lines[0].amount).toBe(1200);
  });

  it('strips a BOM and picks running balance', () => {
    const csv = '﻿Date,Description,Amount,Balance\n2024-03-01,Deposit,100.00,1100.00\n';
    const result = parseStatementCsv(csv);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0].runningBalance).toBe(1100);
    expect(result.closingBalance).toBe(1100);
  });
});

describe('parseStatementCsv — debit/credit columns', () => {
  it('combines separate debit and credit columns into a signed amount', () => {
    const csv = [
      'Transaction Date,Description,Debit,Credit',
      '03/01/2024,Salary,,2500.00',
      '03/02/2024,Rent,1200.00,',
      '03/03/2024,Refund,,45.00',
    ].join('\n');
    const result = parseStatementCsv(csv);
    expect(result.lines).toHaveLength(3);
    expect(result.lines[0].amount).toBe(2500);   // credit → into account (+)
    expect(result.lines[1].amount).toBe(-1200);  // debit → out of account (-)
    expect(result.lines[2].amount).toBe(45);
  });

  it('handles withdrawal/deposit header aliases', () => {
    const csv = [
      'Date,Details,Withdrawals,Deposits,Balance',
      '2024-03-01,Opening deposit,,500.00,500.00',
      '2024-03-02,ATM,100.00,,400.00',
    ].join('\n');
    const result = parseStatementCsv(csv);
    expect(result.lines[0].amount).toBe(500);
    expect(result.lines[1].amount).toBe(-100);
    expect(result.lines[1].runningBalance).toBe(400);
  });
});

describe('parseStatementCsv — edge cases', () => {
  it('skips non-transaction rows (totals, blanks, sub-headers)', () => {
    const csv = [
      'Date,Description,Amount',
      '2024-03-01,Deposit,100.00',
      ',Subtotal,100.00',
      'Total,,100.00',
      '',
      '2024-03-05,Fee,-2.00',
    ].join('\n');
    const result = parseStatementCsv(csv);
    expect(result.lines).toHaveLength(2);
    expect(result.lines.map((l) => l.date)).toEqual(['2024-03-01', '2024-03-05']);
  });

  it('supports a headerless date,description,amount layout', () => {
    const csv = ['2024-03-01,Paycheck,2500.00', '2024-03-02,Store,-30.00'].join('\n');
    const result = parseStatementCsv(csv);
    expect(result.lines).toHaveLength(2);
    expect(result.lines[0].amount).toBe(2500);
  });

  it('returns empty for garbage / unrecognized content', () => {
    expect(parseStatementCsv('').lines).toHaveLength(0);
    expect(parseStatementCsv('just some random text\nwith no structure').lines).toHaveLength(0);
  });
});

describe('parseStatementOfx', () => {
  const OFX_SGML = `OFXHEADER:100
DATA:OFXSGML
VERSION:102

<OFX>
<BANKMSGSRSV1>
<STMTTRNRS>
<STMTRS>
<CURDEF>USD
<BANKACCTFROM>
<ACCTID>123456789
</BANKACCTFROM>
<BANKTRANLIST>
<DTSTART>20240301
<DTEND>20240331
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20240301120000
<TRNAMT>2500.00
<FITID>001
<NAME>ACME PAYROLL
</STMTTRN>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20240302
<TRNAMT>-84.20
<NAME>GROCERY STORE
<MEMO>Card purchase
</STMTTRN>
</BANKTRANLIST>
<LEDGERBAL>
<BALAMT>2415.80
<DTASOF>20240331
</LEDGERBAL>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>`;

  it('parses SGML STMTTRN blocks with sign convention', () => {
    const result = parseStatementOfx(OFX_SGML);
    expect(result.lines).toHaveLength(2);
    expect(result.lines[0]).toMatchObject({
      date: '2024-03-01',
      description: 'ACME PAYROLL',
      amount: 2500,
    });
    // TRNAMT negative → money out of account
    expect(result.lines[1].amount).toBe(-84.2);
    expect(result.lines[1].description).toBe('GROCERY STORE Card purchase');
  });

  it('extracts period, currency, and closing balance', () => {
    const result = parseStatementOfx(OFX_SGML);
    expect(result.currency).toBe('USD');
    expect(result.startDate).toBe('2024-03-01');
    expect(result.endDate).toBe('2024-03-31');
    expect(result.closingBalance).toBe(2415.8);
  });

  it('parses XML-style OFX (closed tags)', () => {
    const xml = `<OFX><STMTTRN><DTPOSTED>20240115</DTPOSTED><TRNAMT>-19.99</TRNAMT><NAME>Netflix</NAME></STMTTRN></OFX>`;
    const result = parseStatementOfx(xml);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toMatchObject({ date: '2024-01-15', description: 'Netflix', amount: -19.99 });
  });

  it('decodes SGML entities in descriptions', () => {
    const ofx = `<OFX><STMTTRN><DTPOSTED>20240115<TRNAMT>-5.00<NAME>Tea &amp; Coffee</NAME></STMTTRN></OFX>`;
    const result = parseStatementOfx(ofx);
    expect(result.lines[0].description).toBe('Tea & Coffee');
  });

  it('returns empty for garbage / empty input', () => {
    expect(parseStatementOfx('').lines).toHaveLength(0);
    expect(parseStatementOfx('not ofx at all').lines).toHaveLength(0);
  });
});

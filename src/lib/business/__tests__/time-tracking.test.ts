/**
 * Time tracking — pure-logic tests (DB-free).
 *
 * Covers:
 *   - minutes -> hours conversion and per-entry amount math
 *   - timer elapsed-minutes computation
 *   - unbilled aggregation per customer/job (totals, missing-rate counting,
 *     exclusion of customer-less entries, sorting)
 *   - invoice-line generation math (hours x rate, description shape,
 *     rate/minutes validation)
 */

import { describe, it, expect } from 'vitest';
import {
  minutesToHours,
  entryAmount,
  computeElapsedMinutes,
  summarizeUnbilled,
  buildInvoiceEntryInputs,
  TimeTrackingValidationError,
  type UnbilledEntryLike,
} from '../time-tracking.service';

function entry(overrides: Partial<UnbilledEntryLike> & { id: number }): UnbilledEntryLike {
  return {
    customerGuid: 'c'.repeat(32),
    customerName: 'Acme Corp',
    jobGuid: null,
    jobName: null,
    entryDate: '2026-07-01',
    minutes: 60,
    rate: 100,
    description: 'Consulting',
    ...overrides,
  };
}

describe('minutesToHours / entryAmount', () => {
  it('converts minutes to decimal hours rounded to 2 places', () => {
    expect(minutesToHours(60)).toBe(1);
    expect(minutesToHours(90)).toBe(1.5);
    expect(minutesToHours(50)).toBe(0.83); // 0.8333 -> 0.83
    expect(minutesToHours(0)).toBe(0);
  });

  it('computes hours x rate rounded to cents', () => {
    expect(entryAmount(90, 100)).toBe(150);
    expect(entryAmount(50, 120)).toBe(99.6); // 0.83h x 120
    expect(entryAmount(45, 85)).toBe(63.75);
  });

  it('returns null when the rate is unset', () => {
    expect(entryAmount(60, null)).toBeNull();
  });
});

describe('computeElapsedMinutes', () => {
  const t0 = new Date('2026-07-16T09:00:00Z');

  it('never returns less than one minute', () => {
    expect(computeElapsedMinutes(t0, new Date('2026-07-16T09:00:05Z'))).toBe(1);
    expect(computeElapsedMinutes(t0, t0)).toBe(1);
  });

  it('rounds to the nearest whole minute', () => {
    expect(computeElapsedMinutes(t0, new Date('2026-07-16T09:01:31Z'))).toBe(2);
    expect(computeElapsedMinutes(t0, new Date('2026-07-16T09:02:29Z'))).toBe(2);
    expect(computeElapsedMinutes(t0, new Date('2026-07-16T10:00:00Z'))).toBe(60);
  });
});

describe('summarizeUnbilled', () => {
  const CUST_A = 'a'.repeat(32);
  const CUST_B = 'b'.repeat(32);
  const JOB_1 = '1'.repeat(32);

  it('groups entries per customer with per-job subtotals', () => {
    const groups = summarizeUnbilled([
      entry({ id: 1, customerGuid: CUST_A, customerName: 'Acme', minutes: 60, rate: 100 }),
      entry({ id: 2, customerGuid: CUST_A, customerName: 'Acme', minutes: 90, rate: 100, jobGuid: JOB_1, jobName: 'Website' }),
      entry({ id: 3, customerGuid: CUST_B, customerName: 'Zenith', minutes: 30, rate: 200 }),
    ]);

    expect(groups).toHaveLength(2);
    const [acme, zenith] = groups; // sorted by customer name
    expect(acme.customerName).toBe('Acme');
    expect(acme.minutes).toBe(150);
    expect(acme.hours).toBe(2.5);
    expect(acme.amount).toBe(250); // 1h + 1.5h at $100
    expect(acme.entries).toHaveLength(2);
    expect(acme.jobs).toHaveLength(2); // no-job bucket + Website

    const website = acme.jobs.find((j) => j.jobGuid === JOB_1)!;
    expect(website.minutes).toBe(90);
    expect(website.hours).toBe(1.5);
    expect(website.amount).toBe(150);
    expect(website.entryCount).toBe(1);

    expect(zenith.amount).toBe(100); // 0.5h x 200
  });

  it('counts entries without a rate instead of adding them to the amount', () => {
    const groups = summarizeUnbilled([
      entry({ id: 1, minutes: 60, rate: 100 }),
      entry({ id: 2, minutes: 120, rate: null }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].amount).toBe(100);
    expect(groups[0].minutes).toBe(180); // hours still counted
    expect(groups[0].missingRateCount).toBe(1);
  });

  it('excludes entries with no customer (cannot be invoiced)', () => {
    const groups = summarizeUnbilled([
      entry({ id: 1, customerGuid: null, customerName: null }),
      entry({ id: 2 }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].entries.map((e) => e.id)).toEqual([2]);
  });

  it('avoids floating point drift when summing amounts', () => {
    // 10 x (0.17h x $33) = 10 x 5.61
    const groups = summarizeUnbilled(
      Array.from({ length: 10 }, (_, i) => entry({ id: i + 1, minutes: 10, rate: 33 })),
    );
    expect(groups[0].amount).toBe(56.1);
  });
});

describe('buildInvoiceEntryInputs', () => {
  it('produces one line per entry with quantity = hours and price = rate', () => {
    const lines = buildInvoiceEntryInputs([
      entry({ id: 1, minutes: 90, rate: 125, entryDate: '2026-07-02', description: 'Design review' }),
      entry({ id: 2, minutes: 30, rate: 125, entryDate: '2026-07-03', jobName: 'Website', description: '' }),
    ]);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      description: '2026-07-02 — Design review',
      action: 'Hours',
      date: '2026-07-02',
      quantity: 1.5,
      price: 125,
    });
    // Empty descriptions fall back to 'Time'; the job name is included.
    expect(lines[1].description).toBe('2026-07-03 — Website — Time');
    expect(lines[1].quantity).toBe(0.5);
  });

  it('line totals equal the unbilled amounts (quantity x price)', () => {
    const source = [
      entry({ id: 1, minutes: 50, rate: 120 }),
      entry({ id: 2, minutes: 45, rate: 85 }),
    ];
    const lines = buildInvoiceEntryInputs(source);
    const lineTotal = lines.reduce((s, l) => s + Math.round(l.quantity * l.price * 100) / 100, 0);
    const unbilled = summarizeUnbilled(source)[0];
    expect(Math.round(lineTotal * 100) / 100).toBe(unbilled.amount);
  });

  it('rejects entries without a rate', () => {
    expect(() => buildInvoiceEntryInputs([entry({ id: 7, rate: null })])).toThrow(
      TimeTrackingValidationError,
    );
  });

  it('rejects entries with no recorded time', () => {
    expect(() => buildInvoiceEntryInputs([entry({ id: 8, minutes: 0 })])).toThrow(
      TimeTrackingValidationError,
    );
  });
});

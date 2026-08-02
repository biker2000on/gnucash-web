/**
 * 1099-NEC compliance engine — pure-logic tests with a frozen asOf date.
 *
 *   - filingDueDate / daysUntilFilingDue: Jan 31 arithmetic, past and future.
 *   - evaluateVendor1099Compliance: status precedence (filed > exempt >
 *     below_threshold > overdue > ready_to_file > awaiting_w9 > missing_w9),
 *     the inclusive $600 boundary, and 2dp rounding.
 *   - summarizeVendor1099Compliance: reportable/filed/missing-W-9 rollups
 *     and paid-descending sorting.
 */

import { describe, it, expect } from 'vitest';
import {
    NEC_THRESHOLD,
    daysUntilFilingDue,
    deriveW9State,
    evaluateVendor1099Compliance,
    filingDueDate,
    summarizeVendor1099Compliance,
    type Vendor1099ComplianceInput,
} from '../vendor-1099-compliance';

const ASOF = new Date('2026-08-01T12:00:00Z');

const vendor = (overrides: Partial<Vendor1099ComplianceInput> = {}): Vendor1099ComplianceInput => ({
    vendorGuid: 'a'.repeat(32),
    name: 'Plumber LLC',
    totalPaid: 1500,
    exemptFrom1099: false,
    w9Received: false,
    w9RequestedDate: null,
    tinOnFile: false,
    filedDate: null,
    ...overrides,
});

/* ------------------------------------------------------------------ */
/* Due-date arithmetic                                                  */
/* ------------------------------------------------------------------ */

describe('filingDueDate / daysUntilFilingDue', () => {
    it('is Jan 31 of the year after the tax year', () => {
        expect(filingDueDate(2025)).toBe('2026-01-31');
        expect(filingDueDate(2026)).toBe('2027-01-31');
    });

    it('counts whole days until the end of the due date', () => {
        expect(daysUntilFilingDue(2026, ASOF)).toBe(184);
        expect(daysUntilFilingDue(2025, ASOF)).toBe(-181);
        // Exactly 60 days out — the warning boundary used by the Action Center.
        expect(daysUntilFilingDue(2026, new Date('2026-12-03T12:00:00Z'))).toBe(60);
    });
});

/* ------------------------------------------------------------------ */
/* deriveW9State                                                        */
/* ------------------------------------------------------------------ */

describe('deriveW9State', () => {
    it('received beats requested beats missing', () => {
        expect(deriveW9State({ w9Received: true, w9RequestedDate: '2026-01-05' })).toBe('received');
        expect(deriveW9State({ w9Received: false, w9RequestedDate: '2026-01-05' })).toBe('requested');
        expect(deriveW9State({ w9Received: false, w9RequestedDate: null })).toBe('missing');
    });
});

/* ------------------------------------------------------------------ */
/* evaluateVendor1099Compliance                                         */
/* ------------------------------------------------------------------ */

describe('evaluateVendor1099Compliance', () => {
    it('spreads the input into the output with derived fields', () => {
        const row = evaluateVendor1099Compliance(2026, vendor({ totalPaid: 1234.567 }), ASOF);
        expect(row).toMatchObject({
            vendorGuid: 'a'.repeat(32),
            name: 'Plumber LLC',
            totalPaid: 1234.57,
            taxYear: 2026,
            overThreshold: true,
            requiresFiling: true,
            w9State: 'missing',
            filingDueDate: '2027-01-31',
            daysUntilDue: 184,
            status: 'missing_w9',
        });
    });

    it('treats the $600 threshold as inclusive', () => {
        expect(evaluateVendor1099Compliance(2026, vendor({ totalPaid: NEC_THRESHOLD }), ASOF).overThreshold).toBe(true);
        const below = evaluateVendor1099Compliance(2026, vendor({ totalPaid: 599.99 }), ASOF);
        expect(below.overThreshold).toBe(false);
        expect(below.requiresFiling).toBe(false);
        expect(below.status).toBe('below_threshold');
    });

    it('filed wins over everything', () => {
        const row = evaluateVendor1099Compliance(
            2025,
            vendor({ filedDate: '2026-01-20', exemptFrom1099: true, totalPaid: 50 }),
            ASOF,
        );
        expect(row.status).toBe('filed');
    });

    it('exempt wins over threshold and W-9 state', () => {
        const row = evaluateVendor1099Compliance(
            2026,
            vendor({ exemptFrom1099: true, totalPaid: 50_000 }),
            ASOF,
        );
        expect(row.status).toBe('exempt');
        expect(row.requiresFiling).toBe(false);
    });

    it('flags overdue for reportable, unfiled vendors past Jan 31', () => {
        const row = evaluateVendor1099Compliance(2025, vendor({ w9Received: true }), ASOF);
        expect(row.status).toBe('overdue');
        expect(row.daysUntilDue).toBe(-181);
    });

    it('splits ready_to_file / awaiting_w9 / missing_w9 before the deadline', () => {
        expect(evaluateVendor1099Compliance(2026, vendor({ w9Received: true }), ASOF).status)
            .toBe('ready_to_file');
        expect(evaluateVendor1099Compliance(2026, vendor({ w9RequestedDate: '2026-07-01' }), ASOF).status)
            .toBe('awaiting_w9');
        expect(evaluateVendor1099Compliance(2026, vendor(), ASOF).status).toBe('missing_w9');
    });
});

/* ------------------------------------------------------------------ */
/* summarizeVendor1099Compliance                                        */
/* ------------------------------------------------------------------ */

describe('summarizeVendor1099Compliance', () => {
    const G1 = 'a'.repeat(32);
    const G2 = 'b'.repeat(32);
    const G3 = 'c'.repeat(32);
    const G4 = 'd'.repeat(32);
    const G5 = 'e'.repeat(32);

    it('rolls up filing-season totals for the year', () => {
        const summary = summarizeVendor1099Compliance(
            2025,
            [
                vendor({ vendorGuid: G1, name: 'Filed LLC', totalPaid: 5000, w9Received: true, filedDate: '2026-01-20' }),
                vendor({ vendorGuid: G2, name: 'Unfiled Design', totalPaid: 800, w9Received: true }),
                vendor({ vendorGuid: G3, name: 'No W-9 Yet', totalPaid: 1200.5, w9RequestedDate: '2025-12-01' }),
                vendor({ vendorGuid: G4, name: 'Acme S-Corp', totalPaid: 9000, exemptFrom1099: true }),
                vendor({ vendorGuid: G5, name: 'Tiny Vendor', totalPaid: 200 }),
            ],
            ASOF,
        );

        expect(summary.taxYear).toBe(2025);
        expect(summary.asOfDate).toBe('2026-08-01');
        expect(summary.filingDueDate).toBe('2026-01-31');
        expect(summary.daysUntilDue).toBe(-181);
        expect(summary.reportableCount).toBe(3);
        expect(summary.filedCount).toBe(1);
        expect(summary.unfiledCount).toBe(2);
        expect(summary.missingW9Count).toBe(1);
        expect(summary.unfiledTotal).toBe(2000.5);
        // Paid descending with name tiebreak.
        expect(summary.rows.map(row => row.vendorGuid)).toEqual([G4, G1, G3, G2, G5]);
        const byGuid = new Map(summary.rows.map(row => [row.vendorGuid, row]));
        expect(byGuid.get(G1)?.status).toBe('filed');
        expect(byGuid.get(G2)?.status).toBe('overdue');
        expect(byGuid.get(G3)?.status).toBe('overdue');
        expect(byGuid.get(G3)?.w9State).toBe('requested');
        expect(byGuid.get(G4)?.status).toBe('exempt');
        expect(byGuid.get(G5)?.status).toBe('below_threshold');
    });

    it('returns an empty rollup when there are no vendors', () => {
        const summary = summarizeVendor1099Compliance(2026, [], ASOF);
        expect(summary.rows).toEqual([]);
        expect(summary.reportableCount).toBe(0);
        expect(summary.unfiledCount).toBe(0);
        expect(summary.unfiledTotal).toBe(0);
        expect(summary.filingDueDate).toBe('2027-01-31');
        expect(summary.daysUntilDue).toBe(184);
    });
});

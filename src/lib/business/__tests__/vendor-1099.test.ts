/**
 * 1099-NEC tracker — pure-logic tests.
 *
 *   - derive1099Status precedence: exempt > below_threshold > missing_w9 >
 *     ready, with the $600 boundary inclusive.
 *   - maskTin: last-4-only enforcement — full TINs (with or without dashes)
 *     are rejected, and the masked output never exposes more than 4 digits.
 *   - buildVendor1099Summary: active/paid vendor filtering, threshold flag,
 *     and the reportable/missing-W-9 totals.
 */

import { describe, it, expect } from 'vitest';
import {
    NEC_THRESHOLD,
    derive1099Status,
    maskTin,
    buildVendor1099Summary,
    isValidTaxClassification,
    Vendor1099ValidationError,
    type VendorTaxInfo,
} from '../vendor-1099.service';

const taxInfo = (overrides: Partial<VendorTaxInfo> = {}): VendorTaxInfo => ({
    legalName: null,
    taxClassification: null,
    taxIdMasked: null,
    w9Received: false,
    w9ReceivedDate: null,
    exemptFrom1099: false,
    address: null,
    notes: null,
    ...overrides,
});

/* ------------------------------------------------------------------ */
/* derive1099Status                                                     */
/* ------------------------------------------------------------------ */

describe('derive1099Status', () => {
    it('is ready when paid >= $600 with a W-9 on file', () => {
        expect(derive1099Status({ totalPaid: 600, exempt: false, w9Received: true })).toBe('ready');
        expect(derive1099Status({ totalPaid: 12_000, exempt: false, w9Received: true })).toBe('ready');
    });

    it('flags missing W-9 only for reportable vendors', () => {
        expect(derive1099Status({ totalPaid: 600, exempt: false, w9Received: false })).toBe('missing_w9');
        // Below threshold no W-9 is needed — below_threshold wins.
        expect(derive1099Status({ totalPaid: 100, exempt: false, w9Received: false })).toBe('below_threshold');
    });

    it('treats the $600 threshold as inclusive', () => {
        expect(derive1099Status({ totalPaid: 599.99, exempt: false, w9Received: true })).toBe('below_threshold');
        expect(derive1099Status({ totalPaid: NEC_THRESHOLD, exempt: false, w9Received: true })).toBe('ready');
    });

    it('exempt wins regardless of amount or W-9 status', () => {
        expect(derive1099Status({ totalPaid: 50_000, exempt: true, w9Received: false })).toBe('exempt');
        expect(derive1099Status({ totalPaid: 0, exempt: true, w9Received: true })).toBe('exempt');
    });
});

/* ------------------------------------------------------------------ */
/* maskTin                                                              */
/* ------------------------------------------------------------------ */

describe('maskTin', () => {
    it('renders SSN style for individuals and EIN style otherwise', () => {
        expect(maskTin('1234', 'individual/sole_prop')).toBe('***-**-1234');
        expect(maskTin('1234', 'llc')).toBe('**-***1234');
        expect(maskTin('1234', null)).toBe('**-***1234');
        expect(maskTin('1234')).toBe('**-***1234');
    });

    it('never exposes more than the last 4 digits', () => {
        for (const cls of ['individual/sole_prop', 'llc', 's_corp', undefined]) {
            const masked = maskTin('9876', cls);
            expect(masked.replace(/\D/g, '')).toBe('9876');
        }
    });

    it('rejects anything that is not exactly 4 digits (full TINs refused)', () => {
        expect(() => maskTin('123456789')).toThrow(Vendor1099ValidationError); // full SSN digits
        expect(() => maskTin('123-45-6789')).toThrow(Vendor1099ValidationError); // dashed SSN
        expect(() => maskTin('12-3456789')).toThrow(Vendor1099ValidationError); // dashed EIN
        expect(() => maskTin('123')).toThrow(Vendor1099ValidationError);
        expect(() => maskTin('12345')).toThrow(Vendor1099ValidationError);
        expect(() => maskTin('12a4')).toThrow(Vendor1099ValidationError);
        expect(() => maskTin('')).toThrow(Vendor1099ValidationError);
    });
});

/* ------------------------------------------------------------------ */
/* isValidTaxClassification                                             */
/* ------------------------------------------------------------------ */

describe('isValidTaxClassification', () => {
    it('accepts the documented enum and rejects everything else', () => {
        expect(isValidTaxClassification('individual/sole_prop')).toBe(true);
        expect(isValidTaxClassification('s_corp')).toBe(true);
        expect(isValidTaxClassification('corporation')).toBe(false);
        expect(isValidTaxClassification('')).toBe(false);
        expect(isValidTaxClassification(null)).toBe(false);
        expect(isValidTaxClassification(42)).toBe(false);
    });
});

/* ------------------------------------------------------------------ */
/* buildVendor1099Summary                                               */
/* ------------------------------------------------------------------ */

describe('buildVendor1099Summary', () => {
    const G1 = 'a'.repeat(32);
    const G2 = 'b'.repeat(32);
    const G3 = 'c'.repeat(32);
    const G4 = 'd'.repeat(32);

    it('rolls up threshold flags, statuses, and totals', () => {
        const summary = buildVendor1099Summary(
            2025,
            [
                { guid: G1, name: 'Plumber LLC', active: true },
                { guid: G2, name: 'Design Studio', active: true },
                { guid: G3, name: 'Acme S-Corp', active: true },
                { guid: G4, name: 'Tiny Vendor', active: true },
            ],
            new Map([
                [G1, 1500],
                [G2, 800],
                [G3, 5000],
                [G4, 200],
            ]),
            new Map([
                [G1, taxInfo({ w9Received: true })],
                [G3, taxInfo({ exemptFrom1099: true, taxClassification: 's_corp' })],
            ]),
        );

        const byGuid = new Map(summary.vendors.map((v) => [v.vendorGuid, v]));
        expect(byGuid.get(G1)?.status).toBe('ready');
        expect(byGuid.get(G1)?.crosses600).toBe(true);
        expect(byGuid.get(G2)?.status).toBe('missing_w9');
        expect(byGuid.get(G3)?.status).toBe('exempt');
        expect(byGuid.get(G4)?.status).toBe('below_threshold');
        expect(byGuid.get(G4)?.crosses600).toBe(false);

        // Reportable = ≥ $600 (3 vendors); non-exempt reportable total = 1500 + 800.
        expect(summary.totals.reportableCount).toBe(3);
        expect(summary.totals.missingW9Count).toBe(1);
        expect(summary.totals.reportableTotal).toBe(2300);
    });

    it('drops inactive vendors with no in-year payments, keeps paid ones', () => {
        const summary = buildVendor1099Summary(
            2025,
            [
                { guid: G1, name: 'Retired Vendor', active: false },
                { guid: G2, name: 'Inactive but paid', active: false },
            ],
            new Map([[G2, 700]]),
            new Map(),
        );
        expect(summary.vendors.map((v) => v.vendorGuid)).toEqual([G2]);
        expect(summary.vendors[0].status).toBe('missing_w9');
    });

    it('sorts by total paid descending with name tiebreak', () => {
        const summary = buildVendor1099Summary(
            2025,
            [
                { guid: G1, name: 'Zeta', active: true },
                { guid: G2, name: 'Alpha', active: true },
                { guid: G3, name: 'Mid', active: true },
            ],
            new Map([
                [G1, 100],
                [G2, 100],
                [G3, 900],
            ]),
            new Map(),
        );
        expect(summary.vendors.map((v) => v.name)).toEqual(['Mid', 'Alpha', 'Zeta']);
    });
});

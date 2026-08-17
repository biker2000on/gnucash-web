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
    derive1099Status,
    maskTin,
    buildVendor1099Summary,
    aggregateEligibleVendorPayments,
    mapTaxInfo,
    isVendor1099Exempt,
    isValidTaxClassification,
    Vendor1099ValidationError,
    type VendorTaxInfo,
} from '../vendor-1099.service';
import { getDefaultNecThreshold } from '../../reports/irs-limits';

const NEC_THRESHOLD = getDefaultNecThreshold(2025)!;

const taxInfo = (overrides: Partial<VendorTaxInfo> = {}): VendorTaxInfo => ({
    legalName: null,
    taxClassification: null,
    taxIdMasked: null,
    w9Received: false,
    w9ReceivedDate: null,
    w9RequestedDate: null,
    exemptFrom1099: false,
    exemptFrom1099Override: null,
    address: null,
    notes: null,
    ...overrides,
});

/* ------------------------------------------------------------------ */
/* derive1099Status                                                     */
/* ------------------------------------------------------------------ */

describe('derive1099Status', () => {
    it('is ready when paid >= $600 with a W-9 on file', () => {
        expect(derive1099Status({ totalPaid: 600, exempt: false, w9Received: true, threshold: NEC_THRESHOLD })).toBe('ready');
        expect(derive1099Status({ totalPaid: 12_000, exempt: false, w9Received: true, threshold: NEC_THRESHOLD })).toBe('ready');
    });

    it('flags missing W-9 only for reportable vendors', () => {
        expect(derive1099Status({ totalPaid: 600, exempt: false, w9Received: false, threshold: NEC_THRESHOLD })).toBe('missing_w9');
        // Below threshold no W-9 is needed — below_threshold wins.
        expect(derive1099Status({ totalPaid: 100, exempt: false, w9Received: false, threshold: NEC_THRESHOLD })).toBe('below_threshold');
    });

    it('treats the $600 threshold as inclusive', () => {
        expect(derive1099Status({ totalPaid: 599.99, exempt: false, w9Received: true, threshold: NEC_THRESHOLD })).toBe('below_threshold');
        expect(derive1099Status({ totalPaid: NEC_THRESHOLD, exempt: false, w9Received: true, threshold: NEC_THRESHOLD })).toBe('ready');
    });

    it('exempt wins regardless of amount or W-9 status', () => {
        expect(derive1099Status({ totalPaid: 50_000, exempt: true, w9Received: false, threshold: NEC_THRESHOLD })).toBe('exempt');
        expect(derive1099Status({ totalPaid: 0, exempt: true, w9Received: true, threshold: NEC_THRESHOLD })).toBe('exempt');
    });
});

describe('corporate classification exemption', () => {
    it('exempts C- and S-corporations even when the manual exemption flag is absent', () => {
        expect(isVendor1099Exempt(taxInfo({ taxClassification: 'c_corp' }))).toBe(true);
        expect(isVendor1099Exempt(taxInfo({ taxClassification: 's_corp' }))).toBe(true);
        expect(isVendor1099Exempt(taxInfo({ taxClassification: 'llc' }))).toBe(false);
    });

    it('honors an explicit false override for corporate carve-outs', () => {
        expect(isVendor1099Exempt(taxInfo({ taxClassification: 'c_corp', exemptFrom1099Override: false }))).toBe(false);
        expect(isVendor1099Exempt(taxInfo({ taxClassification: 's_corp', exemptFrom1099Override: true }))).toBe(true);
    });

    it('keeps a legacy explicit false reportable after migration', () => {
        // The one-time migration copies false into the override rather than
        // converting it to null, so a previously reportable corporation stays so.
        expect(isVendor1099Exempt(taxInfo({
            taxClassification: 'c_corp',
            exemptFrom1099Override: false,
        }))).toBe(false);
    });

    it('keeps attorney or medical payments to corporations reportable', () => {
        expect(isVendor1099Exempt(taxInfo({
            taxClassification: 'c_corp',
            attorneyOrMedicalPayments: true,
        }))).toBe(false);
    });

    it('keeps the displayed and computed exemption aligned for an attorney PC', () => {
        const attorneyPc = mapTaxInfo({
            vendor_guid: 'a'.repeat(32), legal_name: 'Attorney PC', tax_classification: 'c_corp',
            tax_id_masked: null, w9_received: false, w9_received_date: null, w9_requested_date: null,
            exempt_from_1099: false, exempt_from_1099_override: null,
            attorney_or_medical_payments: true, address: null, notes: null,
        });
        const summary = buildVendor1099Summary(
            2026,
            [{ guid: 'attorney-pc', name: 'Attorney PC', active: true }],
            new Map([['attorney-pc', 9_000]]),
            new Map([['attorney-pc', attorneyPc]]),
            new Map(),
            2_000,
        );
        expect(attorneyPc.exemptFrom1099).toBe(isVendor1099Exempt(attorneyPc));
        expect(summary.vendors[0].status).toBe('missing_w9');
    });
});

describe('card-funded payment exclusion', () => {
    it('apportions mixed funding and keeps the checking-funded amount reportable', () => {
        const payments = aggregateEligibleVendorPayments([
            { vendorGuid: 'vendor-1', paid: 2_900, cardFundingAmount: 400, totalFundingAmount: 2_900 },
        ]);
        expect(payments.get('vendor-1')).toBe(2_500);
        const summary = buildVendor1099Summary(
            2026,
            [{ guid: 'vendor-1', name: 'Mixed funding vendor', active: true }],
            payments,
            new Map(),
            new Map(),
            2_000,
        );
        expect(summary.vendors[0]).toMatchObject({ totalPaid: 2_500, crosses600: true, status: 'missing_w9' });
    });

    it('preserves all payment amount when no card funding is present', () => {
        expect(aggregateEligibleVendorPayments([
            { vendorGuid: 'vendor-1', paid: 1_500, cardFundingAmount: 0, totalFundingAmount: 1_500 },
        ]).get('vendor-1')).toBe(1_500);
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
                [G3, taxInfo({ taxClassification: 's_corp' })],
            ]),
            new Map(),
            NEC_THRESHOLD,
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
            new Map(),
            NEC_THRESHOLD,
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
            new Map(),
            NEC_THRESHOLD,
        );
        expect(summary.vendors.map((v) => v.name)).toEqual(['Mid', 'Alpha', 'Zeta']);
    });
});

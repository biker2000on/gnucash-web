import { describe, expect, it } from 'vitest';
import {
    findMissingTaxForms,
    groupTaxRecordsByYear,
    isTaxFormSeasonFor,
    type TaxRecordLike,
} from '../tax-records';

function record(overrides: Partial<TaxRecordLike>): TaxRecordLike {
    return { docType: 'tax', taxYear: 2024, taxForm: 'w2', issuer: 'Acme Corp', ...overrides };
}

describe('groupTaxRecordsByYear', () => {
    it('groups tax docs newest year first with unyeared records last', () => {
        const groups = groupTaxRecordsByYear([
            record({ taxYear: 2023 }),
            record({ taxYear: null }),
            record({ taxYear: 2024 }),
            record({ docType: 'insurance', taxYear: 2024 }),
        ]);
        expect(groups.map((g) => g.year)).toEqual([2024, 2023, null]);
        expect(groups.every((g) => g.documents.every((d) => d.docType === 'tax'))).toBe(true);
    });
});

describe('findMissingTaxForms', () => {
    it('reports forms present in the prior year but absent in the next', () => {
        const missing = findMissingTaxForms([
            record({ taxYear: 2023, taxForm: 'w2', issuer: 'Acme Corp' }),
            record({ taxYear: 2023, taxForm: '1099_int', issuer: 'Ally Bank' }),
            record({ taxYear: 2024, taxForm: 'w2', issuer: 'Acme Corp' }),
        ]);
        expect(missing).toEqual([
            expect.objectContaining({
                year: 2024,
                priorYear: 2023,
                taxForm: '1099_int',
                issuer: 'Ally Bank',
                label: '1099-INT — Ally Bank',
            }),
        ]);
    });

    it('matches issuers case-insensitively and ignores returns/notices/other', () => {
        const missing = findMissingTaxForms([
            record({ taxYear: 2023, taxForm: 'w2', issuer: 'ACME CORP' }),
            record({ taxYear: 2023, taxForm: 'return', issuer: null }),
            record({ taxYear: 2023, taxForm: 'other', issuer: 'Somewhere' }),
            record({ taxYear: 2024, taxForm: 'w2', issuer: 'acme corp' }),
        ]);
        expect(missing).toEqual([]);
    });

    it('does not compare a year with no prior-year records', () => {
        expect(findMissingTaxForms([record({ taxYear: 2024 })])).toEqual([]);
    });

    it('dedupes duplicate prior-year forms into one missing entry', () => {
        const missing = findMissingTaxForms([
            record({ taxYear: 2023, taxForm: '1099_div', issuer: 'Fidelity' }),
            record({ taxYear: 2023, taxForm: '1099_div', issuer: 'Fidelity' }),
            record({ taxYear: 2024, taxForm: 'w2', issuer: 'Acme Corp' }),
        ]);
        expect(missing.filter((m) => m.taxForm === '1099_div')).toHaveLength(1);
    });
});

describe('isTaxFormSeasonFor', () => {
    it('is true only January–April of the following year', () => {
        expect(isTaxFormSeasonFor(2024, new Date('2025-02-10T12:00:00Z'))).toBe(true);
        expect(isTaxFormSeasonFor(2024, new Date('2025-05-01T12:00:00Z'))).toBe(false);
        expect(isTaxFormSeasonFor(2024, new Date('2024-02-10T12:00:00Z'))).toBe(false);
        expect(isTaxFormSeasonFor(2024, new Date('2026-02-10T12:00:00Z'))).toBe(false);
    });
});

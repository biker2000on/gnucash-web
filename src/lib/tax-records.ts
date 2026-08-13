/**
 * Tax records archive — pure, client-safe helpers over vault documents with
 * doc_type 'tax': grouping by tax year and the deterministic year-completeness
 * diff ("this issuer sent a 1099-INT last year but not this year").
 *
 * No server imports; both the vault page and the Action Center source use
 * these over their own data loads.
 */

import { getTaxFormLabel } from '@/lib/entity-document-context';

/** The minimal shape both EntityDocument (camelCase API) rows satisfy. */
export interface TaxRecordLike {
    docType: string;
    taxYear: number | null;
    taxForm: string | null;
    issuer: string | null;
}

export interface TaxYearGroup<T extends TaxRecordLike> {
    /** null = tax records with no year set yet. */
    year: number | null;
    documents: T[];
}

/** Tax records grouped by year, newest year first, unyeared records last. */
export function groupTaxRecordsByYear<T extends TaxRecordLike>(documents: T[]): TaxYearGroup<T>[] {
    const taxDocs = documents.filter((d) => d.docType === 'tax');
    const byYear = new Map<number | null, T[]>();
    for (const doc of taxDocs) {
        const key = doc.taxYear;
        const list = byYear.get(key);
        if (list) list.push(doc);
        else byYear.set(key, [doc]);
    }
    return [...byYear.entries()]
        .sort(([a], [b]) => {
            if (a === null) return 1;
            if (b === null) return -1;
            return b - a;
        })
        .map(([year, docs]) => ({ year, documents: docs }));
}

export interface MissingTaxForm {
    year: number;
    priorYear: number;
    taxForm: string;
    issuer: string | null;
    /** Human-readable, e.g. "1099-INT — Ally Bank". */
    label: string;
}

function formKey(doc: TaxRecordLike): string | null {
    if (!doc.taxForm) return null;
    const issuer = doc.issuer?.trim().toLowerCase() ?? '';
    return `${doc.taxForm}::${issuer}`;
}

/**
 * Deterministic completeness diff: for each year that has at least one tax
 * record, report (form, issuer) pairs present in the prior year but absent in
 * that year. Only forms with a known subtype participate; issuer comparison is
 * case-insensitive. Filed returns and notices are excluded — a "missing
 * return" is not an institution that forgot to mail a form.
 */
export function findMissingTaxForms(documents: TaxRecordLike[]): MissingTaxForm[] {
    const EXCLUDED = new Set(['return', 'notice', 'other']);
    const byYear = new Map<number, TaxRecordLike[]>();
    for (const doc of documents) {
        if (doc.docType !== 'tax' || doc.taxYear === null) continue;
        const list = byYear.get(doc.taxYear);
        if (list) list.push(doc);
        else byYear.set(doc.taxYear, [doc]);
    }
    const missing: MissingTaxForm[] = [];
    for (const year of [...byYear.keys()].sort((a, b) => b - a)) {
        const prior = byYear.get(year - 1);
        if (!prior) continue;
        const present = new Set(
            (byYear.get(year) ?? []).map(formKey).filter((k): k is string => k !== null),
        );
        const reported = new Set<string>();
        for (const doc of prior) {
            const key = formKey(doc);
            if (!key || !doc.taxForm || EXCLUDED.has(doc.taxForm)) continue;
            if (present.has(key) || reported.has(key)) continue;
            reported.add(key);
            missing.push({
                year,
                priorYear: year - 1,
                taxForm: doc.taxForm,
                issuer: doc.issuer?.trim() || null,
                label: doc.issuer?.trim()
                    ? `${getTaxFormLabel(doc.taxForm)} — ${doc.issuer.trim()}`
                    : getTaxFormLabel(doc.taxForm),
            });
        }
    }
    return missing;
}

/**
 * Whether "missing tax form" signals are in season: forms for year Y arrive
 * January–April of Y+1, so the diff for year Y only fires in that window.
 */
export function isTaxFormSeasonFor(year: number, today: Date = new Date()): boolean {
    const y = today.getFullYear();
    const month = today.getMonth() + 1; // 1-12
    return y === year + 1 && month >= 1 && month <= 4;
}

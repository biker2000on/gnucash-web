import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQueryRaw = vi.fn();

vi.mock('../prisma', () => ({
    default: {
        $queryRaw: (...args: unknown[]) => mockQueryRaw(...args),
    },
}));

vi.mock('../services/statement.service', () => ({
    ensureStatementTables: vi.fn().mockResolvedValue(undefined),
}));

import {
    validateSearchQuery,
    escapeLike,
    extractSnippet,
    fallbackSnippet,
    searchDocuments,
    toPaletteEntries,
    MAX_GROUP_RESULTS,
    type DocSearchResults,
} from '../doc-search';

// ─────────────────────────────────────────────────────────────────────────────
// Query validation
// ─────────────────────────────────────────────────────────────────────────────

describe('validateSearchQuery', () => {
    it('rejects null/undefined/empty', () => {
        expect(validateSearchQuery(null).ok).toBe(false);
        expect(validateSearchQuery(undefined).ok).toBe(false);
        expect(validateSearchQuery('').ok).toBe(false);
    });

    it('rejects queries shorter than 3 characters (after trimming)', () => {
        expect(validateSearchQuery('ab').ok).toBe(false);
        expect(validateSearchQuery('  ab  ').ok).toBe(false);
    });

    it('accepts and trims a valid query', () => {
        const result = validateSearchQuery('  costco  ');
        expect(result).toEqual({ ok: true, query: 'costco' });
    });

    it('rejects overly long queries', () => {
        expect(validateSearchQuery('x'.repeat(201)).ok).toBe(false);
        expect(validateSearchQuery('x'.repeat(200)).ok).toBe(true);
    });
});

describe('escapeLike', () => {
    it('escapes %, _ and backslash', () => {
        expect(escapeLike('100%_off\\now')).toBe('100\\%\\_off\\\\now');
    });

    it('leaves normal text untouched', () => {
        expect(escapeLike('costco run')).toBe('costco run');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Snippet extraction + highlight indices
// ─────────────────────────────────────────────────────────────────────────────

describe('extractSnippet', () => {
    it('highlights an exact match with correct indices', () => {
        const snippet = extractSnippet('Paid at Costco Wholesale on Tuesday', 'costco');
        expect(snippet).not.toBeNull();
        const { text, highlightStart, highlightEnd } = snippet!;
        expect(text.slice(highlightStart, highlightEnd)).toBe('Costco');
    });

    it('windows long text around the match and adds ellipses', () => {
        const source = `${'a'.repeat(200)} NEEDLE ${'b'.repeat(200)}`;
        const snippet = extractSnippet(source, 'needle', 30);
        expect(snippet).not.toBeNull();
        const { text, highlightStart, highlightEnd } = snippet!;
        expect(text.startsWith('…')).toBe(true);
        expect(text.endsWith('…')).toBe(true);
        expect(text.length).toBeLessThan(source.length);
        expect(text.slice(highlightStart, highlightEnd)).toBe('NEEDLE');
    });

    it('does not add a leading ellipsis when the match is at the start', () => {
        const snippet = extractSnippet('needle in a haystack', 'needle');
        expect(snippet!.text.startsWith('…')).toBe(false);
        expect(snippet!.highlightStart).toBe(0);
        expect(snippet!.text.slice(0, snippet!.highlightEnd)).toBe('needle');
    });

    it('falls back to an individual query word when the full phrase is absent', () => {
        const snippet = extractSnippet('The gym membership renewed', 'costco gym');
        expect(snippet).not.toBeNull();
        const { text, highlightStart, highlightEnd } = snippet!;
        expect(text.slice(highlightStart, highlightEnd)).toBe('gym');
    });

    it('normalizes whitespace (OCR newlines) before matching', () => {
        const snippet = extractSnippet('TOTAL\n\n  $42.17\nCOSTCO   WHOLESALE', 'costco');
        expect(snippet).not.toBeNull();
        expect(snippet!.text).not.toMatch(/\n/);
        expect(snippet!.text.slice(snippet!.highlightStart, snippet!.highlightEnd)).toBe('COSTCO');
    });

    it('returns null when nothing matches', () => {
        expect(extractSnippet('completely unrelated text', 'zzzzz')).toBeNull();
    });

    it('returns null for empty source', () => {
        expect(extractSnippet('', 'anything')).toBeNull();
    });
});

describe('fallbackSnippet', () => {
    it('truncates long text with no highlight range', () => {
        const snippet = fallbackSnippet('x'.repeat(300), 120);
        expect(snippet.text.length).toBe(121); // 120 chars + ellipsis
        expect(snippet.text.endsWith('…')).toBe(true);
        expect(snippet.highlightStart).toBe(-1);
        expect(snippet.highlightEnd).toBe(-1);
    });

    it('keeps short text intact', () => {
        expect(fallbackSnippet('short', 120).text).toBe('short');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// searchDocuments — grouping and caps (mocked prisma)
// ─────────────────────────────────────────────────────────────────────────────

/** Route the mocked $queryRaw by the table referenced in the SQL template. */
function installQueryRouter(data: {
    receipts?: unknown[];
    statements?: unknown[];
    payslips?: unknown[];
    transactions?: unknown[];
}) {
    mockQueryRaw.mockImplementation((strings: TemplateStringsArray) => {
        const sql = Array.isArray(strings) ? strings.join('?') : String(strings);
        if (sql.includes('gnucash_web_receipts')) return Promise.resolve(data.receipts ?? []);
        if (sql.includes('gnucash_web_statement_lines')) return Promise.resolve(data.statements ?? []);
        if (sql.includes('gnucash_web_payslips')) return Promise.resolve(data.payslips ?? []);
        if (sql.includes('FROM transactions')) return Promise.resolve(data.transactions ?? []);
        return Promise.resolve([]);
    });
}

describe('searchDocuments', () => {
    beforeEach(() => {
        mockQueryRaw.mockReset();
    });

    it('rejects short queries', async () => {
        await expect(searchDocuments(['a1'], 'book1', 'ab')).rejects.toThrow(/at least 3/);
    });

    it('groups rows into receipts/statements/payslips/transactions with hrefs', async () => {
        installQueryRouter({
            receipts: [
                { id: 7, filename: 'costco-receipt.jpg', ocr_text: 'COSTCO WHOLESALE TOTAL 42.17', created_at: new Date('2026-05-01T12:00:00Z') },
            ],
            statements: [
                { id: 3, batch_id: 11, description: 'COSTCO GAS #123', line_date: new Date('2026-05-02T00:00:00Z'), amount: '-55.10', original_filename: 'may.ofx' },
            ],
            payslips: [
                { id: 9, employer_name: 'Costco Inc', pay_date: new Date('2026-05-15T00:00:00Z'), line_items_text: '[{"label":"Gross"}]' },
            ],
            transactions: [
                { guid: 'tx1', description: 'Costco run', post_date: new Date('2026-05-03T10:59:00Z'), matched_memo: null },
            ],
        });

        const results = await searchDocuments(['a1', 'a2'], 'book1', 'costco');

        expect(results.totalHits).toBe(4);
        expect(results.receipts).toHaveLength(1);
        expect(results.receipts[0].href).toBe('/receipts');
        expect(results.receipts[0].snippet.text).toContain('COSTCO');

        expect(results.statements[0].href).toBe('/statements/11');
        expect(results.statements[0].meta).toContain('may.ofx');

        expect(results.payslips[0].href).toBe('/payslips');
        expect(results.payslips[0].title).toBe('Costco Inc');

        expect(results.transactions[0].href).toBe('/ledger?search=costco');
        expect(results.transactions[0].date).toBe('2026-05-03');

        // Highlight indices point at the match within each snippet
        const snip = results.transactions[0].snippet;
        expect(snip.text.slice(snip.highlightStart, snip.highlightEnd).toLowerCase()).toBe('costco');
    });

    it('caps each group at the requested limit', async () => {
        const manyTx = Array.from({ length: 30 }, (_, i) => ({
            guid: `tx${i}`,
            description: `Costco trip ${i}`,
            post_date: new Date('2026-01-01T00:00:00Z'),
            matched_memo: null,
        }));
        installQueryRouter({ transactions: manyTx });

        const results = await searchDocuments(['a1'], 'book1', 'costco', { limit: 5 });
        expect(results.transactions).toHaveLength(5);
        expect(results.receipts).toHaveLength(0);
    });

    it('never exceeds MAX_GROUP_RESULTS even when a larger limit is requested', async () => {
        const manyTx = Array.from({ length: 50 }, (_, i) => ({
            guid: `tx${i}`,
            description: `Costco ${i}`,
            post_date: null,
            matched_memo: null,
        }));
        installQueryRouter({ transactions: manyTx });

        const results = await searchDocuments(['a1'], 'book1', 'costco', { limit: 100 });
        expect(results.transactions.length).toBeLessThanOrEqual(MAX_GROUP_RESULTS);
    });

    it('uses a fallback snippet (no highlight) for FTS-only receipt hits', async () => {
        installQueryRouter({
            receipts: [
                // stemmed match: query "running" matched "ran" via FTS — no literal occurrence
                { id: 1, filename: 'note.png', ocr_text: 'we ran the errands yesterday', created_at: null },
            ],
        });
        const results = await searchDocuments(['a1'], 'book1', 'running');
        expect(results.receipts[0].snippet.highlightStart).toBe(-1);
        expect(results.receipts[0].snippet.text).toContain('errands');
    });

    it('flattens grouped results into palette entries', async () => {
        installQueryRouter({
            transactions: [
                { guid: 'tx1', description: 'Costco run', post_date: null, matched_memo: null },
            ],
            payslips: [
                { id: 1, employer_name: 'Costco Inc', pay_date: null, line_items_text: null },
            ],
        });
        const results: DocSearchResults = await searchDocuments(['a1'], 'book1', 'costco');
        const entries = toPaletteEntries(results);
        expect(entries).toHaveLength(2);
        expect(entries[0]).toEqual({ label: 'Costco run', href: '/ledger?search=costco', group: 'transactions' });
        expect(entries[1].group).toBe('payslips');
    });
});

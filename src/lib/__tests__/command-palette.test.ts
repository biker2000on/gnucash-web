import { describe, it, expect } from 'vitest';
import { fuzzyScore, searchCommands, PALETTE_COMMANDS } from '../command-palette';

describe('fuzzyScore', () => {
    it('ranks exact > prefix > word-prefix > substring > keyword > subsequence', () => {
        const exact = fuzzyScore('budgets', 'Budgets');
        const prefix = fuzzyScore('budg', 'Budgets');
        const wordPrefix = fuzzyScore('flow', 'Cash Flow Forecast');
        const substring = fuzzyScore('ash flo', 'Cash Flow Forecast');
        const keyword = fuzzyScore('snowball', 'Debt Payoff Planner', 'snowball avalanche');
        const subsequence = fuzzyScore('cff', 'Cash Flow Forecast');

        expect(exact).toBeGreaterThan(prefix);
        expect(prefix).toBeGreaterThan(wordPrefix);
        expect(wordPrefix).toBeGreaterThan(substring);
        expect(substring).toBeGreaterThan(keyword);
        expect(keyword).toBeGreaterThan(subsequence);
        expect(subsequence).toBeGreaterThan(0);
    });

    it('is case-insensitive', () => {
        expect(fuzzyScore('BUDG', 'budgets')).toBe(600);
        expect(fuzzyScore('budg', 'BUDGETS')).toBe(600);
    });

    it('returns -1 for non-matches', () => {
        expect(fuzzyScore('zzz', 'Budgets')).toBe(-1);
        expect(fuzzyScore('xq', 'Cash Flow')).toBe(-1);
    });

    it('returns 0 for empty query', () => {
        expect(fuzzyScore('', 'Anything')).toBe(0);
    });
});

describe('searchCommands', () => {
    it('returns actions and navigation for an empty query, actions first', () => {
        const results = searchCommands('');
        expect(results.length).toBeGreaterThan(0);
        expect(results.every(r => r.group === 'action' || r.group === 'navigate')).toBe(true);
        expect(results[0].group).toBe('action');
    });

    it('finds reports by fuzzy title', () => {
        const results = searchCommands('8949');
        expect(results[0].id).toBe('rpt-capital-gains');
    });

    it('finds by keyword', () => {
        const results = searchCommands('snowball');
        expect(results.some(r => r.id === 'tool-debt')).toBe(true);
    });

    it('ranks title prefix above keyword hits', () => {
        const results = searchCommands('tax');
        const taxEstimator = results.findIndex(r => r.id === 'tool-tax');
        const capGains = results.findIndex(r => r.id === 'rpt-capital-gains'); // keyword 'tax'
        expect(taxEstimator).toBeGreaterThanOrEqual(0);
        expect(capGains).toBeGreaterThanOrEqual(0);
        expect(taxEstimator).toBeLessThan(capGains);
    });

    it('every command has a unique id and either href or event', () => {
        const ids = new Set(PALETTE_COMMANDS.map(c => c.id));
        expect(ids.size).toBe(PALETTE_COMMANDS.length);
        for (const c of PALETTE_COMMANDS) {
            expect(Boolean(c.href) || Boolean(c.event)).toBe(true);
        }
    });
});

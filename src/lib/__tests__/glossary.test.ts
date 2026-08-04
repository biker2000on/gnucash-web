import { describe, expect, it } from 'vitest';
import { GLOSSARY, getGlossaryEntry } from '../glossary';

describe('glossary', () => {
    const entries = Object.entries(GLOSSARY);

    it('has entries for the roadmap starter list', () => {
        const required = [
            'AGI', 'MAGI', 'QBI', 'SE', 'NIIT', 'SALT', 'LTCG', 'STCG', 'CTC', 'ACTC',
            'HSA', 'FSA', 'IRA', 'SEP', 'SIMPLE', 'RMD', 'QSS', 'MFJ', 'MFS', 'HOH',
            '1040-ES', 'TXF', '8949', 'W-2', 'W-9', '1099', '990-N', 'DRIP', 'ROC',
            'G/L', 'FIFO', 'LIFO', 'FICA', 'OASDI', 'SCU', 'AR/AP', 'COGS', 'QBO',
            'PUV', 'FIRE', 'KPI', 'YTD', 'FX', 'ES', 'Schedule C', 'Schedule E',
            'Schedule F', '§179', '§1091', 'OBBBA', 'ST/LT',
        ];
        for (const term of required) {
            expect(GLOSSARY[term], `missing glossary entry: ${term}`).toBeDefined();
        }
    });

    it('every entry has a non-empty expansion', () => {
        for (const [term, entry] of entries) {
            expect(entry.expansion.trim().length, `empty expansion for ${term}`).toBeGreaterThan(0);
        }
    });

    it('glosses, when present, are non-empty and stay to one or two sentences', () => {
        for (const [term, entry] of entries) {
            if (entry.gloss === undefined) continue;
            expect(entry.gloss.trim().length, `empty gloss for ${term}`).toBeGreaterThan(0);
            expect(entry.gloss.length, `gloss too long for ${term}`).toBeLessThanOrEqual(300);
        }
    });

    it('keys are trimmed and unique case-sensitively as written', () => {
        const keys = entries.map(([k]) => k);
        for (const key of keys) {
            expect(key).toBe(key.trim());
        }
        expect(new Set(keys).size).toBe(keys.length);
    });

    it('getGlossaryEntry returns entries for known terms and undefined otherwise', () => {
        expect(getGlossaryEntry('QBI')?.expansion).toBe('Qualified Business Income');
        expect(getGlossaryEntry('nope')).toBeUndefined();
    });

    it('Schedule F expansion matches the roadmap wording', () => {
        expect(GLOSSARY['Schedule F'].expansion).toBe(
            'Schedule F (Form 1040), Profit or Loss From Farming',
        );
    });
});

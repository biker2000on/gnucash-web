import { describe, it, expect } from 'vitest';
import {
    parseSearchQuery,
    normalizeTagName,
    isValidTagName,
    pickTagColor,
    TAG_COLORS,
} from '@/lib/tags';

describe('parseSearchQuery', () => {
    it('returns empty result for empty string', () => {
        expect(parseSearchQuery('')).toEqual({ text: '', tags: [] });
    });

    it('passes through plain text with no tags', () => {
        expect(parseSearchQuery('grocery store')).toEqual({ text: 'grocery store', tags: [] });
    });

    it('extracts a single tag', () => {
        expect(parseSearchQuery('#vacation')).toEqual({ text: '', tags: ['vacation'] });
    });

    it('extracts tag and remaining text', () => {
        expect(parseSearchQuery('groceries #vacation')).toEqual({
            text: 'groceries',
            tags: ['vacation'],
        });
    });

    it('extracts multiple tags (AND semantics list)', () => {
        expect(parseSearchQuery('#trip-2026 #food coffee')).toEqual({
            text: 'coffee',
            tags: ['trip-2026', 'food'],
        });
    });

    it('lowercases tag names', () => {
        expect(parseSearchQuery('#Vacation #FOOD')).toEqual({ text: '', tags: ['vacation', 'food'] });
    });

    it('deduplicates repeated tags (case-insensitively)', () => {
        expect(parseSearchQuery('#a #B coffee #A #b')).toEqual({ text: 'coffee', tags: ['a', 'b'] });
    });

    it('supports digits, underscores, and hyphens in tag names', () => {
        expect(parseSearchQuery('#tax_2025 #prop-1 #123')).toEqual({
            text: '',
            tags: ['tax_2025', 'prop-1', '123'],
        });
    });

    it('collapses whitespace left behind by removed tags', () => {
        expect(parseSearchQuery('rent  #property   payment')).toEqual({
            text: 'rent payment',
            tags: ['property'],
        });
    });

    it('treats a lone # as plain text', () => {
        expect(parseSearchQuery('check #')).toEqual({ text: 'check #', tags: [] });
    });

    it('stops the tag at invalid characters', () => {
        // '#tag!' -> tag is 'tag', '!' stays in the text
        expect(parseSearchQuery('#tag!')).toEqual({ text: '!', tags: ['tag'] });
    });

    it('handles tags embedded mid-string (e.g. transaction numbers)', () => {
        expect(parseSearchQuery('invoice #42 overdue')).toEqual({
            text: 'invoice overdue',
            tags: ['42'],
        });
    });
});

describe('normalizeTagName', () => {
    it('lowercases and trims', () => {
        expect(normalizeTagName('  Vacation ')).toBe('vacation');
    });

    it('strips leading # characters', () => {
        expect(normalizeTagName('#vacation')).toBe('vacation');
        expect(normalizeTagName('##vacation')).toBe('vacation');
    });

    it('converts internal whitespace to hyphens', () => {
        expect(normalizeTagName('summer trip 2026')).toBe('summer-trip-2026');
    });

    it('keeps underscores and hyphens', () => {
        expect(normalizeTagName('Tax_Year-2025')).toBe('tax_year-2025');
    });

    it('does not strip invalid characters (validation catches them)', () => {
        expect(normalizeTagName('a/b')).toBe('a/b');
        expect(isValidTagName(normalizeTagName('a/b'))).toBe(false);
    });
});

describe('isValidTagName', () => {
    it('accepts valid names', () => {
        expect(isValidTagName('vacation')).toBe(true);
        expect(isValidTagName('tax_2025')).toBe(true);
        expect(isValidTagName('prop-1')).toBe(true);
        expect(isValidTagName('123')).toBe(true);
    });

    it('rejects empty string', () => {
        expect(isValidTagName('')).toBe(false);
    });

    it('rejects uppercase', () => {
        expect(isValidTagName('Vacation')).toBe(false);
    });

    it('rejects spaces and special characters', () => {
        expect(isValidTagName('summer trip')).toBe(false);
        expect(isValidTagName('#vacation')).toBe(false);
        expect(isValidTagName('a.b')).toBe(false);
    });

    it('rejects names longer than 100 chars', () => {
        expect(isValidTagName('a'.repeat(100))).toBe(true);
        expect(isValidTagName('a'.repeat(101))).toBe(false);
    });
});

describe('pickTagColor', () => {
    it('returns the first palette color when none are used', () => {
        expect(pickTagColor([])).toBe(TAG_COLORS[0]);
    });

    it('returns the least used color', () => {
        const used = [TAG_COLORS[0], TAG_COLORS[0], TAG_COLORS[1]];
        expect(pickTagColor(used)).toBe(TAG_COLORS[2]);
    });

    it('cycles back once all colors are used equally', () => {
        expect(pickTagColor([...TAG_COLORS])).toBe(TAG_COLORS[0]);
    });

    it('ignores null/unknown colors', () => {
        expect(pickTagColor([null, undefined, 'not-a-color'])).toBe(TAG_COLORS[0]);
    });
});

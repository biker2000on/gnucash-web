import { describe, it, expect } from 'vitest';
import { statToneClass, statGridColsClass } from '@/components/ui/StatCard';

describe('statToneClass', () => {
    it('maps semantic tones to DESIGN.md color token classes', () => {
        expect(statToneClass('positive')).toBe('text-positive');
        expect(statToneClass('negative')).toBe('text-negative');
        expect(statToneClass('warning')).toBe('text-warning');
        expect(statToneClass('primary')).toBe('text-primary');
        expect(statToneClass('default')).toBe('text-foreground');
    });

    it('defaults to foreground when no tone is given', () => {
        expect(statToneClass()).toBe('text-foreground');
    });
});

describe('statGridColsClass', () => {
    it('always renders 2 columns on phones', () => {
        for (const cols of [2, 3, 4, 5] as const) {
            expect(statGridColsClass(cols)).toContain('grid-cols-2');
        }
    });

    it('expands to the requested column count at larger breakpoints', () => {
        expect(statGridColsClass(2)).not.toContain('lg:');
        expect(statGridColsClass(3)).toContain('sm:grid-cols-3');
        expect(statGridColsClass(4)).toContain('lg:grid-cols-4');
        expect(statGridColsClass(5)).toContain('lg:grid-cols-5');
    });

    it('defaults to 4 columns', () => {
        expect(statGridColsClass()).toBe(statGridColsClass(4));
    });
});

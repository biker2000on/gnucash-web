import { describe, it, expect } from 'vitest';
import {
    FEATURES,
    DOMAIN_LABELS,
    NAV_DOMAIN_ORDER,
    featuresByDomain,
    featureById,
} from '../feature-registry';

describe('feature registry', () => {
    it('has at least one feature', () => {
        expect(FEATURES.length).toBeGreaterThan(0);
    });

    it('has unique ids', () => {
        const ids = FEATURES.map(f => f.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('every href starts with /', () => {
        for (const f of FEATURES) {
            expect(f.href.startsWith('/'), `${f.id} href "${f.href}"`).toBe(true);
        }
    });

    it('every feature has a non-empty description and task', () => {
        for (const f of FEATURES) {
            expect(f.description.trim().length, `${f.id} description`).toBeGreaterThan(0);
            expect(f.task.trim().length, `${f.id} task`).toBeGreaterThan(0);
        }
    });

    it('every domain is a key of DOMAIN_LABELS and appears in NAV_DOMAIN_ORDER', () => {
        for (const f of FEATURES) {
            expect(DOMAIN_LABELS[f.domain], `${f.id} domain "${f.domain}"`).toBeTruthy();
            expect(NAV_DOMAIN_ORDER, `${f.id} domain "${f.domain}"`).toContain(f.domain);
        }
    });

    it('NAV_DOMAIN_ORDER covers every DOMAIN_LABELS key exactly once', () => {
        const labelKeys = Object.keys(DOMAIN_LABELS).sort();
        const orderKeys = [...NAV_DOMAIN_ORDER].sort();
        expect(orderKeys).toEqual(labelKeys);
        expect(new Set(NAV_DOMAIN_ORDER).size).toBe(NAV_DOMAIN_ORDER.length);
    });

    it('money nav children exclude mobile-only features when filtered for desktop', () => {
        const navChildren = featuresByDomain('money').filter(f => f.nav);
        // Quick Add is mobile-only and must be a nav child of money...
        expect(navChildren.some(f => f.id === 'nav-quick-add')).toBe(true);
        // ...but a desktop sidebar filter (nav && !mobileOnly) must drop it.
        const desktopChildren = navChildren.filter(f => !f.mobileOnly);
        expect(desktopChildren.some(f => f.mobileOnly)).toBe(false);
        expect(desktopChildren.some(f => f.id === 'nav-quick-add')).toBe(false);
        expect(desktopChildren.length).toBeGreaterThan(0);
    });

    it('featuresByDomain returns only the requested domain', () => {
        for (const domain of NAV_DOMAIN_ORDER) {
            const features = featuresByDomain(domain);
            expect(features.every(f => f.domain === domain)).toBe(true);
        }
    });

    it('featuresByDomain hides businessOnly features for non-business books', () => {
        const business = featuresByDomain('business', { businessBook: false });
        expect(business.some(f => f.businessOnly)).toBe(false);
    });

    it('featureById resolves known ids and returns undefined for unknown ids', () => {
        expect(featureById('nav-dashboard')?.href).toBe('/dashboard');
        expect(featureById('does-not-exist')).toBeUndefined();
    });
});

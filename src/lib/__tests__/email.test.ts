import { describe, it, expect } from 'vitest';
import {
    parseEmailPrefs,
    shouldEmailNotification,
    renderNotificationEmail,
    DEFAULT_EMAIL_PREFS,
} from '../email';

describe('parseEmailPrefs', () => {
    it('returns defaults for null/garbage', () => {
        expect(parseEmailPrefs(null)).toEqual(DEFAULT_EMAIL_PREFS);
        expect(parseEmailPrefs('nope')).toEqual(DEFAULT_EMAIL_PREFS);
        expect(parseEmailPrefs(42)).toEqual(DEFAULT_EMAIL_PREFS);
    });

    it('parses a full prefs object', () => {
        expect(parseEmailPrefs({ enabled: true, minSeverity: 'warning', types: ['monthly_digest'] })).toEqual({
            enabled: true,
            minSeverity: 'warning',
            types: ['monthly_digest'],
        });
    });

    it('coerces invalid fields to defaults', () => {
        const prefs = parseEmailPrefs({ enabled: 'yes', minSeverity: 'catastrophic', types: 'some' });
        expect(prefs.enabled).toBe(false);
        expect(prefs.minSeverity).toBe('info');
        expect(prefs.types).toBe('all');
    });

    it('filters non-string entries out of types arrays', () => {
        expect(parseEmailPrefs({ enabled: true, types: ['a', 1, null, 'b'] }).types).toEqual(['a', 'b']);
    });
});

describe('shouldEmailNotification', () => {
    it('never emails when disabled', () => {
        expect(shouldEmailNotification({ enabled: false, minSeverity: 'info', types: 'all' }, 'monthly_digest', 'error')).toBe(false);
    });

    it('emails everything when enabled with info severity and all types', () => {
        const prefs = { enabled: true, minSeverity: 'info' as const, types: 'all' as const };
        expect(shouldEmailNotification(prefs, 'monthly_digest', 'info')).toBe(true);
        expect(shouldEmailNotification(prefs, 'budget_alert', 'warning')).toBe(true);
        expect(shouldEmailNotification(prefs, 'simplefin_sync', 'success')).toBe(true);
    });

    it('applies the minimum severity threshold (success counts as info)', () => {
        const prefs = { enabled: true, minSeverity: 'warning' as const, types: 'all' as const };
        expect(shouldEmailNotification(prefs, 'x', 'info')).toBe(false);
        expect(shouldEmailNotification(prefs, 'x', 'success')).toBe(false);
        expect(shouldEmailNotification(prefs, 'x', 'warning')).toBe(true);
        expect(shouldEmailNotification(prefs, 'x', 'error')).toBe(true);
    });

    it('applies type filtering', () => {
        const prefs = { enabled: true, minSeverity: 'info' as const, types: ['monthly_digest'] };
        expect(shouldEmailNotification(prefs, 'monthly_digest', 'info')).toBe(true);
        expect(shouldEmailNotification(prefs, 'budget_alert', 'error')).toBe(false);
    });
});

describe('renderNotificationEmail', () => {
    it('renders subject, text, and html with an absolutized link', () => {
        process.env.APP_BASE_URL = 'https://money.example.com/';
        const { subject, text, html } = renderNotificationEmail({
            title: 'Budget overspend: Dining',
            message: 'Dining is 120% of budget with 10 days left.',
            href: '/budgets/abc',
            severity: 'warning',
            type: 'budget_alert',
        });
        expect(subject).toBe('[GnuCash Web] Budget overspend: Dining');
        expect(text).toContain('Dining is 120% of budget');
        expect(text).toContain('https://money.example.com/budgets/abc');
        expect(html).toContain('Budget overspend: Dining');
        expect(html).toContain('https://money.example.com/budgets/abc');
        delete process.env.APP_BASE_URL;
    });

    it('escapes HTML in title and message', () => {
        const { html } = renderNotificationEmail({
            title: 'Alert <script>alert(1)</script>',
            message: 'a & b < c',
            href: null,
            severity: 'error',
            type: 'x',
        });
        expect(html).not.toContain('<script>');
        expect(html).toContain('&lt;script&gt;');
        expect(html).toContain('a &amp; b &lt; c');
    });

    it('omits the button when there is no link', () => {
        const { html } = renderNotificationEmail({
            title: 'T',
            message: null,
            href: null,
            severity: 'info',
            type: 'x',
        });
        expect(html).not.toContain('View in GnuCash Web');
    });
});

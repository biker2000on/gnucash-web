import { describe, it, expect, vi, beforeEach } from 'vitest';

const findFirst = vi.fn();

vi.mock('@/lib/prisma', () => ({
    default: {
        gnucash_web_book_permissions: {
            findFirst: (...args: unknown[]) => findFirst(...args),
        },
    },
}));

import { hasMinimumRole, getUserRoleForBook, roleAtLeast, hasTimesheetAccess } from '../permission.service';

function mockRole(role: string | null) {
    findFirst.mockResolvedValue(role ? { role: { name: role } } : null);
}

describe('role hierarchy (readonly < edit < admin)', () => {
    beforeEach(() => findFirst.mockReset());

    it('admin satisfies every minimum role', async () => {
        mockRole('admin');
        expect(await hasMinimumRole(1, 'book', 'readonly')).toBe(true);
        expect(await hasMinimumRole(1, 'book', 'edit')).toBe(true);
        expect(await hasMinimumRole(1, 'book', 'admin')).toBe(true);
    });

    it('edit satisfies readonly and edit but not admin', async () => {
        mockRole('edit');
        expect(await hasMinimumRole(1, 'book', 'readonly')).toBe(true);
        expect(await hasMinimumRole(1, 'book', 'edit')).toBe(true);
        expect(await hasMinimumRole(1, 'book', 'admin')).toBe(false);
    });

    it('readonly satisfies only readonly', async () => {
        mockRole('readonly');
        expect(await hasMinimumRole(1, 'book', 'readonly')).toBe(true);
        expect(await hasMinimumRole(1, 'book', 'edit')).toBe(false);
        expect(await hasMinimumRole(1, 'book', 'admin')).toBe(false);
    });

    it('no permission row means no access at all', async () => {
        mockRole(null);
        expect(await getUserRoleForBook(1, 'book')).toBeNull();
        expect(await hasMinimumRole(1, 'book', 'readonly')).toBe(false);
    });

    it('an UNKNOWN role name from the DB fails closed (regression)', async () => {
        // Before the fail-closed fix, `HIERARCHY[unknown] < HIERARCHY[min]`
        // evaluated to `undefined < n` === false, which skipped the rejection
        // branch in requireRole-style checks and AUTHORIZED the request.
        mockRole('superuser');
        expect(await hasMinimumRole(1, 'book', 'readonly')).toBe(false);
        expect(await hasMinimumRole(1, 'book', 'edit')).toBe(false);
        expect(await hasMinimumRole(1, 'book', 'admin')).toBe(false);
    });

    it('timekeeper never satisfies any financial minimum role', async () => {
        mockRole('timekeeper');
        expect(await hasMinimumRole(1, 'book', 'readonly')).toBe(false);
        expect(await hasMinimumRole(1, 'book', 'edit')).toBe(false);
        expect(await hasMinimumRole(1, 'book', 'admin')).toBe(false);
    });
});

describe('roleAtLeast (fail-closed comparison used by requireRole)', () => {
    it('accepts known-role pairs by hierarchy', () => {
        expect(roleAtLeast('admin', 'edit')).toBe(true);
        expect(roleAtLeast('edit', 'edit')).toBe(true);
        expect(roleAtLeast('readonly', 'edit')).toBe(false);
    });

    it('rejects unknown role names (regression: undefined < n is false)', () => {
        expect(roleAtLeast('superuser', 'readonly')).toBe(false);
        expect(roleAtLeast('', 'readonly')).toBe(false);
        expect(roleAtLeast(null, 'readonly')).toBe(false);
        expect(roleAtLeast(undefined, 'readonly')).toBe(false);
    });

    it('rejects any role when the MINIMUM is unknown', () => {
        expect(roleAtLeast('admin', 'superuser')).toBe(false);
    });

    it('timekeeper sits outside the hierarchy entirely', () => {
        expect(roleAtLeast('timekeeper', 'readonly')).toBe(false);
        expect(roleAtLeast('timekeeper', 'edit')).toBe(false);
        expect(roleAtLeast('timekeeper', 'admin')).toBe(false);
    });
});

describe('hasTimesheetAccess', () => {
    it('write access: timekeeper, edit, admin only', () => {
        expect(hasTimesheetAccess('timekeeper', 'write')).toBe(true);
        expect(hasTimesheetAccess('edit', 'write')).toBe(true);
        expect(hasTimesheetAccess('admin', 'write')).toBe(true);
        expect(hasTimesheetAccess('readonly', 'write')).toBe(false);
    });

    it('read access additionally allows readonly', () => {
        expect(hasTimesheetAccess('readonly', 'read')).toBe(true);
        expect(hasTimesheetAccess('timekeeper', 'read')).toBe(true);
    });

    it('fails closed for unknown or missing roles', () => {
        expect(hasTimesheetAccess('superuser', 'read')).toBe(false);
        expect(hasTimesheetAccess(null, 'read')).toBe(false);
        expect(hasTimesheetAccess(undefined, 'write')).toBe(false);
    });
});

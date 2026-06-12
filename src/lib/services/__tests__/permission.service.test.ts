import { describe, it, expect, vi, beforeEach } from 'vitest';

const findFirst = vi.fn();

vi.mock('@/lib/prisma', () => ({
    default: {
        gnucash_web_book_permissions: {
            findFirst: (...args: unknown[]) => findFirst(...args),
        },
    },
}));

import { hasMinimumRole, getUserRoleForBook } from '../permission.service';

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
});

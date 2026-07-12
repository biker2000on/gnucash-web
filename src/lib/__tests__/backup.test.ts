import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/prisma', () => ({
    default: { $queryRaw: vi.fn(), $executeRaw: vi.fn(), $executeRawUnsafe: vi.fn() },
}));

import { selectBackupsToPrune, backupStorageKey, backupRetention } from '../backup';

describe('selectBackupsToPrune', () => {
    const at = (iso: string) => ({ createdAt: new Date(iso) });

    it('keeps the newest N and prunes the rest', () => {
        const backups = [
            at('2026-01-01T00:00:00Z'),
            at('2026-01-03T00:00:00Z'),
            at('2026-01-02T00:00:00Z'),
            at('2026-01-04T00:00:00Z'),
        ];
        const pruned = selectBackupsToPrune(backups, 2);
        expect(pruned.map(p => p.createdAt.toISOString().slice(0, 10))).toEqual([
            '2026-01-02',
            '2026-01-01',
        ]);
    });

    it('prunes nothing when under the limit', () => {
        expect(selectBackupsToPrune([at('2026-01-01T00:00:00Z')], 30)).toEqual([]);
    });

    it('prunes nothing for keep<=0 (defensive)', () => {
        expect(selectBackupsToPrune([at('2026-01-01T00:00:00Z')], 0)).toEqual([]);
    });

    it('does not mutate the input order', () => {
        const backups = [at('2026-01-01T00:00:00Z'), at('2026-01-03T00:00:00Z')];
        selectBackupsToPrune(backups, 1);
        expect(backups[0].createdAt.toISOString()).toContain('2026-01-01');
    });
});

describe('backupStorageKey', () => {
    it('builds a sortable per-book key', () => {
        const key = backupStorageKey('abc123', new Date('2026-07-12T02:30:05.123Z'));
        expect(key).toBe('backups/abc123/2026-07-12T02-30-05.gnucash');
    });
});

describe('backupRetention', () => {
    it('defaults to 30 and honors the env var', () => {
        delete process.env.BACKUP_RETENTION;
        expect(backupRetention()).toBe(30);
        process.env.BACKUP_RETENTION = '7';
        expect(backupRetention()).toBe(7);
        process.env.BACKUP_RETENTION = 'junk';
        expect(backupRetention()).toBe(30);
        delete process.env.BACKUP_RETENTION;
    });
});

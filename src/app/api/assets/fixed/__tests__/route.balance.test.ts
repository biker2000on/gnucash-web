/**
 * /api/assets/fixed GET balance derivation.
 *
 * The asset detail view reports an account's balance from the account-side
 * quantity (adjustments to a fixed asset are unit counts, not dollars). This
 * list route used to SUM(value_num / value_denom) instead, so the two screens
 * disagreed for any asset whose value and quantity diverge. It must now derive
 * the balance through the same helper the detail path uses.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { prismaMock, requireRoleMock, getBookAccountGuidsMock } = vi.hoisted(() => ({
    prismaMock: {
        accounts: { findMany: vi.fn() },
        gnucash_web_depreciation_schedules: { findMany: vi.fn() },
        $queryRaw: vi.fn(),
    },
    requireRoleMock: vi.fn(),
    getBookAccountGuidsMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({ default: prismaMock }));
vi.mock('@/lib/auth', () => ({ requireRole: requireRoleMock }));
vi.mock('@/lib/book-scope', () => ({ getBookAccountGuids: getBookAccountGuidsMock }));

import { GET } from '../route';

/** Value and quantity diverge: 12 units carried at a $1,500 transaction value. */
const DIVERGENT = 'd'.repeat(32);
/** Value and quantity agree: a plain $1,500 dollar-denominated asset. */
const NORMAL = 'n'.repeat(32);

function getRequest(query: string): NextRequest {
    return {
        nextUrl: new URL(`http://localhost/api/assets/fixed${query}`),
    } as unknown as NextRequest;
}

interface AssetRow {
    guid: string;
    accountPath: string;
    currentBalance: number;
}

beforeEach(() => {
    for (const fn of [
        prismaMock.accounts.findMany,
        prismaMock.gnucash_web_depreciation_schedules.findMany,
        prismaMock.$queryRaw,
        requireRoleMock,
        getBookAccountGuidsMock,
    ]) fn.mockReset();

    requireRoleMock.mockResolvedValue({ user: { id: 1, username: 'u' }, role: 'readonly' });
    getBookAccountGuidsMock.mockResolvedValue([DIVERGENT, NORMAL]);

    prismaMock.accounts.findMany.mockResolvedValue([
        { guid: DIVERGENT, name: 'Beehives' },
        { guid: NORMAL, name: 'Tractor' },
    ]);
    prismaMock.gnucash_web_depreciation_schedules.findMany.mockResolvedValue([]);

    // Dispatch on the SQL text so each of the route's raw queries is answered.
    prismaMock.$queryRaw.mockImplementation((strings: TemplateStringsArray) => {
        const sql = strings.join(' ');
        if (sql.includes('account_hierarchy')) {
            return Promise.resolve([
                { guid: DIVERGENT, fullname: 'Assets:Beehives' },
                { guid: NORMAL, fullname: 'Assets:Tractor' },
            ]);
        }
        if (sql.includes('MAX(t.post_date)')) {
            return Promise.resolve([]);
        }
        if (sql.includes('quantity_num')) {
            // The quantity side: unit counts for the divergent account.
            return Promise.resolve([
                { account_guid: DIVERGENT, quantity_num: 10n, quantity_denom: 1n },
                { account_guid: DIVERGENT, quantity_num: 2n, quantity_denom: 1n },
                { account_guid: NORMAL, quantity_num: 150000n, quantity_denom: 100n },
            ]);
        }
        if (sql.includes('value_num')) {
            // The value side, as the pre-fix route summed it.
            return Promise.resolve([
                { account_guid: DIVERGENT, balance: '1500' },
                { account_guid: NORMAL, balance: '1500' },
            ]);
        }
        return Promise.resolve([]);
    });
});

async function fetchAssets(): Promise<AssetRow[]> {
    const response = await GET(getRequest(`?accountGuids=${DIVERGENT},${NORMAL}`));
    const body = await response.json();
    return body.assets as AssetRow[];
}

describe('GET /api/assets/fixed balance', () => {
    it('reports the quantity balance when value and quantity diverge', async () => {
        const assets = await fetchAssets();
        const divergent = assets.find((a) => a.guid === DIVERGENT);

        // 10 + 2 units, not the $1,500 transaction value the splits carry.
        expect(divergent?.currentBalance).toBe(12);
    });

    it('leaves a normal asset account unchanged when value equals quantity', async () => {
        const assets = await fetchAssets();
        const normal = assets.find((a) => a.guid === NORMAL);

        expect(normal?.currentBalance).toBe(1500);
    });

    it('does not sum the value side of the splits', async () => {
        await fetchAssets();
        const queried = prismaMock.$queryRaw.mock.calls
            .map((call) => (call[0] as TemplateStringsArray).join(' '))
            .join('\n');

        expect(queried).not.toMatch(/SUM\([^)]*value_num/);
        expect(queried).toMatch(/quantity_num/);
    });
});

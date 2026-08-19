/**
 * The in-memory fake's ORDER BY must be PostgreSQL's ORDER BY.
 *
 * The lot engine's determinism guarantee is an ordering: loadUnassignedSplits
 * asks for post_date, then tx_guid, then guid, and the sequence decides which
 * lot each split consumes and so every cost basis derived from it. The
 * end-to-end tests for that guarantee run against helpers/fake-prisma.ts, which
 * means the fake's comparator is part of the proof — and a fake that orders
 * differently from the server proves nothing about production.
 *
 * These tests assert the fake over the SHARED fixture in
 * helpers/split-ordering-fixture.ts. The identical rows and the identical
 * expectations are run against a live PostgreSQL server by
 * ./lot-outflow-ordering.integration.test.ts, so the two tiers cannot drift
 * into agreeing on different orders: whichever one is wrong goes red.
 *
 * The case that motivated this file is the NULL. `transactions.post_date` is
 * nullable, Postgres sorts NULL as GREATER than every value (NULLS LAST for
 * ASC, NULLS FIRST for DESC), and the fake previously coerced a missing
 * post_date to epoch 0 — placing it at the OPPOSITE end from the server under
 * both directions.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, beforeEach } from 'vitest';

import { FakePrisma } from './helpers/fake-prisma';
import {
    EXPECTED_ASC_KEYS,
    EXPECTED_GUID_ONLY_KEYS,
    EXPECTED_POST_DATE_DESC_KEYS,
    ORDER_BY_ASC,
    ORDER_BY_GUID_ONLY,
    ORDER_BY_POST_DATE_DESC,
    SPLIT_ORDERING_ROWS,
    keysOf,
    orderingGuid,
    splitGuidOf,
    txGuidOf,
} from './helpers/split-ordering-fixture';

/** Any 12 hex chars; the fake does not care, and neither does the ordering. */
const RUN_PREFIX = 'fake00000000';
const ACCOUNT_GUID = orderingGuid(RUN_PREFIX, 'acct');

let db: FakePrisma;

beforeEach(() => {
    db = new FakePrisma();
    db.t.accounts.push({
        guid: ACCOUNT_GUID,
        name: 'Ordering fixture',
        account_type: 'STOCK',
        parent_guid: null,
        commodity_guid: null,
        commodity_scu: 100,
        non_std_scu: 0,
        code: '',
        description: '',
        hidden: 0,
        placeholder: 0,
    });

    for (const row of SPLIT_ORDERING_ROWS) {
        const txGuid = txGuidOf(row, RUN_PREFIX);
        if (!db.t.transactions.some(t => t.guid === txGuid)) {
            db.t.transactions.push({
                guid: txGuid,
                currency_guid: null,
                num: '',
                post_date: row.postDate === null ? null : new Date(row.postDate),
                enter_date: new Date('2024-01-01'),
                description: row.key,
            });
        }
        db.t.splits.push({
            guid: splitGuidOf(row, RUN_PREFIX),
            tx_guid: txGuid,
            account_guid: ACCOUNT_GUID,
            memo: '',
            action: '',
            reconcile_state: 'n',
            reconcile_date: null,
            value_num: 0n,
            value_denom: 100n,
            quantity_num: 0n,
            quantity_denom: 100n,
            lot_guid: null,
        });
    }
});

/** The engine's own query shape, with whichever orderBy is under test. */
async function orderedKeys(orderBy: unknown): Promise<string[]> {
    const rows = await db.splits.findMany({
        where: { account_guid: ACCOUNT_GUID, lot_guid: null },
        include: { transaction: { select: { post_date: true } } },
        orderBy: orderBy as any,
    });
    // The fake returns loose Recs; only `guid` is read.
    return keysOf(rows as Array<{ guid: string }>, RUN_PREFIX);
}

describe('FakePrisma ORDER BY matches PostgreSQL', () => {
    it('sorts post_date ASC with NULLS LAST, then tx_guid, then guid', async () => {
        // The exact ordering loadUnassignedSplits issues. NULLS LAST is the
        // half that the epoch-0 coercion inverted: both null rows would have
        // led the list instead of trailing it.
        expect(await orderedKeys(ORDER_BY_ASC)).toEqual([...EXPECTED_ASC_KEYS]);
    });

    it('sorts post_date DESC with NULLS FIRST', async () => {
        // Not symmetric with the case above, and that asymmetry is the point:
        // an implementation that hard-codes "nulls at the end" passes ASC and
        // fails here, because Postgres puts NULL — the largest value — first
        // under DESC.
        expect(await orderedKeys(ORDER_BY_POST_DATE_DESC))
            .toEqual([...EXPECTED_POST_DATE_DESC_KEYS]);
    });

    it('reads later keys only to break ties in the earlier ones', async () => {
        // Guards the left-to-right precedence itself. Ordering on guid ALONE
        // has to produce a different sequence from the three-key order, or the
        // array orderBy above could be honouring any single key and still look
        // correct.
        const byGuidOnly = await orderedKeys(ORDER_BY_GUID_ONLY);
        expect(byGuidOnly).not.toEqual([...EXPECTED_ASC_KEYS]);
        expect(byGuidOnly).toEqual([...EXPECTED_GUID_ONLY_KEYS]);
    });

    it('treats two NULLs as equal rather than letting either win', async () => {
        // cmpNullable returns 0 for null-vs-null, so the decision falls through
        // to tx_guid. If it returned ±1 the null pair's relative order would be
        // decided by the comparator instead of by the remaining keys, and the
        // two directions above would disagree about which null leads.
        const asc = await orderedKeys(ORDER_BY_ASC);
        const desc = await orderedKeys(ORDER_BY_POST_DATE_DESC);
        expect(asc.slice(-2)).toEqual(['null-early-tx', 'null-late-tx']);
        expect(desc.slice(0, 2)).toEqual(['null-early-tx', 'null-late-tx']);
    });
});

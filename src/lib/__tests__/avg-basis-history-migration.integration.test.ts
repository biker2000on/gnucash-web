/**
 * THE MIGRATION MUST NOT DESTROY WHAT IT COULD NOT CARRY.
 *
 * `2026-08-18-avg-basis-history-out-of-slots` copies the average-cost write
 * history out of GnuCash `slots` into the app-owned history table. It runs
 * unattended, at startup, on every existing production database.
 *
 * Its first version finished with an unconditional, global
 * `DELETE FROM slots WHERE name IN ('avg_cost_basis_remaining_prev', ...)`.
 * That DELETE ran no matter what the loop above it had managed to transcribe —
 * including for a stash that failed to parse, and for the several shapes that
 * parse but write no rows (`{}`, a bare JSON string, array members with no
 * `value`). In each of those the destination got ZERO rows and the source — the
 * only surviving record of that lot's pooled cost basis — was deleted anyway.
 *
 * This file seeds one lot per shape against a REAL PostgreSQL, runs the real
 * `initializeDatabase()`, and asserts the two halves of the rule separately:
 * the healthy lots migrated AND lost their slots, and every other lot kept its
 * slot with its bytes intact and no history rows shadowing it.
 *
 * A unit test could not have caught the original defect: it lived entirely in
 * PL/pgSQL control flow, in the interaction between an EXCEPTION handler, a
 * silently-skipped branch, and a DELETE outside the loop.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import prisma from '../prisma';
import { initializeDatabase } from '../db-init';

const MIGRATION_STEP = '2026-08-18-avg-basis-history-out-of-slots';

/** Per-run prefix so runs, and leftovers, cannot collide. */
const TAG = randomUUID().replace(/-/g, '').slice(0, 12);
/** Slot obj_guid / lot_guid are VARCHAR(32); the tag leaves ample room. */
const lot = (name: string) => `${TAG}${name}`.slice(0, 32);

const PREV = 'avg_cost_basis_remaining_prev';
const PREV_RUN = 'avg_cost_basis_remaining_prev_run';
const LIVE = 'avg_cost_basis_remaining';
const LIVE_RUN = 'avg_cost_basis_remaining_run';

/**
 * One seeded lot. `expect` says what must be true of it AFTER the migration:
 * 'migrated' — history written, legacy slots gone;
 * 'kept'     — legacy slot still there byte for byte, and NO history rows,
 *              so the slot is still the authority the app will read.
 */
interface Case {
    name: string;
    prev: string | null;
    prevRun?: string;
    live?: string;
    liveRun?: string;
    expect: 'migrated' | 'kept';
    entries?: number;
    why: string;
}

const CASES: Case[] = [
    {
        name: 'healthy',
        prev: '[{"run":"runA1","value":"1000"},{"run":"runA2","value":"2000"}]',
        live: '3000', liveRun: 'runA3',
        expect: 'migrated', entries: 3,
        why: 'every stash entry readable, plus the live value on top',
    },
    {
        name: 'healthy-no-live',
        prev: '[{"run":"runB1","value":"10"}]',
        expect: 'migrated', entries: 1,
        why: 'a stash with no live value is still fully transcribable',
    },
    {
        name: 'prehistory-number',
        prev: '500', prevRun: 'runC1', live: '900', liveRun: 'runC2',
        expect: 'migrated', entries: 2,
        why: 'the pre-history shape: a bare number with its owner alongside',
    },
    {
        name: 'empty-array',
        prev: '[]', live: '77', liveRun: 'runD1',
        expect: 'migrated', entries: 1,
        why: 'an empty stack is faithfully transcribed as an empty stack',
    },
    {
        name: 'unparseable',
        prev: '[{"run":"runE1","val',
        live: '7777', liveRun: 'runE2',
        expect: 'kept',
        why: 'THE ORIGINAL DEFECT: parse fails, zero rows written, slot deleted anyway',
    },
    {
        name: 'json-object',
        prev: '{}', live: '11', liveRun: 'runF1',
        expect: 'kept',
        why: 'valid JSON, unusable shape, silently skipped by the loop',
    },
    {
        name: 'json-string',
        prev: '"x"', live: '12', liveRun: 'runG1',
        expect: 'kept',
        why: 'valid JSON, unusable shape, silently skipped by the loop',
    },
    {
        name: 'entries-no-value',
        prev: '[{"run":"runH1"},{"run":"runH2"}]', live: '13', liveRun: 'runH3',
        expect: 'kept',
        why: 'array members carry an owner but no value; nothing transcribable',
    },
    {
        name: 'entries-part-readable',
        prev: '[{"run":"runI1","value":"100"},{"run":"runI2"}]', live: '14', liveRun: 'runI3',
        expect: 'kept',
        why: 'a PARTIAL transcription is refused outright — half a stack shadows the slot',
    },
    {
        name: 'entry-null-value',
        prev: '[{"run":"runJ1","value":null}]', live: '15', liveRun: 'runJ2',
        expect: 'kept',
        why: 'value null: ->> yields NULL, which basis_val NOT NULL would reject mid-migration',
    },
    {
        name: 'null-stash',
        prev: null, live: '16', liveRun: 'runK1',
        expect: 'kept',
        why: 'a prev slot row with no value at all',
    },
];

/** A lot with only a live value and no stash — the backfill path, unrelated to the DELETE. */
const LIVE_ONLY = lot('liveonly');

async function seed(): Promise<void> {
    for (const c of CASES) {
        const guid = lot(c.name);
        await prisma.$executeRawUnsafe(
            `INSERT INTO slots (obj_guid, name, slot_type, string_val) VALUES ($1, $2, 4, $3)`,
            guid, PREV, c.prev,
        );
        if (c.prevRun) {
            await prisma.$executeRawUnsafe(
                `INSERT INTO slots (obj_guid, name, slot_type, string_val) VALUES ($1, $2, 4, $3)`,
                guid, PREV_RUN, c.prevRun,
            );
        }
        if (c.live) {
            await prisma.$executeRawUnsafe(
                `INSERT INTO slots (obj_guid, name, slot_type, string_val) VALUES ($1, $2, 4, $3)`,
                guid, LIVE, c.live,
            );
        }
        if (c.liveRun) {
            await prisma.$executeRawUnsafe(
                `INSERT INTO slots (obj_guid, name, slot_type, string_val) VALUES ($1, $2, 4, $3)`,
                guid, LIVE_RUN, c.liveRun,
            );
        }
    }
    await prisma.$executeRawUnsafe(
        `INSERT INTO slots (obj_guid, name, slot_type, string_val) VALUES ($1, $2, 4, $3)`,
        LIVE_ONLY, LIVE, '123.45',
    );
    await prisma.$executeRawUnsafe(
        `INSERT INTO slots (obj_guid, name, slot_type, string_val) VALUES ($1, $2, 4, $3)`,
        LIVE_ONLY, LIVE_RUN, 'runL1',
    );
}

const slotVal = async (guid: string, name: string): Promise<string | null | undefined> => {
    const rows = await prisma.$queryRawUnsafe<Array<{ string_val: string | null }>>(
        `SELECT string_val FROM slots WHERE obj_guid = $1 AND name = $2`, guid, name,
    );
    return rows.length === 0 ? undefined : rows[0].string_val;
};

const historyOf = async (guid: string) =>
    prisma.$queryRawUnsafe<Array<{ seq_no: number; run_id: string | null; basis_val: string }>>(
        `SELECT seq_no, run_id, basis_val FROM gnucash_web_avg_basis_history
          WHERE lot_guid = $1 ORDER BY seq_no`, guid,
    );

beforeAll(async () => {
    await seed();
    // Clear the one-time guard so the real startup path re-runs the migration
    // against the rows just seeded.
    await prisma.$executeRawUnsafe(
        `DELETE FROM gnucash_web_schema_meta WHERE step_name = $1`, MIGRATION_STEP,
    );
    await initializeDatabase();
}, 120_000);

afterAll(async () => {
    const guids = [...CASES.map(c => lot(c.name)), LIVE_ONLY];
    await prisma.$executeRawUnsafe(
        `DELETE FROM slots WHERE obj_guid = ANY($1::text[])`, guids,
    );
    await prisma.$executeRawUnsafe(
        `DELETE FROM gnucash_web_avg_basis_history WHERE lot_guid = ANY($1::text[])`, guids,
    );
    await prisma.$executeRawUnsafe(
        `DELETE FROM gnucash_web_migration_backups WHERE row_key = ANY($1::text[])`, guids,
    );
    await prisma.$disconnect();
});

describe('avg-basis history migration: never delete a source that was not carried', () => {
    const migrated = CASES.filter(c => c.expect === 'migrated');
    const kept = CASES.filter(c => c.expect === 'kept');

    it.each(migrated.map(c => [c.name, c] as const))(
        'migrates %s and only then removes its legacy slots',
        async (_name, c) => {
            const guid = lot(c.name);
            const rows = await historyOf(guid);
            expect(rows, c.why).toHaveLength(c.entries!);
            // Destination proven written -> source removed.
            expect(await slotVal(guid, PREV)).toBeUndefined();
            expect(await slotVal(guid, PREV_RUN)).toBeUndefined();
            // The live mirror every reader uses is untouched by the migration.
            if (c.live) expect(await slotVal(guid, LIVE)).toBe(c.live);
        },
    );

    it.each(kept.map(c => [c.name, c] as const))(
        'refuses to delete the %s slot it could not carry',
        async (_name, c) => {
            const guid = lot(c.name);
            // The bytes are still there, exactly as seeded.
            expect(await slotVal(guid, PREV), c.why).toBe(c.prev);
            // And nothing was written that would shadow them: readAvgBasisWrites
            // prefers stored rows, so a single row here would make the surviving
            // slot unreadable forever.
            expect(await historyOf(guid), c.why).toHaveLength(0);
            // Including the live-value backfill, which must skip these lots.
            if (c.live) expect(await slotVal(guid, LIVE)).toBe(c.live);
        },
    );

    it('still backfills a lot that only ever had a live value', async () => {
        const rows = await historyOf(LIVE_ONLY);
        expect(rows).toEqual([{ seq_no: 0, run_id: 'runL1', basis_val: '123.45' }]);
    });

    it('records a countable, per-lot audit of what moved and what did not', async () => {
        const guids = [...CASES.map(c => lot(c.name)), LIVE_ONLY];
        const rows = await prisma.$queryRawUnsafe<Array<{
            row_key: string; outcome: string; reason: string | null; prev_val: string | null;
        }>>(
            `SELECT row_key,
                    row_data->>'outcome'  AS outcome,
                    row_data->>'reason'   AS reason,
                    row_data->>'prev_val' AS prev_val
               FROM gnucash_web_migration_backups
              WHERE step_name = $1 AND row_key = ANY($2::text[])`,
            MIGRATION_STEP, guids,
        );
        const byGuid = new Map(rows.map(r => [r.row_key, r]));

        for (const c of CASES) {
            const audit = byGuid.get(lot(c.name));
            expect(audit, `no audit row for ${c.name}`).toBeDefined();
            expect(audit!.outcome, c.name).toBe(
                c.expect === 'migrated' ? 'migrated' : 'left_in_place',
            );
            if (c.expect === 'kept') {
                // Every survivor names WHY, so the operator's next step is
                // per-lot rather than a guess.
                expect(audit!.reason, c.name).toBeTruthy();
                // ...and carries the original bytes, belt and braces.
                expect(audit!.prev_val, c.name).toBe(c.prev);
            }
        }
        // The live-only lot has no stash, so it is not part of this audit.
        expect(byGuid.has(LIVE_ONLY)).toBe(false);
    });

    it('is idempotent: a second run neither re-migrates nor deletes a survivor', async () => {
        await prisma.$executeRawUnsafe(
            `DELETE FROM gnucash_web_schema_meta WHERE step_name = $1`, MIGRATION_STEP,
        );
        await initializeDatabase();

        for (const c of kept) {
            expect(await slotVal(lot(c.name), PREV), c.name).toBe(c.prev);
            expect(await historyOf(lot(c.name)), c.name).toHaveLength(0);
        }
        for (const c of migrated) {
            expect(await historyOf(lot(c.name)), c.name).toHaveLength(c.entries!);
        }
    }, 120_000);
});

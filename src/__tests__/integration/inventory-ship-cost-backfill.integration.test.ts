/**
 * REAL-Postgres coverage for the legacy shipment-cost backfill
 * (`backfillLegacyInventoryShipmentCosts` in src/lib/db-init.ts).
 *
 * The backfill is pure SQL over four tables and a recursive-free join; a mocked
 * client could only assert that a string was passed to a spy. What actually has
 * to hold is arithmetic and row selection:
 *
 *   - a legacy ship movement with a posted COGS split gets that split's amount
 *     divided by the shipped quantity, tagged 'ledger_cogs';
 *   - an unposted legacy ship movement falls back to the item's avg_cost,
 *     tagged 'item_avg_cost';
 *   - a movement that already HAS a unit_cost is never rewritten (this is what
 *     makes re-running the migration safe);
 *   - a movement with no derivable cost at all is left NULL, which the engine
 *     handles by reversing at current cost with a warning.
 *
 * DATA. This file writes rows into shared tables; every row carries this run's
 * id and is deleted in afterAll, per the tier's convention.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTestClient } from './db';
import { hasTestDatabaseUrl } from './env';

const HAS_TEST_DATABASE = hasTestDatabaseUrl();
const RUN_ID = randomUUID().replace(/-/g, '');

function testGuid(): string {
    return randomUUID().replace(/-/g, '');
}

const BOOK_GUID = `bk${RUN_ID}`.slice(0, 32);
const COGS_ACCOUNT = testGuid();
const TX_POSTED = testGuid();
const CURRENCY_GUID = testGuid();

/** Item ids and movement ids are SERIAL; captured at insert time. */
let itemId = 0;
let locationId = 0;
const movementIds: Record<string, number> = {};

describe.skipIf(!HAS_TEST_DATABASE)('legacy inventory shipment-cost backfill', () => {
    beforeAll(async () => {
        // The inventory tables are created lazily by the app; make sure they
        // exist (and carry unit_cost_source) before writing fixtures.
        const { ensureInventoryTables } = await import('@/lib/services/inventory.service');
        await ensureInventoryTables();

        await withTestClient(async (client) => {
            await client.query(
                `INSERT INTO commodities (guid, namespace, mnemonic, fullname, fraction, quote_flag)
                 VALUES ($1, 'CURRENCY', $2, 'Integration test currency', 100, 0)
                 ON CONFLICT (guid) DO NOTHING`,
                [CURRENCY_GUID, `T${RUN_ID.slice(0, 6)}`],
            );
            await client.query(
                `INSERT INTO accounts (guid, name, account_type, commodity_guid,
                                       commodity_scu, non_std_scu, parent_guid, code,
                                       description, hidden, placeholder)
                 VALUES ($1, $2, 'EXPENSE', $3, 100, 0, NULL, '', '', 0, 0)`,
                [COGS_ACCOUNT, `cogs-${RUN_ID}`, CURRENCY_GUID],
            );
            // The shipment's posted COGS transaction: $30 debited for 3 units.
            await client.query(
                `INSERT INTO transactions (guid, currency_guid, num, post_date, enter_date, description)
                 VALUES ($1, $2, '', now(), now(), $3)`,
                [TX_POSTED, CURRENCY_GUID, `ship-${RUN_ID}`],
            );
            await client.query(
                `INSERT INTO splits (guid, tx_guid, account_guid, memo, action,
                                     reconcile_state, reconcile_date,
                                     value_num, value_denom, quantity_num, quantity_denom, lot_guid)
                 VALUES ($1, $2, $3, '', '', 'n', NULL, 30, 1, 30, 1, NULL)`,
                [testGuid(), TX_POSTED, COGS_ACCOUNT],
            );

            const item = await client.query(
                `INSERT INTO gnucash_web_inventory_items
                     (book_guid, sku, name, unit, cogs_account_guid, avg_cost)
                 VALUES ($1, $2, 'Backfill widget', 'ea', $3, 7)
                 RETURNING id`,
                [BOOK_GUID, `SKU-${RUN_ID}`, COGS_ACCOUNT],
            );
            itemId = item.rows[0].id;

            const location = await client.query(
                `INSERT INTO gnucash_web_inventory_locations (book_guid, name)
                 VALUES ($1, $2) RETURNING id`,
                [BOOK_GUID, `loc-${RUN_ID}`],
            );
            locationId = location.rows[0].id;

            const insertMovement = async (
                key: string, unitCost: number | null, txnGuid: string | null,
            ) => {
                const row = await client.query(
                    `INSERT INTO gnucash_web_inventory_movements
                         (item_id, location_id, movement_type, quantity, unit_cost,
                          movement_date, reference, txn_guid)
                     VALUES ($1, $2, 'ship', -3, $3, CURRENT_DATE, $4, $5)
                     RETURNING id`,
                    [itemId, locationId, unitCost, `bf-${RUN_ID}`, txnGuid],
                );
                movementIds[key] = row.rows[0].id;
            };

            await insertMovement('posted', null, TX_POSTED);
            await insertMovement('unposted', null, null);
            await insertMovement('alreadyCosted', 99, TX_POSTED);
        });

        const { backfillLegacyInventoryShipmentCosts } = await import('@/lib/db-init');
        await backfillLegacyInventoryShipmentCosts();
        // Re-running must be a no-op, not a second rewrite.
        await backfillLegacyInventoryShipmentCosts();
    });

    afterAll(async () => {
        await withTestClient(async (client) => {
            await client.query(
                `DELETE FROM gnucash_web_inventory_movements WHERE reference = $1`,
                [`bf-${RUN_ID}`],
            );
            await client.query(`DELETE FROM gnucash_web_inventory_items WHERE book_guid = $1`, [BOOK_GUID]);
            await client.query(`DELETE FROM gnucash_web_inventory_locations WHERE book_guid = $1`, [BOOK_GUID]);
            await client.query(`DELETE FROM splits WHERE tx_guid = $1`, [TX_POSTED]);
            await client.query(`DELETE FROM transactions WHERE guid = $1`, [TX_POSTED]);
            await client.query(`DELETE FROM accounts WHERE guid = $1`, [COGS_ACCOUNT]);
            await client.query(`DELETE FROM commodities WHERE guid = $1`, [CURRENCY_GUID]);
        });
    });

    async function movement(key: string) {
        return withTestClient(async (client) => {
            const rows = await client.query(
                `SELECT unit_cost, unit_cost_source
                   FROM gnucash_web_inventory_movements WHERE id = $1`,
                [movementIds[key]],
            );
            return rows.rows[0];
        });
    }

    it('derives the cost from the shipment\'s own posted COGS split', async () => {
        const row = await movement('posted');
        // $30 expensed over 3 shipped units.
        expect(Number(row.unit_cost)).toBe(10);
        expect(row.unit_cost_source).toBe('ledger_cogs');
    });

    it('falls back to the item cost when the shipment was never posted', async () => {
        const row = await movement('unposted');
        expect(Number(row.unit_cost)).toBe(7);
        expect(row.unit_cost_source).toBe('item_avg_cost');
    });

    it('never rewrites a movement that already recorded its cost', async () => {
        const row = await movement('alreadyCosted');
        expect(Number(row.unit_cost)).toBe(99);
        // NULL source = the engine recorded it at movement time.
        expect(row.unit_cost_source).toBeNull();
    });
});

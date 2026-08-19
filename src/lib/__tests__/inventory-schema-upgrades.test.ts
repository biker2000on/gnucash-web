/**
 * The inventory tables are created LAZILY (ensureInventoryTables), but their
 * later column additions have to be in place before the first request, because
 * every reader of an item row selects `post_to_ledger`. Until the lazy ensure
 * had run once after an upgrade, those reads failed with "column does not
 * exist" — a 500 on the inventory page of a freshly-deployed instance.
 *
 * So both places run the upgrade, and both must take the SAME advisory lock:
 * db-init's copy used to take `gnucash_web_inventory_unit_cost_source`, which
 * let it ALTER the same table concurrently with the lazy ensure while each held
 * a lock the other did not respect.
 *
 * These are source-level assertions on purpose. The DDL only proves itself
 * against a real Postgres (see the integration suite); what a unit test CAN
 * prove is that the two copies have not drifted apart, which is the failure
 * mode that actually happened.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(process.cwd(), 'src');
const dbInit = readFileSync(join(SRC, 'lib', 'db-init.ts'), 'utf8');
const service = readFileSync(join(SRC, 'lib', 'services', 'inventory.service.ts'), 'utf8');
const engine = readFileSync(join(SRC, 'lib', 'inventory-engine.ts'), 'utf8');

/** The startup-side inventory column upgrade block. */
const startupDdl = dbInit.slice(
    dbInit.indexOf('const inventoryLazyColumnUpgradesDDL'),
    dbInit.indexOf('const inventoryLegacyShipUnitCostBackfillSQL'),
);

/** The lazy-ensure DDL block. */
const lazyDdl = service.slice(
    service.indexOf('export function ensureInventoryTables'),
    service.indexOf('// Small validation helpers'),
);

describe('inventory schema upgrades', () => {
    it('takes the same advisory lock in db-init as in the lazy ensure', () => {
        const lockOf = (sql: string) =>
            /pg_advisory_xact_lock\(hashtext\('([^']+)'\)\)/.exec(sql)?.[1];

        expect(lockOf(startupDdl)).toBe('gnucash_web_inventory_schema');
        expect(lockOf(lazyDdl)).toBe('gnucash_web_inventory_schema');
    });

    it('adds post_to_ledger at STARTUP, not only on first inventory request', () => {
        expect(startupDdl).toContain(
            'ADD COLUMN post_to_ledger BOOLEAN NOT NULL DEFAULT true',
        );
        // ...guarded, so re-running is a no-op...
        expect(startupDdl).toContain("column_name = 'post_to_ledger'");
        // ...and existing part-configured items are not forced into posting.
        expect(startupDdl).toContain('SET post_to_ledger = false');
    });

    it('adds unit_cost_source in both places', () => {
        expect(startupDdl).toContain('ADD COLUMN IF NOT EXISTS unit_cost_source');
        expect(lazyDdl).toContain('ADD COLUMN IF NOT EXISTS unit_cost_source');
    });

    it('does not fire on a deployment that never opened the inventory feature', () => {
        // The tables are lazily created, so there is nothing to migrate — and
        // recording the step as applied would permanently skip a book that
        // turns inventory on later.
        expect(startupDdl).toContain(
            "IF to_regclass('public.gnucash_web_inventory_movements') IS NULL THEN",
        );
    });
});

describe('every reader of an item row ensures the tables first', () => {
    /**
     * `post_to_ledger` sits in ITEM_COLS, so any exported entry point that
     * SELECTs it must have awaited ensureInventoryTables (or delegate to
     * something that did) — otherwise it is the one path that still 500s on a
     * freshly upgraded database.
     */
    function exportsMissingEnsure(source: string, allowed: string[]): string[] {
        // Cut the file at every top-level declaration, so a block really is one
        // function rather than "this function plus everything up to the next
        // export" — which is what made a pure helper look like a DB reader.
        const starts = [...source.matchAll(
            /^(export )?(?:async )?(?:function|const|interface|type|class) (\w+)/gm,
        )];
        const offending: string[] = [];
        starts.forEach((match, i) => {
            if (!match[1]) return; // not exported
            const body = source.slice(match.index ?? 0, starts[i + 1]?.index ?? source.length);
            const readsItemRow = body.includes('${ITEM_COLS}') || /\blockItems?\(/.test(body);
            if (!readsItemRow) return;
            if (body.includes('ensureInventoryTables()')) return;
            if (allowed.includes(match[2])) return;
            offending.push(match[2]);
        });
        return offending;
    }

    it('holds across inventory.service.ts', () => {
        // deactivateItem delegates to updateItem, which ensures.
        expect(exportsMissingEnsure(service, ['deactivateItem'])).toEqual([]);
    });

    it('holds across inventory-engine.ts', () => {
        expect(exportsMissingEnsure(engine, [])).toEqual([]);
    });
});

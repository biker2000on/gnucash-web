/**
 * Prisma <-> raw-SQL schema drift check.
 *
 * The app owns its extension tables (`gnucash_web_*`) in two different places:
 *
 *   - `prisma/schema.prisma`, which is what typed queries and `prisma generate`
 *     see, and
 *   - idempotent `CREATE TABLE IF NOT EXISTS` DDL under `src/lib/`, which is
 *     what actually runs against a deployment (db-init at container start, plus
 *     the lazily-created tables individual modules own).
 *
 * Nothing kept those two in step. A table added only to the DDL is invisible to
 * Prisma (every read of it has to be `$queryRaw`, and a `prisma migrate diff`
 * against an empty database - which is how `bootstrap.sql` is generated - omits
 * it entirely). A model added only to Prisma exists in the generated client but
 * in no database that was not migrated by hand.
 *
 * This script reports both directions against an explicit allowlist of the
 * drift that exists today.
 *
 *   npm run schema:check
 *
 * NEW TABLES MUST GO IN prisma/schema.prisma, or be added to
 * RAW_SQL_ONLY_TABLES / PRISMA_ONLY_TABLES below with a reason. Do not extend
 * an allowlist just to make this pass - that is the whole failure mode it
 * exists to catch.
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const PRISMA_SCHEMA = path.join(ROOT, 'prisma', 'schema.prisma');
const DDL_ROOT = path.join(ROOT, 'src', 'lib');

/** Only the app's own extension tables are in scope; core GnuCash tables are not. */
const APP_TABLE_PREFIX = 'gnucash_web_';

/**
 * Tables created by raw SQL that are deliberately absent from Prisma.
 *
 * Populated from the state of the tree when the check was introduced
 * (2026-08-19) so it passes today. Every entry is a table whose module reads it
 * exclusively through `$queryRaw`/`$executeRaw`. Shrinking this list is good;
 * growing it needs a reason in review.
 */
const RAW_SQL_ONLY_TABLES = new Set<string>([
    'gnucash_web_account_emergency_info',
    'gnucash_web_api_tokens',
    'gnucash_web_avg_basis_history',
    'gnucash_web_backup_settings',
    'gnucash_web_backups',
    'gnucash_web_book_emergency_info',
    'gnucash_web_budget_envelopes',
    'gnucash_web_calculation_traces',
    'gnucash_web_calendar_tokens',
    'gnucash_web_categorization_rules',
    // Document-vault tags/rules are raw-SQL (queried via $queryRaw) so this
    // worktree does not need `prisma generate` against the shared node_modules.
    'gnucash_web_document_tag_rules',
    'gnucash_web_document_tags',
    'gnucash_web_domain_commands',
    'gnucash_web_email_bills',
    'gnucash_web_financial_action_refresh',
    'gnucash_web_financial_actions',
    'gnucash_web_fixed_income',
    'gnucash_web_goals',
    'gnucash_web_ingest_messages',
    'gnucash_web_ingest_senders',
    'gnucash_web_insights',
    'gnucash_web_interbook_eliminations',
    'gnucash_web_inventory_bom_lines',
    'gnucash_web_inventory_boms',
    'gnucash_web_inventory_items',
    'gnucash_web_inventory_locations',
    'gnucash_web_inventory_movements',
    'gnucash_web_job_cost_links',
    'gnucash_web_living_plan_decisions',
    'gnucash_web_living_plan_reconciliations',
    'gnucash_web_living_plan_versions',
    'gnucash_web_living_plans',
    'gnucash_web_migration_backups',
    'gnucash_web_notifications',
    'gnucash_web_payment_connections',
    'gnucash_web_payment_events',
    'gnucash_web_price_alerts',
    'gnucash_web_reconciliation_sessions',
    'gnucash_web_recurring_invoices',
    'gnucash_web_reimbursement_requests',
    'gnucash_web_report_schedules',
    'gnucash_web_resilience_profiles',
    'gnucash_web_schedule_c_mappings',
    'gnucash_web_schedule_e_properties',
    'gnucash_web_schedule_f_mappings',
    'gnucash_web_schema_meta',
    'gnucash_web_share_links',
    'gnucash_web_statement_acct_map',
    'gnucash_web_statement_batches',
    'gnucash_web_statement_lines',
    'gnucash_web_totp',
    // Transaction comments: the service reads/writes it exclusively through
    // $queryRaw (see src/lib/services/transaction-comments.service.ts).
    'gnucash_web_transaction_comments',
    'gnucash_web_txf_overrides',
    'gnucash_web_webhook_idempotency',
    'gnucash_web_webhooks',
]);

/**
 * Prisma models with no `CREATE TABLE` anywhere in `src/lib/`.
 *
 * Empty today: every `gnucash_web_*` model also has idempotent DDL, which is
 * what makes an upgrade of an existing deployment work. A model added here would
 * exist only in `bootstrap.sql` (generated from the Prisma schema at image-build
 * time) and so would never appear on a database that predates it.
 */
const PRISMA_ONLY_TABLES = new Set<string>([]);

interface DdlHit {
    table: string;
    file: string;
    line: number;
}

function walk(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            // Tests create throwaway fixtures; they are not deployment DDL.
            if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
            walk(full, out);
        } else if (entry.name.endsWith('.ts') && !/\.(test|spec)\.ts$/.test(entry.name)) {
            out.push(full);
        }
    }
    return out;
}

/**
 * Table names from `model X { ... }` blocks, honouring `@@map`.
 *
 * `view` blocks are deliberately excluded: those are the per-entity ownership
 * views, created with `CREATE VIEW` by db-init, and would otherwise be reported
 * as models with no `CREATE TABLE`.
 */
export function parsePrismaTables(schema: string): Set<string> {
    const tables = new Set<string>();
    const blockRe = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
    let match: RegExpExecArray | null;
    while ((match = blockRe.exec(schema)) !== null) {
        const [, name, body] = match;
        const mapped = /@@map\(\s*"([^"]+)"\s*\)/.exec(body);
        tables.add(mapped ? mapped[1] : name);
    }
    return tables;
}

/** `CREATE TABLE [IF NOT EXISTS] <name>` occurrences, with file/line for the report. */
export function parseDdlTables(source: string, file: string): DdlHit[] {
    const hits: DdlHit[] = [];
    const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?public"?\.)?"?([A-Za-z_][\w$]*)"?/gi;
    let match: RegExpExecArray | null;
    while ((match = re.exec(source)) !== null) {
        const line = source.slice(0, match.index).split('\n').length;
        hits.push({ table: match[1].toLowerCase(), file, line });
    }
    return hits;
}

function relative(file: string): string {
    return path.relative(ROOT, file).replace(/\\/g, '/');
}

function main(): void {
    if (!fs.existsSync(PRISMA_SCHEMA)) {
        console.error(`schema:check - ${relative(PRISMA_SCHEMA)} not found`);
        process.exit(1);
    }

    const prismaTables = parsePrismaTables(fs.readFileSync(PRISMA_SCHEMA, 'utf8'));

    const ddlHits: DdlHit[] = [];
    for (const file of walk(DDL_ROOT)) {
        ddlHits.push(...parseDdlTables(fs.readFileSync(file, 'utf8'), file));
    }

    const ddlTables = new Map<string, DdlHit>();
    for (const hit of ddlHits) {
        if (!hit.table.startsWith(APP_TABLE_PREFIX)) continue;
        if (!ddlTables.has(hit.table)) ddlTables.set(hit.table, hit);
    }

    const appPrismaTables = new Set(
        [...prismaTables].filter(name => name.startsWith(APP_TABLE_PREFIX))
    );

    const missingFromPrisma = [...ddlTables.keys()]
        .filter(table => !appPrismaTables.has(table) && !RAW_SQL_ONLY_TABLES.has(table))
        .sort();

    const missingFromDdl = [...appPrismaTables]
        .filter(table => !ddlTables.has(table) && !PRISMA_ONLY_TABLES.has(table))
        .sort();

    // Allowlist entries that no longer describe reality are drift of their own.
    const staleRawOnly = [...RAW_SQL_ONLY_TABLES]
        .filter(table => appPrismaTables.has(table) || !ddlTables.has(table))
        .sort();
    const stalePrismaOnly = [...PRISMA_ONLY_TABLES]
        .filter(table => ddlTables.has(table) || !appPrismaTables.has(table))
        .sort();

    console.log(
        `schema:check - ${appPrismaTables.size} ${APP_TABLE_PREFIX}* models in Prisma, ` +
            `${ddlTables.size} created by raw SQL under src/lib/`
    );

    let failed = false;

    if (missingFromPrisma.length) {
        failed = true;
        console.error(
            `\n✗ ${missingFromPrisma.length} table(s) created by raw SQL but absent from prisma/schema.prisma:`
        );
        for (const table of missingFromPrisma) {
            const hit = ddlTables.get(table)!;
            console.error(`    ${table}  (${relative(hit.file)}:${hit.line})`);
        }
        console.error(
            '\n  Add a model to prisma/schema.prisma, or add the table to' +
                '\n  RAW_SQL_ONLY_TABLES in scripts/check-schema-drift.ts with a reason.'
        );
    }

    if (missingFromDdl.length) {
        failed = true;
        console.error(
            `\n✗ ${missingFromDdl.length} Prisma model(s) with no CREATE TABLE under src/lib/:`
        );
        for (const table of missingFromDdl) console.error(`    ${table}`);
        console.error(
            '\n  Add idempotent DDL (src/lib/db-init.ts or the owning module), or add the' +
                '\n  table to PRISMA_ONLY_TABLES in scripts/check-schema-drift.ts with a reason.'
        );
    }

    if (staleRawOnly.length) {
        failed = true;
        console.error('\n✗ Stale RAW_SQL_ONLY_TABLES entries (now in Prisma, or no longer created):');
        for (const table of staleRawOnly) console.error(`    ${table}`);
    }

    if (stalePrismaOnly.length) {
        failed = true;
        console.error('\n✗ Stale PRISMA_ONLY_TABLES entries (now has DDL, or no longer a model):');
        for (const table of stalePrismaOnly) console.error(`    ${table}`);
    }

    if (failed) {
        process.exit(1);
    }

    console.log('✓ No schema drift');
}

main();

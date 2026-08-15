import { query, withDatabaseAdvisoryLock } from './db';
import {
    CALCULATION_TRACES_SCHEMA_SQL,
    FINANCIAL_ACTIONS_SCHEMA_SQL,
} from './financial-actions/schema';
import {
    FAMILY_OFFICE_SCHEMA_SQL,
    LIVING_PLAN_SCHEMA_SQL,
} from './planning/schema';
import {
    CANONICAL_DOCUMENT_SCHEMA_SQL,
    LEGACY_DOCUMENT_BACKFILL_SQL,
} from './documents/schema';

const SCHEMA_META_DDL = `
    CREATE TABLE IF NOT EXISTS gnucash_web_schema_meta (
        step_name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS gnucash_web_migration_backups (
        step_name TEXT NOT NULL,
        source_table TEXT NOT NULL,
        row_key TEXT NOT NULL,
        row_data JSONB NOT NULL,
        backed_up_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (step_name, source_table, row_key)
    );
`;

async function runOneTimeMigration(stepName: string, operation: () => Promise<unknown>): Promise<boolean> {
    const applied = await query(
        'SELECT 1 FROM gnucash_web_schema_meta WHERE step_name = $1 LIMIT 1',
        [stepName],
    );
    if (applied.rowCount) return false;
    await operation();
    await query(
        `INSERT INTO gnucash_web_schema_meta (step_name)
         VALUES ($1) ON CONFLICT (step_name) DO NOTHING`,
        [stepName],
    );
    console.log(`✓ One-time database migration applied: ${stepName}`);
    return true;
}

/**
 * Creates the account_hierarchy view if it doesn't exist.
 * This view provides a recursive hierarchy of accounts with their full paths.
 */
async function createAccountHierarchyView() {
    const viewDDL = `
        CREATE OR REPLACE VIEW account_hierarchy AS
        WITH RECURSIVE ancestors AS (
            -- Base case: top-level accounts (direct children of Root Account)
            SELECT 
                1 AS depth,
                a.name AS level1,
                NULL::text AS level2,
                NULL::text AS level3,
                NULL::text AS level4,
                NULL::text AS level5,
                NULL::text AS level6,
                a.guid AS guid1,
                NULL::text AS guid2,
                NULL::text AS guid3,
                NULL::text AS guid4,
                NULL::text AS guid5,
                NULL::text AS guid6,
                a.name::varchar AS fullname,
                a.guid,
                a.name,
                a.account_type,
                a.commodity_guid,
                a.commodity_scu,
                a.non_std_scu,
                a.parent_guid,
                a.code,
                a.description,
                a.hidden,
                a.placeholder,
                a.guid AS top_level_guid
            FROM accounts a
            WHERE a.parent_guid IN (
                SELECT guid
                FROM accounts
                WHERE account_type = 'ROOT'
            )
            
            UNION ALL
            
            -- Recursive case: child accounts
            SELECT 
                c.depth + 1 AS depth,
                c.level1,
                CASE WHEN c.depth = 1 THEN a.name ELSE c.level2 END AS level2,
                CASE WHEN c.depth = 2 THEN a.name ELSE c.level3 END AS level3,
                CASE WHEN c.depth = 3 THEN a.name ELSE c.level4 END AS level4,
                CASE WHEN c.depth = 4 THEN a.name ELSE c.level5 END AS level5,
                CASE WHEN c.depth = 5 THEN a.name ELSE c.level6 END AS level6,
                c.guid1,
                CASE WHEN c.depth = 1 THEN a.guid ELSE c.guid2 END AS guid2,
                CASE WHEN c.depth = 2 THEN a.guid ELSE c.guid3 END AS guid3,
                CASE WHEN c.depth = 3 THEN a.guid ELSE c.guid4 END AS guid4,
                CASE WHEN c.depth = 4 THEN a.guid ELSE c.guid5 END AS guid5,
                CASE WHEN c.depth = 5 THEN a.guid ELSE c.guid6 END AS guid6,
                (c.fullname || ':' || a.name)::varchar AS fullname,
                a.guid,
                a.name,
                a.account_type,
                a.commodity_guid,
                a.commodity_scu,
                a.non_std_scu,
                a.parent_guid,
                a.code,
                a.description,
                a.hidden,
                a.placeholder,
                c.top_level_guid
            FROM accounts a
            JOIN ancestors c ON c.guid = a.parent_guid
        )
        SELECT 
            depth,
            level1,
            level2,
            level3,
            level4,
            level5,
            level6,
            guid1,
            guid2,
            guid3,
            guid4,
            guid5,
            guid6,
            fullname,
            guid,
            name,
            account_type,
            commodity_guid,
            commodity_scu,
            non_std_scu,
            parent_guid,
            code,
            description,
            hidden,
            placeholder,
            top_level_guid
        FROM ancestors;
    `;

    try {
        await query(viewDDL);
        console.log('✓ account_hierarchy view created/updated successfully');
    } catch (error) {
        console.error('Error creating account_hierarchy view:', error);
        throw error;
    }
}

/**
 * Diagnostic for a failed legacy document backfill: names the legacy rows
 * whose `book_guid` has no matching `books` row, which is what breaks the
 * FK-guarded insert into gnucash_web_documents. Purely informational — no
 * user data is deleted or rewritten.
 */
async function reportOrphanedBookGuids() {
    const sources: Array<[string, string]> = [
        ['gnucash_web_receipts', 'id'],
        ['gnucash_web_payslips', 'id'],
        ['gnucash_web_entity_documents', 'id'],
        ['gnucash_web_home_item_photos', 'id'],
        ['gnucash_web_statement_batches', 'id'],
    ];
    for (const [table, idColumn] of sources) {
        try {
            const result = await query(
                `SELECT COUNT(*)::int AS orphans
                   FROM ${table} t
                  WHERE t.book_guid IS NOT NULL
                    AND NOT EXISTS (SELECT 1 FROM books b WHERE b.guid = t.book_guid)`,
            );
            const orphans = Number(result.rows?.[0]?.orphans ?? 0);
            if (orphans > 0) {
                console.error(
                    `  -> ${table}: ${orphans} row(s) reference a book_guid with no matching books row. ` +
                    `Find them with: SELECT ${idColumn}, book_guid FROM ${table} t WHERE NOT EXISTS (SELECT 1 FROM books b WHERE b.guid = t.book_guid);`,
                );
            }
        } catch {
            // Table may not exist (lazy schema) — nothing to report.
        }
    }
}

/**
 * Business entities the ownership backfill could not attribute to a book.
 *
 * Ownership is fail-closed — an unattributed entity is invisible to every book
 * rather than visible to all of them — so a gap is a data-loss-shaped problem,
 * not a leak. It still has to be loud, because the entity silently disappears
 * from the UI until someone assigns it.
 */
async function reportUnattributedBusinessEntities() {
    const entities: Array<[string, string]> = [
        ['customer', 'customers'],
        ['vendor', 'vendors'],
        ['employee', 'employees'],
        ['job', 'jobs'],
        ['invoice', 'invoices'],
        ['order', 'orders'],
        ['billterm', 'billterms'],
        ['taxtable', 'taxtables'],
    ];
    for (const [entityType, table] of entities) {
        try {
            const result = await query(
                `SELECT COUNT(*)::int AS unattributed
                   FROM ${table} e
                  WHERE NOT EXISTS (
                        SELECT 1 FROM gnucash_web_business_entity_ownership o
                         WHERE o.entity_type = $1 AND o.entity_guid = e.guid)`,
                [entityType],
            );
            const unattributed = Number(result.rows?.[0]?.unattributed ?? 0);
            if (unattributed > 0) {
                console.error(
                    `  -> ${table}: ${unattributed} row(s) could not be attributed to a book and are ` +
                    `hidden from every book until assigned. List them with: ` +
                    `SELECT guid FROM ${table} e WHERE NOT EXISTS (SELECT 1 FROM gnucash_web_business_entity_ownership o WHERE o.entity_type = '${entityType}' AND o.entity_guid = e.guid);`,
                );
            }
        } catch {
            // Native business tables are absent on a non-business book — nothing to report.
        }
    }
}

/**
 * Creates the gnucash_web extension tables if they don't exist.
 * These tables are used for authentication and audit logging.
 */
async function createExtensionTables() {
    const userTableDDL = `
        CREATE TABLE IF NOT EXISTS gnucash_web_users (
            id SERIAL PRIMARY KEY,
            username VARCHAR(255) UNIQUE NOT NULL,
            password_hash VARCHAR(255) NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            last_login TIMESTAMP
        );
    `;

    const auditTableDDL = `
        CREATE TABLE IF NOT EXISTS gnucash_web_audit (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES gnucash_web_users(id),
            action VARCHAR(50) NOT NULL,
            entity_type VARCHAR(50) NOT NULL,
            entity_guid VARCHAR(32) NOT NULL,
            old_values JSONB,
            new_values JSONB,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `;

    // Migration: Add balance_reversal column to existing users table
    const addBalanceReversalDDL = `
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_name = 'gnucash_web_users'
                AND column_name = 'balance_reversal'
            ) THEN
                ALTER TABLE gnucash_web_users
                ADD COLUMN balance_reversal VARCHAR(20) DEFAULT 'none';
            END IF;
        END $$;
    `;

    // Migration: OIDC support — identity columns + nullable password for OIDC-only users
    const addOidcColumnsDDL = `
        ALTER TABLE gnucash_web_users
        ADD COLUMN IF NOT EXISTS email VARCHAR(255),
        ADD COLUMN IF NOT EXISTS oidc_subject VARCHAR(255),
        ADD COLUMN IF NOT EXISTS oidc_issuer VARCHAR(500),
        ADD COLUMN IF NOT EXISTS auth_method VARCHAR(20) NOT NULL DEFAULT 'password',
        ADD COLUMN IF NOT EXISTS display_name VARCHAR(255),
        ADD COLUMN IF NOT EXISTS avatar_url TEXT;

        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_name = 'gnucash_web_users'
                AND column_name = 'password_hash'
                AND is_nullable = 'NO'
            ) THEN
                ALTER TABLE gnucash_web_users
                ALTER COLUMN password_hash DROP NOT NULL;
            END IF;
        END $$;

        CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique
            ON gnucash_web_users(email) WHERE email IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_users_oidc_identity
            ON gnucash_web_users(oidc_issuer, oidc_subject)
            WHERE oidc_issuer IS NOT NULL AND oidc_subject IS NOT NULL;
    `;

    // Migration: Add name and description columns to books table
    const addBooksColumnsDDL = `
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_name = 'books'
                AND column_name = 'name'
            ) THEN
                ALTER TABLE books
                ADD COLUMN name VARCHAR(255);
            END IF;
            IF NOT EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_name = 'books'
                AND column_name = 'description'
            ) THEN
                ALTER TABLE books
                ADD COLUMN description TEXT;
            END IF;
        END $$;
    `;

    // Migration: Add saved_reports table
    const savedReportsTableDDL = `
        CREATE TABLE IF NOT EXISTS gnucash_web_saved_reports (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES gnucash_web_users(id) ON DELETE CASCADE,
            base_report_type VARCHAR(50) NOT NULL,
            name VARCHAR(255) NOT NULL,
            description TEXT,
            config JSONB NOT NULL DEFAULT '{}',
            filters JSONB,
            is_starred BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_saved_reports_user_id ON gnucash_web_saved_reports(user_id);
    `;

    const savedReportsTriggerDDL = `
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_trigger
                WHERE tgname = 'update_saved_reports_updated_at'
            ) THEN
                CREATE OR REPLACE FUNCTION update_updated_at_column()
                RETURNS TRIGGER AS $func$
                BEGIN
                    NEW.updated_at = CURRENT_TIMESTAMP;
                    RETURN NEW;
                END;
                $func$ LANGUAGE plpgsql;

                CREATE TRIGGER update_saved_reports_updated_at
                BEFORE UPDATE ON gnucash_web_saved_reports
                FOR EACH ROW
                EXECUTE FUNCTION update_updated_at_column();
            END IF;
        END $$;
    `;

    const commodityMetadataTableDDL = `
        CREATE TABLE IF NOT EXISTS gnucash_web_commodity_metadata (
            id SERIAL PRIMARY KEY,
            commodity_guid VARCHAR(32) NOT NULL,
            mnemonic VARCHAR(50) NOT NULL,
            sector VARCHAR(255),
            industry VARCHAR(255),
            sector_weights JSONB,
            asset_class VARCHAR(50),
            last_updated TIMESTAMP NOT NULL DEFAULT NOW(),
            created_at TIMESTAMP NOT NULL DEFAULT NOW(),
            UNIQUE(commodity_guid)
        );
        CREATE INDEX IF NOT EXISTS idx_commodity_metadata_mnemonic ON gnucash_web_commodity_metadata(mnemonic);
    `;

    const depreciationSchedulesTableDDL = `
        CREATE TABLE IF NOT EXISTS gnucash_web_depreciation_schedules (
            id SERIAL PRIMARY KEY,
            account_guid VARCHAR(32) NOT NULL,
            purchase_price DECIMAL(15, 2) NOT NULL,
            purchase_date DATE NOT NULL,
            useful_life_years INTEGER NOT NULL,
            salvage_value DECIMAL(15, 2) NOT NULL DEFAULT 0,
            method VARCHAR(30) NOT NULL,
            decline_rate DECIMAL(5, 4),
            contra_account_guid VARCHAR(32) NOT NULL,
            frequency VARCHAR(20) NOT NULL DEFAULT 'monthly',
            is_appreciation BOOLEAN NOT NULL DEFAULT FALSE,
            last_transaction_date DATE,
            enabled BOOLEAN NOT NULL DEFAULT TRUE,
            notes TEXT,
            created_at TIMESTAMP NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
            UNIQUE(account_guid)
        );
        CREATE INDEX IF NOT EXISTS idx_depreciation_schedules_account ON gnucash_web_depreciation_schedules(account_guid);
    `;

    const transactionMetaTableDDL = `
        CREATE TABLE IF NOT EXISTS gnucash_web_transaction_meta (
            id SERIAL PRIMARY KEY,
            transaction_guid VARCHAR(32) NOT NULL UNIQUE,
            source VARCHAR(50) NOT NULL DEFAULT 'manual',
            reviewed BOOLEAN NOT NULL DEFAULT TRUE,
            imported_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            simplefin_transaction_id VARCHAR(255),
            confidence VARCHAR(20)
        );
        CREATE INDEX IF NOT EXISTS idx_txn_meta_source ON gnucash_web_transaction_meta(source) WHERE source != 'manual';
        -- simplefin_transaction_id lookups are served by the unique partial
        -- index created in createUniqueConstraintGuards; the legacy
        -- non-unique duplicate is dropped by dropRedundantIndexes once the
        -- unique index exists.
    `;

    const userPreferencesTableDDL = `
        CREATE TABLE IF NOT EXISTS gnucash_web_user_preferences (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES gnucash_web_users(id) ON DELETE CASCADE,
            preference_key VARCHAR(100) NOT NULL,
            preference_value TEXT NOT NULL,
            updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
            UNIQUE(user_id, preference_key)
        );
        CREATE INDEX IF NOT EXISTS idx_user_preferences_user ON gnucash_web_user_preferences(user_id);
    `;

    const rolesTableDDL = `
        CREATE TABLE IF NOT EXISTS gnucash_web_roles (
            id SERIAL PRIMARY KEY,
            name VARCHAR(50) UNIQUE NOT NULL,
            description TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        -- Seed default roles
        INSERT INTO gnucash_web_roles (name, description)
        VALUES
            ('readonly', 'View-only access to book data and reports'),
            ('edit', 'Can create, edit, and delete transactions, budgets, and accounts'),
            ('admin', 'Full access including user management and book administration'),
            ('timekeeper', 'Time tracking only — can log time against projects but cannot see books or financials')
        ON CONFLICT (name) DO NOTHING;
    `;

    const bookPermissionsTableDDL = `
        CREATE TABLE IF NOT EXISTS gnucash_web_book_permissions (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES gnucash_web_users(id) ON DELETE CASCADE,
            book_guid VARCHAR(32) NOT NULL,
            role_id INTEGER NOT NULL REFERENCES gnucash_web_roles(id),
            granted_by INTEGER REFERENCES gnucash_web_users(id) ON DELETE SET NULL,
            granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(user_id, book_guid)
        );
        CREATE INDEX IF NOT EXISTS idx_bp_user_book ON gnucash_web_book_permissions(user_id, book_guid);
        CREATE INDEX IF NOT EXISTS idx_bp_book_role ON gnucash_web_book_permissions(book_guid, role_id);
    `;

    const invitationsTableDDL = `
        CREATE TABLE IF NOT EXISTS gnucash_web_invitations (
            id SERIAL PRIMARY KEY,
            code VARCHAR(64) UNIQUE NOT NULL,
            book_guid VARCHAR(32) NOT NULL,
            role_id INTEGER NOT NULL REFERENCES gnucash_web_roles(id),
            created_by INTEGER NOT NULL REFERENCES gnucash_web_users(id) ON DELETE CASCADE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            expires_at TIMESTAMP NOT NULL,
            used_by INTEGER REFERENCES gnucash_web_users(id) ON DELETE SET NULL,
            used_at TIMESTAMP,
            max_uses INTEGER DEFAULT 1,
            use_count INTEGER DEFAULT 0,
            is_revoked BOOLEAN DEFAULT FALSE,
            revoked_by INTEGER REFERENCES gnucash_web_users(id) ON DELETE SET NULL,
            revoked_at TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_inv_code ON gnucash_web_invitations(code);
        CREATE INDEX IF NOT EXISTS idx_inv_book ON gnucash_web_invitations(book_guid, is_revoked);
    `;

    const simpleFinConnectionsTableDDL = `
        CREATE TABLE IF NOT EXISTS gnucash_web_simplefin_connections (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES gnucash_web_users(id) ON DELETE CASCADE,
            book_guid VARCHAR(32) NOT NULL,
            access_url_encrypted TEXT NOT NULL,
            last_sync_at TIMESTAMP,
            last_sync_status VARCHAR(20),
            last_sync_error TEXT,
            last_sync_error_at TIMESTAMP,
            last_successful_sync_at TIMESTAMP,
            sync_enabled BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(user_id, book_guid)
        );
    `;

    const simpleFinConnectionsAddHealthDDL = `
        ALTER TABLE gnucash_web_simplefin_connections
        ADD COLUMN IF NOT EXISTS last_sync_status VARCHAR(20),
        ADD COLUMN IF NOT EXISTS last_sync_error TEXT,
        ADD COLUMN IF NOT EXISTS last_sync_error_at TIMESTAMP,
        ADD COLUMN IF NOT EXISTS last_successful_sync_at TIMESTAMP;
    `;

    const simpleFinAccountMapTableDDL = `
        CREATE TABLE IF NOT EXISTS gnucash_web_simplefin_account_map (
            id SERIAL PRIMARY KEY,
            connection_id INTEGER NOT NULL REFERENCES gnucash_web_simplefin_connections(id) ON DELETE CASCADE,
            simplefin_account_id VARCHAR(255) NOT NULL,
            simplefin_account_name VARCHAR(255),
            simplefin_institution VARCHAR(255),
            simplefin_last4 VARCHAR(4),
            gnucash_account_guid VARCHAR(32),
            last_sync_at TIMESTAMP,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(connection_id, simplefin_account_id)
        );
    `;

    const simpleFinAccountMapAddInvestmentDDL = `
        ALTER TABLE gnucash_web_simplefin_account_map
        ADD COLUMN IF NOT EXISTS is_investment BOOLEAN NOT NULL DEFAULT FALSE;
    `;

    const transactionMetaAddDeletedAtDDL = `
        ALTER TABLE gnucash_web_transaction_meta
        ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
    `;

    const transactionMetaNullableGuidDDL = `
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_name = 'gnucash_web_transaction_meta'
                AND column_name = 'transaction_guid'
                AND is_nullable = 'NO'
            ) THEN
                ALTER TABLE gnucash_web_transaction_meta
                ALTER COLUMN transaction_guid DROP NOT NULL;
            END IF;
        END $$;
    `;

    const simpleFinAccountMapAddBalanceDDL = `
        ALTER TABLE gnucash_web_simplefin_account_map
        ADD COLUMN IF NOT EXISTS last_balance DECIMAL,
        ADD COLUMN IF NOT EXISTS last_balance_date TIMESTAMP;
    `;

    const transactionMetaAddMatchColumnsDDL = `
        ALTER TABLE gnucash_web_transaction_meta
        ADD COLUMN IF NOT EXISTS match_type VARCHAR(30),
        ADD COLUMN IF NOT EXISTS match_confidence VARCHAR(10),
        ADD COLUMN IF NOT EXISTS matched_at TIMESTAMP,
        ADD COLUMN IF NOT EXISTS simplefin_transaction_id_2 VARCHAR(255);

        CREATE INDEX IF NOT EXISTS idx_txn_meta_simplefin_id_2
        ON gnucash_web_transaction_meta(simplefin_transaction_id_2)
        WHERE simplefin_transaction_id_2 IS NOT NULL;
    `;

    // Migration: preserve the description an import arrived with (the raw
    // provider payee). Set once at import/link time and NEVER overwritten, so
    // renaming an imported transaction no longer destroys the payee.
    const transactionMetaAddOriginalDescriptionDDL = `
        ALTER TABLE gnucash_web_transaction_meta
        ADD COLUMN IF NOT EXISTS original_description TEXT;
    `;

    // Migration: Add tool_config table
    const toolConfigTableDDL = `
        CREATE TABLE IF NOT EXISTS gnucash_web_tool_config (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES gnucash_web_users(id) ON DELETE CASCADE,
            book_guid VARCHAR(32) NOT NULL,
            tool_type VARCHAR(50) NOT NULL,
            name VARCHAR(255) NOT NULL,
            account_guid VARCHAR(32),
            config JSONB NOT NULL DEFAULT '{}',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_tool_config_user_id ON gnucash_web_tool_config(user_id);
        CREATE INDEX IF NOT EXISTS idx_tool_config_tool_type ON gnucash_web_tool_config(tool_type);
        CREATE INDEX IF NOT EXISTS idx_tool_config_user_book ON gnucash_web_tool_config(user_id, book_guid, tool_type);

    `;

    const toolConfigNormalizeDDL = `
        INSERT INTO gnucash_web_migration_backups
          (step_name, source_table, row_key, row_data)
        SELECT
          '2026-08-05-tool-config-scope-normalization',
          'gnucash_web_tool_config',
          id::text,
          to_jsonb(config)
        FROM gnucash_web_tool_config config
        ON CONFLICT (step_name, source_table, row_key) DO NOTHING;

        DELETE FROM gnucash_web_tool_config older
        USING gnucash_web_tool_config newer
        WHERE older.id < newer.id
          AND older.book_guid = newer.book_guid
          AND older.tool_type = newer.tool_type
          AND older.user_id IS NOT DISTINCT FROM newer.user_id
          AND older.account_guid IS NULL
          AND newer.account_guid IS NULL;
        DELETE FROM gnucash_web_tool_config older
        USING gnucash_web_tool_config newer
        WHERE older.id < newer.id
          AND older.user_id = newer.user_id
          AND older.book_guid = newer.book_guid
          AND older.tool_type = newer.tool_type
          AND older.account_guid = newer.account_guid
          AND older.account_guid IS NOT NULL;

        WITH newest_farm AS (
          SELECT DISTINCT ON (book_guid) id, book_guid
          FROM gnucash_web_tool_config
          WHERE tool_type = 'farm_analyzer'
            AND user_id IS NOT NULL
            AND account_guid IS NULL
          ORDER BY book_guid, updated_at DESC, id DESC
        )
        UPDATE gnucash_web_tool_config config
        SET user_id = NULL
        FROM newest_farm candidate
        WHERE config.id = candidate.id
          AND NOT EXISTS (
            SELECT 1
            FROM gnucash_web_tool_config shared
            WHERE shared.book_guid = candidate.book_guid
              AND shared.tool_type = 'farm_analyzer'
              AND shared.user_id IS NULL
              AND shared.account_guid IS NULL
          );
        DELETE FROM gnucash_web_tool_config
        WHERE tool_type = 'farm_analyzer'
          AND user_id IS NOT NULL
          AND account_guid IS NULL;
    `;

    const toolConfigUniqueIndexesDDL = `
        CREATE UNIQUE INDEX IF NOT EXISTS uq_tool_config_user_singleton
          ON gnucash_web_tool_config(user_id, book_guid, tool_type)
          WHERE user_id IS NOT NULL AND account_guid IS NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS uq_tool_config_book_singleton
          ON gnucash_web_tool_config(book_guid, tool_type)
          WHERE user_id IS NULL AND account_guid IS NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS uq_tool_config_account_instance
          ON gnucash_web_tool_config(user_id, book_guid, tool_type, account_guid)
          WHERE user_id IS NOT NULL AND account_guid IS NOT NULL;
    `;

    const accountPreferencesTableDDL = `
        CREATE TABLE IF NOT EXISTS gnucash_web_account_preferences (
            account_guid VARCHAR(32) PRIMARY KEY,
            cost_basis_method VARCHAR(20)
        );
    `;

    const accountPreferencesRetirementDDL = `
        ALTER TABLE gnucash_web_account_preferences
        ADD COLUMN IF NOT EXISTS is_retirement BOOLEAN NOT NULL DEFAULT FALSE;

        ALTER TABLE gnucash_web_account_preferences
        ADD COLUMN IF NOT EXISTS retirement_account_type VARCHAR(20);

        ALTER TABLE gnucash_web_account_preferences
        ADD COLUMN IF NOT EXISTS tax_related BOOLEAN NOT NULL DEFAULT FALSE;

        ALTER TABLE gnucash_web_account_preferences
        ADD COLUMN IF NOT EXISTS lot_assignment_method VARCHAR(20);

        ALTER TABLE gnucash_web_account_preferences
        ADD COLUMN IF NOT EXISTS owner VARCHAR(10);
    `;

    const contributionLimitsTableDDL = `
        CREATE TABLE IF NOT EXISTS gnucash_web_contribution_limits (
            id SERIAL PRIMARY KEY,
            tax_year INTEGER NOT NULL,
            account_type VARCHAR(20) NOT NULL,
            base_limit DECIMAL(12,2) NOT NULL,
            catch_up_limit DECIMAL(12,2) NOT NULL DEFAULT 0,
            catch_up_age INTEGER NOT NULL DEFAULT 50,
            notes VARCHAR(255),
            UNIQUE(tax_year, account_type)
        );
    `;

    const contributionTaxYearTableDDL = `
        CREATE TABLE IF NOT EXISTS gnucash_web_contribution_tax_year (
            split_guid VARCHAR(32) PRIMARY KEY,
            tax_year INTEGER NOT NULL
        );
    `;

    const transactionTypesTableDDL = `
        CREATE TABLE IF NOT EXISTS gnucash_web_transaction_types (
            split_guid VARCHAR(32) PRIMARY KEY,
            transaction_type VARCHAR(30) NOT NULL
        );
    `;

    const receiptsTableDDL = `
    CREATE TABLE IF NOT EXISTS gnucash_web_receipts (
        id SERIAL PRIMARY KEY,
        book_guid VARCHAR(32) NOT NULL,
        transaction_guid VARCHAR(32),
        filename VARCHAR(255) NOT NULL,
        storage_key VARCHAR(500) NOT NULL,
        thumbnail_key VARCHAR(500),
        mime_type VARCHAR(100) NOT NULL,
        file_size INTEGER NOT NULL,
        ocr_text TEXT,
        ocr_status VARCHAR(20) NOT NULL DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        created_by INTEGER REFERENCES gnucash_web_users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_receipts_transaction ON gnucash_web_receipts(transaction_guid);
    CREATE INDEX IF NOT EXISTS idx_receipts_book ON gnucash_web_receipts(book_guid);
    CREATE INDEX IF NOT EXISTS idx_receipts_created_by ON gnucash_web_receipts(created_by);
`;

    const receiptsExtractedDataDDL = `
    ALTER TABLE gnucash_web_receipts
    ADD COLUMN IF NOT EXISTS extracted_data JSONB;
`;

    const receiptsFtsDDL = `
    DO $$
    BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'gnucash_web_receipts'
            AND column_name = 'ocr_tsvector'
        ) THEN
            ALTER TABLE gnucash_web_receipts
            ADD COLUMN ocr_tsvector tsvector
              GENERATED ALWAYS AS (to_tsvector('english', COALESCE(ocr_text, ''))) STORED;
        END IF;
    END $$;
    CREATE INDEX IF NOT EXISTS idx_receipts_ocr_fts
      ON gnucash_web_receipts USING GIN (ocr_tsvector);
`;

    const payslipsTableDDL = `
    CREATE TABLE IF NOT EXISTS gnucash_web_payslips (
        id SERIAL PRIMARY KEY,
        book_guid VARCHAR(32) NOT NULL,
        pay_date DATE NOT NULL,
        pay_period_start DATE,
        pay_period_end DATE,
        employer_name VARCHAR(255) NOT NULL,
        gross_pay DECIMAL(12,2),
        net_pay DECIMAL(12,2),
        currency VARCHAR(10) NOT NULL DEFAULT 'USD',
        source VARCHAR(20) NOT NULL DEFAULT 'pdf_upload',
        source_id VARCHAR(255),
        transaction_guid VARCHAR(32),
        storage_key VARCHAR(500),
        thumbnail_key VARCHAR(500),
        line_items JSONB,
        raw_response JSONB,
        status VARCHAR(20) NOT NULL DEFAULT 'processing',
        error_message TEXT,
        deposit_account_guid VARCHAR(32),
        created_by INTEGER REFERENCES gnucash_web_users(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_payslips_book ON gnucash_web_payslips(book_guid);
    CREATE INDEX IF NOT EXISTS idx_payslips_pay_date ON gnucash_web_payslips(pay_date);
    CREATE INDEX IF NOT EXISTS idx_payslips_status ON gnucash_web_payslips(status);
    CREATE INDEX IF NOT EXISTS idx_payslips_employer ON gnucash_web_payslips(employer_name);

    CREATE TABLE IF NOT EXISTS gnucash_web_payslip_mappings (
        id SERIAL PRIMARY KEY,
        book_guid VARCHAR(32) NOT NULL,
        employer_name VARCHAR(255) NOT NULL,
        normalized_label VARCHAR(255) NOT NULL,
        line_item_category VARCHAR(30) NOT NULL,
        account_guid VARCHAR(32) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(book_guid, employer_name, normalized_label, line_item_category)
    );
    CREATE INDEX IF NOT EXISTS idx_payslip_mappings_employer ON gnucash_web_payslip_mappings(book_guid, employer_name);

    CREATE TABLE IF NOT EXISTS gnucash_web_payslip_templates (
        id SERIAL PRIMARY KEY,
        book_guid VARCHAR(32) NOT NULL,
        employer_name VARCHAR(255) NOT NULL,
        line_items JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(book_guid, employer_name)
    );
    CREATE INDEX IF NOT EXISTS idx_payslip_templates_book ON gnucash_web_payslip_templates(book_guid);
`;

    const aiConfigTableDDL = `
    CREATE TABLE IF NOT EXISTS gnucash_web_ai_config (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES gnucash_web_users(id) ON DELETE CASCADE,
        provider VARCHAR(50) NOT NULL DEFAULT 'none',
        base_url VARCHAR(500),
        api_key_encrypted TEXT,
        model VARCHAR(100),
        enabled BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id)
    );
`;

    const toolConfigTriggerDDL = `
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_trigger
                WHERE tgname = 'update_tool_config_updated_at'
            ) THEN
                CREATE TRIGGER update_tool_config_updated_at
                BEFORE UPDATE ON gnucash_web_tool_config
                FOR EACH ROW
                EXECUTE FUNCTION update_updated_at_column();
            END IF;
        END $$;
    `;

    // Tagging tables: flat labels applied to accounts and transactions
    const tagsTableDDL = `
        CREATE TABLE IF NOT EXISTS gnucash_web_tags (
            id SERIAL PRIMARY KEY,
            name VARCHAR(100) UNIQUE NOT NULL,
            color VARCHAR(20),
            description TEXT,
            created_at TIMESTAMP DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS gnucash_web_transaction_tags (
            transaction_guid VARCHAR(32) NOT NULL,
            tag_id INTEGER NOT NULL REFERENCES gnucash_web_tags(id) ON DELETE CASCADE,
            PRIMARY KEY (transaction_guid, tag_id)
        );
        CREATE INDEX IF NOT EXISTS idx_transaction_tags_tag ON gnucash_web_transaction_tags(tag_id);

        CREATE TABLE IF NOT EXISTS gnucash_web_account_tags (
            account_guid VARCHAR(32) NOT NULL,
            tag_id INTEGER NOT NULL REFERENCES gnucash_web_tags(id) ON DELETE CASCADE,
            PRIMARY KEY (account_guid, tag_id)
        );
        CREATE INDEX IF NOT EXISTS idx_account_tags_tag ON gnucash_web_account_tags(tag_id);
    `;

    // Tax estimator: account -> tax category mappings
    const taxMappingsTableDDL = `
        CREATE TABLE IF NOT EXISTS gnucash_web_tax_mappings (
            account_guid VARCHAR(32) PRIMARY KEY,
            tax_category VARCHAR(40) NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_tax_mappings_category ON gnucash_web_tax_mappings(tax_category);
    `;

    // Entity/household profile per book: consumed by the tax estimator
    // (filing mode per entity type) and contribution tracking (per-spouse limits)
    const entityProfilesTableDDL = `
        CREATE TABLE IF NOT EXISTS gnucash_web_entity_profiles (
            book_guid VARCHAR(32) PRIMARY KEY,
            entity_type VARCHAR(20) NOT NULL DEFAULT 'household',
            entity_name VARCHAR(255),
            tax_state VARCHAR(10),
            notes TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS gnucash_web_entity_members (
            id SERIAL PRIMARY KEY,
            book_guid VARCHAR(32) NOT NULL,
            role VARCHAR(20) NOT NULL,
            name VARCHAR(255),
            birthday DATE,
            covered_by_employer_plan BOOLEAN NOT NULL DEFAULT false,
            ownership_percent DOUBLE PRECISION,
            sort_order INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_entity_members_book ON gnucash_web_entity_members(book_guid);
    `;

    // Per-book tax profile fields: filing status and flat state rate move onto
    // the entity profile so the tax estimator follows the active book instead
    // of user-global preferences (which remain the synthesized fallback).
    // Advisory-locked: app and worker run db-init concurrently at startup, and
    // unguarded CREATE TABLE IF NOT EXISTS races fail on pg_type uniqueness
    // (same reason notificationsTableDDL locks).
    const entityProfilesTaxColumnsDDL = `
        DO $$
        BEGIN
            PERFORM pg_advisory_xact_lock(hashtext('gnucash_web_entity_profiles_tax_columns'));
            ALTER TABLE gnucash_web_entity_profiles ADD COLUMN IF NOT EXISTS filing_status VARCHAR(10);
            ALTER TABLE gnucash_web_entity_profiles ADD COLUMN IF NOT EXISTS state_flat_rate DOUBLE PRECISION;
        END $$;
    `;

    // Business activity of the entity (e.g. 'farm' for a Schedule F apiary or
    // ranch vs the 'general' Schedule C default). Orthogonal to entity_type —
    // a farm can be a sole prop or an LLC. Drives the farm chart-of-accounts
    // template, Schedule F report, and farm compliance-calendar items.
    const entityProfilesActivityColumnDDL = `
        DO $$
        BEGIN
            PERFORM pg_advisory_xact_lock(hashtext('gnucash_web_entity_profiles_activity'));
            ALTER TABLE gnucash_web_entity_profiles ADD COLUMN IF NOT EXISTS business_activity VARCHAR(20) NOT NULL DEFAULT 'general';
        END $$;
    `;

    // Per-book feature-module overrides. Absence of a row means "use the
    // default for the book's entity type" (see src/lib/book-features.ts).
    const bookFeaturesTableDDL = `
        DO $$
        BEGIN
            PERFORM pg_advisory_xact_lock(hashtext('gnucash_web_book_features_schema'));
            CREATE TABLE IF NOT EXISTS gnucash_web_book_features (
                book_guid VARCHAR(32) NOT NULL,
                feature_key VARCHAR(50) NOT NULL,
                enabled BOOLEAN NOT NULL,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (book_guid, feature_key)
            );
        END $$;
    `;

    // Book-scope the audit trail: history must never leak across books/users.
    // Adds book_guid, backfills legacy rows by walking each book's account
    // tree (ACCOUNT entries directly; TRANSACTION entries via their splits).
    // Rows that can't be attributed (e.g. deleted transactions whose splits
    // are gone) stay NULL and are hidden from per-book history.
    const auditBookScopeDDL = `
        DO $$
        BEGIN
            PERFORM pg_advisory_xact_lock(hashtext('gnucash_web_audit_book_scope'));
            ALTER TABLE gnucash_web_audit ADD COLUMN IF NOT EXISTS book_guid VARCHAR(32);
            CREATE INDEX IF NOT EXISTS idx_audit_book_created
                ON gnucash_web_audit(book_guid, created_at DESC);

            IF EXISTS (SELECT 1 FROM gnucash_web_audit WHERE book_guid IS NULL LIMIT 1) THEN
                WITH RECURSIVE tree AS (
                    SELECT b.guid AS book_guid, b.root_account_guid AS account_guid FROM books b
                    UNION ALL
                    SELECT t.book_guid, a.guid FROM accounts a
                    JOIN tree t ON a.parent_guid = t.account_guid
                )
                UPDATE gnucash_web_audit au SET book_guid = t.book_guid
                FROM tree t
                WHERE au.book_guid IS NULL
                  AND au.entity_type = 'ACCOUNT'
                  AND au.entity_guid = t.account_guid;

                WITH RECURSIVE tree AS (
                    SELECT b.guid AS book_guid, b.root_account_guid AS account_guid FROM books b
                    UNION ALL
                    SELECT t.book_guid, a.guid FROM accounts a
                    JOIN tree t ON a.parent_guid = t.account_guid
                ), txmap AS (
                    -- scoped to the transactions that actually need backfill
                    SELECT DISTINCT s.tx_guid, t.book_guid
                    FROM splits s
                    JOIN tree t ON s.account_guid = t.account_guid
                    WHERE s.tx_guid IN (
                        SELECT entity_guid FROM gnucash_web_audit
                        WHERE book_guid IS NULL AND entity_type = 'TRANSACTION'
                    )
                )
                UPDATE gnucash_web_audit au SET book_guid = m.book_guid
                FROM txmap m
                WHERE au.book_guid IS NULL
                  AND au.entity_type = 'TRANSACTION'
                  AND au.entity_guid = m.tx_guid;
            END IF;
        END $$;
    `;

    // Undo idempotency for the audit trail: undone_at is the claim marker for
    // the claim-first compare-and-swap in audit.service.undoAuditEntry
    // (UPDATE ... SET undone_at = NOW() WHERE id = ? AND undone_at IS NULL
    // RETURNING id) so two concurrent undos of the same entry can't both
    // apply. undone_by records who claimed it. Advisory-locked like the other
    // ALTERs: app and worker run db-init concurrently at startup.
    const auditUndoColumnsDDL = `
        DO $$
        BEGIN
            PERFORM pg_advisory_xact_lock(hashtext('gnucash_web_audit_undo_columns'));
            ALTER TABLE gnucash_web_audit ADD COLUMN IF NOT EXISTS undone_at TIMESTAMPTZ;
            ALTER TABLE gnucash_web_audit ADD COLUMN IF NOT EXISTS undone_by INTEGER;
        END $$;
    `;

    // Book-scope tags: tag names were globally unique, so every book saw
    // every tag. Adds book_guid, attributes each tag to the book(s) it's
    // used in (cloning tags used across multiple books and repointing the
    // junction rows), then swaps the global name uniqueness for per-book.
    const tagsBookScopeDDL = `
        DO $$
        DECLARE
            v_rec RECORD;
            v_new_id INTEGER;
            v_first_book VARCHAR(32);
        BEGIN
            PERFORM pg_advisory_xact_lock(hashtext('gnucash_web_tags_book_scope'));
            ALTER TABLE gnucash_web_tags ADD COLUMN IF NOT EXISTS book_guid VARCHAR(32);

            IF EXISTS (SELECT 1 FROM gnucash_web_tags WHERE book_guid IS NULL LIMIT 1) THEN
                -- account -> book map, built once and reused below
                CREATE TEMP TABLE _acct_books ON COMMIT DROP AS
                WITH RECURSIVE tree AS (
                    SELECT b.guid AS book_guid, b.root_account_guid AS account_guid FROM books b
                    UNION ALL
                    SELECT t.book_guid, a.guid FROM accounts a
                    JOIN tree t ON a.parent_guid = t.account_guid
                )
                SELECT account_guid, book_guid FROM tree;
                CREATE INDEX ON _acct_books(account_guid);

                CREATE TEMP TABLE _tag_books ON COMMIT DROP AS
                SELECT DISTINCT tag_id, book_guid FROM (
                    SELECT tt.tag_id, ab.book_guid
                    FROM gnucash_web_transaction_tags tt
                    JOIN splits s ON s.tx_guid = tt.transaction_guid
                    JOIN _acct_books ab ON ab.account_guid = s.account_guid
                    UNION
                    SELECT at.tag_id, ab.book_guid
                    FROM gnucash_web_account_tags at
                    JOIN _acct_books ab ON ab.account_guid = at.account_guid
                ) usage;

                -- Home book per tag: the first book it's used in.
                UPDATE gnucash_web_tags g SET book_guid = tb.book_guid
                FROM (
                    SELECT DISTINCT ON (tag_id) tag_id, book_guid
                    FROM _tag_books ORDER BY tag_id, book_guid
                ) tb
                WHERE g.book_guid IS NULL AND g.id = tb.tag_id;

                -- Unused tags land in the first book so they stay visible somewhere.
                SELECT guid INTO v_first_book FROM books ORDER BY guid LIMIT 1;
                UPDATE gnucash_web_tags SET book_guid = v_first_book WHERE book_guid IS NULL;

                -- Tags used in more than one book: clone per extra book and
                -- repoint that book's junction rows to the clone.
                FOR v_rec IN
                    SELECT tb.tag_id, tb.book_guid
                    FROM _tag_books tb
                    JOIN gnucash_web_tags g ON g.id = tb.tag_id
                    WHERE g.book_guid <> tb.book_guid
                LOOP
                    SELECT id INTO v_new_id FROM gnucash_web_tags
                    WHERE book_guid = v_rec.book_guid
                      AND name = (SELECT name FROM gnucash_web_tags WHERE id = v_rec.tag_id);
                    IF v_new_id IS NULL THEN
                        INSERT INTO gnucash_web_tags (name, color, description, book_guid)
                        SELECT name, color, description, v_rec.book_guid
                        FROM gnucash_web_tags WHERE id = v_rec.tag_id
                        RETURNING id INTO v_new_id;
                    END IF;

                    INSERT INTO gnucash_web_transaction_tags (transaction_guid, tag_id)
                    SELECT DISTINCT tt.transaction_guid, v_new_id
                    FROM gnucash_web_transaction_tags tt
                    JOIN splits s ON s.tx_guid = tt.transaction_guid
                    JOIN _acct_books ab ON ab.account_guid = s.account_guid
                    WHERE tt.tag_id = v_rec.tag_id AND ab.book_guid = v_rec.book_guid
                    ON CONFLICT DO NOTHING;
                    DELETE FROM gnucash_web_transaction_tags tt
                    WHERE tt.tag_id = v_rec.tag_id
                      AND EXISTS (SELECT 1 FROM gnucash_web_transaction_tags x
                                  WHERE x.transaction_guid = tt.transaction_guid AND x.tag_id = v_new_id);

                    INSERT INTO gnucash_web_account_tags (account_guid, tag_id)
                    SELECT at.account_guid, v_new_id
                    FROM gnucash_web_account_tags at
                    JOIN _acct_books ab ON ab.account_guid = at.account_guid
                    WHERE at.tag_id = v_rec.tag_id AND ab.book_guid = v_rec.book_guid
                    ON CONFLICT DO NOTHING;
                    DELETE FROM gnucash_web_account_tags at
                    WHERE at.tag_id = v_rec.tag_id
                      AND EXISTS (SELECT 1 FROM gnucash_web_account_tags x
                                  WHERE x.account_guid = at.account_guid AND x.tag_id = v_new_id);
                END LOOP;
            END IF;

            IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gnucash_web_tags_name_key') THEN
                ALTER TABLE gnucash_web_tags DROP CONSTRAINT gnucash_web_tags_name_key;
            END IF;
            CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_book_name
                ON gnucash_web_tags(book_guid, name);
            CREATE INDEX IF NOT EXISTS idx_tags_book ON gnucash_web_tags(book_guid);
        END $$;
    `;

    // Book-scope saved reports: they were user-scoped only, so every book
    // showed every saved report. Adds book_guid and backfills legacy rows by
    // matching account guids referenced in the report's config against each
    // book's account tree (explicit accountGuids array first, then any 32-hex
    // guid anywhere in the config JSON as a fallback). Reports that reference
    // no resolvable account land in the first book so nothing disappears.
    const savedReportsBookScopeDDL = `
        DO $$
        DECLARE
            v_first_book VARCHAR(32);
        BEGIN
            PERFORM pg_advisory_xact_lock(hashtext('gnucash_web_saved_reports_book_scope'));
            ALTER TABLE gnucash_web_saved_reports ADD COLUMN IF NOT EXISTS book_guid VARCHAR(32);
            CREATE INDEX IF NOT EXISTS idx_saved_reports_book
                ON gnucash_web_saved_reports(book_guid);

            IF EXISTS (SELECT 1 FROM gnucash_web_saved_reports WHERE book_guid IS NULL LIMIT 1) THEN
                -- account -> book map, built once and reused below
                CREATE TEMP TABLE _sr_acct_books ON COMMIT DROP AS
                WITH RECURSIVE tree AS (
                    SELECT b.guid AS book_guid, b.root_account_guid AS account_guid FROM books b
                    UNION ALL
                    SELECT t.book_guid, a.guid FROM accounts a
                    JOIN tree t ON a.parent_guid = t.account_guid
                )
                SELECT account_guid, book_guid FROM tree;
                CREATE INDEX ON _sr_acct_books(account_guid);

                -- Pass 1: explicit config->'accountGuids' entries
                UPDATE gnucash_web_saved_reports sr SET book_guid = m.book_guid
                FROM (
                    SELECT DISTINCT ON (src.id) src.id, ab.book_guid
                    FROM (
                        SELECT sr2.id, lower(g.guid) AS guid
                        FROM gnucash_web_saved_reports sr2,
                             jsonb_array_elements_text(sr2.config->'accountGuids') AS g(guid)
                        WHERE sr2.book_guid IS NULL
                          AND jsonb_typeof(sr2.config->'accountGuids') = 'array'
                    ) src
                    JOIN _sr_acct_books ab ON ab.account_guid = src.guid
                    ORDER BY src.id, ab.book_guid
                ) m
                WHERE sr.book_guid IS NULL AND sr.id = m.id;

                -- Pass 2 (fallback): any 32-hex substring anywhere in the
                -- config that matches an account guid
                UPDATE gnucash_web_saved_reports sr SET book_guid = m.book_guid
                FROM (
                    SELECT DISTINCT ON (src.id) src.id, ab.book_guid
                    FROM (
                        SELECT sr2.id, lower(g.match[1]) AS guid
                        FROM gnucash_web_saved_reports sr2,
                             regexp_matches(sr2.config::text, '([0-9a-fA-F]{32})', 'g') AS g(match)
                        WHERE sr2.book_guid IS NULL
                    ) src
                    JOIN _sr_acct_books ab ON ab.account_guid = src.guid
                    ORDER BY src.id, ab.book_guid
                ) m
                WHERE sr.book_guid IS NULL AND sr.id = m.id;

                -- Remaining reports land in the first book so they stay visible
                SELECT guid INTO v_first_book FROM books ORDER BY guid LIMIT 1;
                IF v_first_book IS NOT NULL THEN
                    UPDATE gnucash_web_saved_reports
                    SET book_guid = v_first_book
                    WHERE book_guid IS NULL;
                END IF;
            END IF;
        END $$;
    `;

    // SMB suite: compliance-deadline status, 1099 vendor tax info, prepaid
    // packages, restricted funds, and the entity document vault.
    const smbTablesDDL = `
        DO $$
        BEGIN
        PERFORM pg_advisory_xact_lock(hashtext('gnucash_web_smb_suite_schema'));

        CREATE TABLE IF NOT EXISTS gnucash_web_compliance_status (
            book_guid VARCHAR(32) NOT NULL,
            item_key VARCHAR(80) NOT NULL,
            period VARCHAR(20) NOT NULL,
            status VARCHAR(20) NOT NULL DEFAULT 'done',
            completed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (book_guid, item_key, period)
        );

        CREATE TABLE IF NOT EXISTS gnucash_web_vendor_tax_info (
            vendor_guid VARCHAR(32) PRIMARY KEY,
            book_guid VARCHAR(32),
            legal_name VARCHAR(255),
            tax_classification VARCHAR(40),
            tax_id_masked VARCHAR(20),
            w9_received BOOLEAN NOT NULL DEFAULT false,
            w9_received_date DATE,
            exempt_from_1099 BOOLEAN NOT NULL DEFAULT false,
            address TEXT,
            notes TEXT,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        ALTER TABLE gnucash_web_vendor_tax_info
          ADD COLUMN IF NOT EXISTS w9_requested_date DATE;
        ALTER TABLE gnucash_web_vendor_tax_info
          ADD COLUMN IF NOT EXISTS exempt_from_1099_override BOOLEAN;
        -- Preserve every existing checkbox value as an explicit decision.
        UPDATE gnucash_web_vendor_tax_info
          SET exempt_from_1099_override = exempt_from_1099
          WHERE exempt_from_1099_override IS NULL;

        -- Per-vendor-year 1099-NEC filing status (dates only; no TINs here).
        CREATE TABLE IF NOT EXISTS gnucash_web_vendor_1099_filings (
            vendor_guid VARCHAR(32) NOT NULL,
            tax_year INTEGER NOT NULL,
            book_guid VARCHAR(32),
            filed_1099_nec DATE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (vendor_guid, tax_year)
        );
        CREATE INDEX IF NOT EXISTS idx_vendor_1099_filings_book
            ON gnucash_web_vendor_1099_filings(book_guid);

        CREATE TABLE IF NOT EXISTS gnucash_web_packages (
            id SERIAL PRIMARY KEY,
            book_guid VARCHAR(32) NOT NULL,
            customer_guid VARCHAR(32),
            client_name VARCHAR(255),
            name VARCHAR(255) NOT NULL,
            sessions_total INTEGER NOT NULL,
            price NUMERIC(12, 2) NOT NULL DEFAULT 0,
            sold_date DATE NOT NULL,
            liability_account_guid VARCHAR(32),
            income_account_guid VARCHAR(32),
            sale_txn_guid VARCHAR(32),
            notes TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_packages_book ON gnucash_web_packages(book_guid);

        CREATE TABLE IF NOT EXISTS gnucash_web_package_redemptions (
            id SERIAL PRIMARY KEY,
            package_id INTEGER NOT NULL REFERENCES gnucash_web_packages(id) ON DELETE CASCADE,
            redeemed_date DATE NOT NULL,
            sessions INTEGER NOT NULL DEFAULT 1,
            txn_guid VARCHAR(32),
            notes VARCHAR(255),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_package_redemptions_package
            ON gnucash_web_package_redemptions(package_id);

        CREATE TABLE IF NOT EXISTS gnucash_web_funds (
            id SERIAL PRIMARY KEY,
            book_guid VARCHAR(32) NOT NULL,
            name VARCHAR(255) NOT NULL,
            restriction VARCHAR(30) NOT NULL DEFAULT 'unrestricted',
            description TEXT,
            active BOOLEAN NOT NULL DEFAULT true,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_funds_book ON gnucash_web_funds(book_guid);

        CREATE TABLE IF NOT EXISTS gnucash_web_account_funds (
            account_guid VARCHAR(32) PRIMARY KEY,
            fund_id INTEGER NOT NULL REFERENCES gnucash_web_funds(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_account_funds_fund ON gnucash_web_account_funds(fund_id);

        CREATE TABLE IF NOT EXISTS gnucash_web_entity_documents (
            id SERIAL PRIMARY KEY,
            book_guid VARCHAR(32) NOT NULL,
            title VARCHAR(255) NOT NULL,
            doc_type VARCHAR(40) NOT NULL DEFAULT 'other',
            file_key VARCHAR(500),
            file_name VARCHAR(255),
            mime_type VARCHAR(100),
            size_bytes BIGINT,
            expires_on DATE,
            issued_on DATE,
            return_copy_due_on DATE,
            notes TEXT,
            uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_entity_documents_book
            ON gnucash_web_entity_documents(book_guid);
        ALTER TABLE gnucash_web_entity_documents
          ADD COLUMN IF NOT EXISTS issued_on DATE;
        ALTER TABLE gnucash_web_entity_documents
          ADD COLUMN IF NOT EXISTS return_copy_due_on DATE;
        -- Tax records archive: year grouping + form subtype + issuing institution.
        ALTER TABLE gnucash_web_entity_documents
          ADD COLUMN IF NOT EXISTS tax_year INTEGER;
        ALTER TABLE gnucash_web_entity_documents
          ADD COLUMN IF NOT EXISTS tax_form VARCHAR(40);
        ALTER TABLE gnucash_web_entity_documents
          ADD COLUMN IF NOT EXISTS issuer VARCHAR(255);
        END $$;
    `;

    // Entity-level book links: a business book points at the household book(s)
    // of its owner(s) with an ownership percent. Powers cross-book 1040
    // aggregation (Schedule C / K-1 share), the S-corp analyzer's household
    // marginal rates, and self-employed retirement capacity.
    const bookLinksTableDDL = `
        DO $$
        BEGIN
            PERFORM pg_advisory_xact_lock(hashtext('gnucash_web_book_links_schema'));
            CREATE TABLE IF NOT EXISTS gnucash_web_book_links (
                business_book_guid VARCHAR(32) NOT NULL,
                household_book_guid VARCHAR(32) NOT NULL,
                ownership_percent DOUBLE PRECISION NOT NULL DEFAULT 100,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (business_book_guid, household_book_guid)
            );
            CREATE INDEX IF NOT EXISTS idx_book_links_household
                ON gnucash_web_book_links(household_book_guid);
        END $$;
    `;

    // Membership management (501c3 clubs/charities): members, dues levels with
    // renewal policy, payments (with paid-through periods), meetings, and
    // attendance. GnuCash rows are referenced by loose guid columns only.
    const membershipTablesDDL = `
        DO $$
        BEGIN
        PERFORM pg_advisory_xact_lock(hashtext('gnucash_web_membership_schema'));
        CREATE TABLE IF NOT EXISTS gnucash_web_membership_types (
            id SERIAL PRIMARY KEY,
            book_guid VARCHAR(32) NOT NULL,
            name VARCHAR(255) NOT NULL,
            amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
            renewal_mode VARCHAR(20) NOT NULL DEFAULT 'calendar_year',
            grace_days INTEGER NOT NULL DEFAULT 0,
            active BOOLEAN NOT NULL DEFAULT true,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_membership_types_book ON gnucash_web_membership_types(book_guid);

        CREATE TABLE IF NOT EXISTS gnucash_web_members (
            id SERIAL PRIMARY KEY,
            book_guid VARCHAR(32) NOT NULL,
            name VARCHAR(255) NOT NULL,
            email VARCHAR(255),
            phone VARCHAR(50),
            address TEXT,
            membership_type_id INTEGER,
            joined_date DATE,
            status VARCHAR(20) NOT NULL DEFAULT 'active',
            notes TEXT,
            customer_guid VARCHAR(32),
            external_ref VARCHAR(100),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_members_book ON gnucash_web_members(book_guid);

        CREATE TABLE IF NOT EXISTS gnucash_web_membership_payments (
            id SERIAL PRIMARY KEY,
            book_guid VARCHAR(32) NOT NULL,
            member_id INTEGER NOT NULL REFERENCES gnucash_web_members(id) ON DELETE CASCADE,
            membership_type_id INTEGER,
            amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
            paid_date DATE NOT NULL,
            period_start DATE NOT NULL,
            period_end DATE,
            method VARCHAR(30) NOT NULL DEFAULT 'cash',
            reference VARCHAR(100),
            txn_guid VARCHAR(32),
            notes TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_membership_payments_member ON gnucash_web_membership_payments(member_id);
        CREATE INDEX IF NOT EXISTS idx_membership_payments_book ON gnucash_web_membership_payments(book_guid);

        CREATE TABLE IF NOT EXISTS gnucash_web_meetings (
            id SERIAL PRIMARY KEY,
            book_guid VARCHAR(32) NOT NULL,
            title VARCHAR(255) NOT NULL,
            meeting_date DATE NOT NULL,
            location VARCHAR(255),
            notes TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_meetings_book ON gnucash_web_meetings(book_guid, meeting_date DESC);

        CREATE TABLE IF NOT EXISTS gnucash_web_meeting_attendance (
            meeting_id INTEGER NOT NULL REFERENCES gnucash_web_meetings(id) ON DELETE CASCADE,
            member_id INTEGER NOT NULL REFERENCES gnucash_web_members(id) ON DELETE CASCADE,
            status VARCHAR(20) NOT NULL DEFAULT 'present',
            notes VARCHAR(255),
            PRIMARY KEY (meeting_id, member_id)
        );
        END $$;
    `;

    // Market wave A: shareable invoice links (public tokens, revocable).
    const invoiceSharesDDL = `
        DO $$
        BEGIN
        PERFORM pg_advisory_xact_lock(hashtext('gnucash_web_market_wave_a'));

        CREATE TABLE IF NOT EXISTS gnucash_web_invoice_shares (
            token VARCHAR(64) PRIMARY KEY,
            book_guid VARCHAR(32) NOT NULL,
            invoice_guid VARCHAR(32) NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            expires_at TIMESTAMP,
            revoked BOOLEAN NOT NULL DEFAULT false
        );
        CREATE INDEX IF NOT EXISTS idx_invoice_shares_invoice
            ON gnucash_web_invoice_shares(invoice_guid);
        CREATE INDEX IF NOT EXISTS idx_invoice_shares_book
            ON gnucash_web_invoice_shares(book_guid);
        END $$;
    `;

    // Market wave B: estimates/quotes with line items, convertible to invoices.
    const estimatesTablesDDL = `
        DO $$
        BEGIN
        PERFORM pg_advisory_xact_lock(hashtext('gnucash_web_market_wave_b'));

        CREATE TABLE IF NOT EXISTS gnucash_web_estimates (
            id SERIAL PRIMARY KEY,
            book_guid VARCHAR(32) NOT NULL,
            estimate_no VARCHAR(50),
            customer_guid VARCHAR(32),
            date_created DATE NOT NULL,
            expires DATE,
            status VARCHAR(20) NOT NULL DEFAULT 'draft',
            converted_invoice_guid VARCHAR(32),
            notes TEXT,
            terms TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_estimates_book ON gnucash_web_estimates(book_guid);

        CREATE TABLE IF NOT EXISTS gnucash_web_estimate_lines (
            id SERIAL PRIMARY KEY,
            estimate_id INTEGER NOT NULL REFERENCES gnucash_web_estimates(id) ON DELETE CASCADE,
            description TEXT,
            quantity NUMERIC(12, 4) NOT NULL DEFAULT 1,
            unit_price NUMERIC(12, 4) NOT NULL DEFAULT 0,
            income_account_guid VARCHAR(32),
            sort_order INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_estimate_lines_estimate
            ON gnucash_web_estimate_lines(estimate_id);
        END $$;
    `;

    // Market wave C: dunning (payment reminders) — per-book settings,
    // send log, and per-invoice opt-out.
    const dunningTablesDDL = `
        DO $$
        BEGIN
        PERFORM pg_advisory_xact_lock(hashtext('gnucash_web_market_wave_c'));

        CREATE TABLE IF NOT EXISTS gnucash_web_dunning_settings (
            book_guid VARCHAR(32) PRIMARY KEY,
            enabled BOOLEAN NOT NULL DEFAULT false,
            schedule JSONB NOT NULL DEFAULT '[7,14,30]',
            email_subject VARCHAR(255),
            email_body TEXT,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS gnucash_web_dunning_log (
            id SERIAL PRIMARY KEY,
            book_guid VARCHAR(32) NOT NULL,
            invoice_guid VARCHAR(32) NOT NULL,
            level INTEGER NOT NULL,
            recipient VARCHAR(255),
            sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_dunning_log_book_invoice
            ON gnucash_web_dunning_log(book_guid, invoice_guid);

        CREATE TABLE IF NOT EXISTS gnucash_web_dunning_optout (
            invoice_guid VARCHAR(32) PRIMARY KEY,
            book_guid VARCHAR(32) NOT NULL
        );
        END $$;
    `;

    // Market wave D: time tracking — timesheet entries with an optional
    // running timer, billed onto invoices via invoiced_invoice_guid.
    const timeEntriesTableDDL = `
        DO $$
        BEGIN
        PERFORM pg_advisory_xact_lock(hashtext('gnucash_web_market_wave_d'));

        CREATE TABLE IF NOT EXISTS gnucash_web_time_entries (
            id SERIAL PRIMARY KEY,
            book_guid VARCHAR(32) NOT NULL,
            user_id INTEGER,
            customer_guid VARCHAR(32),
            job_guid VARCHAR(32),
            entry_date DATE NOT NULL,
            minutes INTEGER NOT NULL DEFAULT 0,
            rate NUMERIC(12, 2),
            description TEXT,
            billable BOOLEAN NOT NULL DEFAULT true,
            invoiced_invoice_guid VARCHAR(32),
            timer_started_at TIMESTAMP,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_time_entries_book_date
            ON gnucash_web_time_entries(book_guid, entry_date);
        CREATE INDEX IF NOT EXISTS idx_time_entries_invoice
            ON gnucash_web_time_entries(invoiced_invoice_guid);
        END $$;
    `;

    // Market wave E: generic per-book settings row (lock date for
    // month-end close, future book-level knobs).
    const bookSettingsTableDDL = `
        DO $$
        BEGIN
        PERFORM pg_advisory_xact_lock(hashtext('gnucash_web_market_wave_e'));

        CREATE TABLE IF NOT EXISTS gnucash_web_book_settings (
            book_guid VARCHAR(32) PRIMARY KEY,
            lock_date DATE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        END $$;
    `;

    // Market wave F: HSA shoebox — receipts flagged as HSA-eligible and
    // linked to their eventual reimbursement transaction.
    const receiptsHsaColumnsDDL = `
        DO $$
        BEGIN
        PERFORM pg_advisory_xact_lock(hashtext('gnucash_web_market_wave_f'));
        ALTER TABLE gnucash_web_receipts
            ADD COLUMN IF NOT EXISTS hsa_eligible BOOLEAN NOT NULL DEFAULT false;
        ALTER TABLE gnucash_web_receipts
            ADD COLUMN IF NOT EXISTS hsa_reimbursed_txn_guid VARCHAR(32);
        END $$;
    `;

    // Market wave G: budget auto-funding rules — when a matching deposit
    // lands, allocate amounts across envelope accounts.
    const budgetFundingRulesTableDDL = `
        DO $$
        BEGIN
        PERFORM pg_advisory_xact_lock(hashtext('gnucash_web_market_wave_g'));

        CREATE TABLE IF NOT EXISTS gnucash_web_budget_funding_rules (
            id SERIAL PRIMARY KEY,
            book_guid VARCHAR(32) NOT NULL,
            name VARCHAR(255) NOT NULL,
            trigger_account_guid VARCHAR(32),
            trigger_description_match VARCHAR(255),
            min_amount NUMERIC(12, 2),
            allocations JSONB NOT NULL,
            active BOOLEAN NOT NULL DEFAULT true,
            last_applied_txn_guid VARCHAR(32),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_budget_funding_rules_book
            ON gnucash_web_budget_funding_rules(book_guid);
        END $$;
    `;

    // Native GnuCash budgets do not carry a book foreign key. Keep ownership
    // in an app-owned table so the native schema remains interoperable.
    //
    // The backfill is deliberately fail-closed:
    // - a non-empty budget is assigned only when every referenced account
    //   resolves to one book and all accounts resolve to the same book;
    // - an empty budget is assigned only when the database contains one book;
    // - ambiguous or unmapped budgets remain unowned and invisible;
    // - budget_amounts rows whose budget no longer exists (orphaned by a
    //   deleted budget) are ignored so the insert cannot violate the
    //   budgets(guid) foreign key.
    const budgetOwnershipTableDDL = `
        DO $$
        BEGIN
        PERFORM pg_advisory_xact_lock(hashtext('gnucash_web_budget_ownership_schema'));

        CREATE TABLE IF NOT EXISTS gnucash_web_budget_ownership (
            budget_guid VARCHAR(32) PRIMARY KEY
                REFERENCES budgets(guid) ON DELETE CASCADE,
            book_guid VARCHAR(32) NOT NULL
                REFERENCES books(guid) ON DELETE CASCADE,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_budget_ownership_book
            ON gnucash_web_budget_ownership(book_guid);

        CREATE OR REPLACE FUNCTION gnucash_web_prevent_budget_owner_change()
        RETURNS trigger AS $ownership$
        BEGIN
            IF NEW.book_guid IS DISTINCT FROM OLD.book_guid THEN
                RAISE EXCEPTION 'Budget ownership is immutable';
            END IF;
            RETURN NEW;
        END;
        $ownership$ LANGUAGE plpgsql;

        DROP TRIGGER IF EXISTS trg_budget_ownership_immutable
            ON gnucash_web_budget_ownership;
        CREATE TRIGGER trg_budget_ownership_immutable
            BEFORE UPDATE OF book_guid ON gnucash_web_budget_ownership
            FOR EACH ROW
            EXECUTE FUNCTION gnucash_web_prevent_budget_owner_change();

        WITH RECURSIVE book_accounts AS (
            SELECT b.guid AS book_guid, a.guid AS account_guid
            FROM books b
            JOIN accounts a ON a.guid = b.root_account_guid

            UNION ALL

            SELECT ba.book_guid, child.guid
            FROM book_accounts ba
            JOIN accounts child ON child.parent_guid = ba.account_guid
        ),
        account_resolution AS (
            SELECT
                account_guid,
                MIN(book_guid) AS book_guid,
                COUNT(DISTINCT book_guid) AS book_count
            FROM book_accounts
            GROUP BY account_guid
        ),
        budget_resolution AS (
            SELECT
                ba.budget_guid,
                MIN(ar.book_guid) FILTER (WHERE ar.book_count = 1) AS book_guid,
                COUNT(DISTINCT ba.account_guid) AS amount_account_count,
                COUNT(DISTINCT ba.account_guid)
                    FILTER (WHERE ar.book_count = 1) AS resolved_account_count,
                COUNT(DISTINCT ar.book_guid)
                    FILTER (WHERE ar.book_count = 1) AS resolved_book_count
            FROM budget_amounts ba
            JOIN budgets bu
                ON bu.guid = ba.budget_guid
            LEFT JOIN account_resolution ar
                ON ar.account_guid = ba.account_guid
            GROUP BY ba.budget_guid
        )
        INSERT INTO gnucash_web_budget_ownership (budget_guid, book_guid)
        SELECT budget_guid, book_guid
        FROM budget_resolution
        WHERE amount_account_count = resolved_account_count
          AND resolved_book_count = 1
          AND book_guid IS NOT NULL
        ON CONFLICT (budget_guid) DO NOTHING;

        INSERT INTO gnucash_web_budget_ownership (budget_guid, book_guid)
        SELECT b.guid, only_book.guid
        FROM budgets b
        CROSS JOIN (
            SELECT MIN(guid) AS guid
            FROM books
            HAVING COUNT(*) = 1
        ) only_book
        WHERE NOT EXISTS (
            SELECT 1
            FROM budget_amounts ba
            WHERE ba.budget_guid = b.guid
        )
        ON CONFLICT (budget_guid) DO NOTHING;
        END $$;
    `;

    // The native GnuCash business tables (customers, vendors, employees, jobs,
    // invoices, orders, billterms, taxtables) carry no book foreign key —
    // GnuCash assumes one book per database. Ownership therefore lives in an
    // app-owned table, exactly as for budgets.
    //
    // The backfill is fail-closed and derives ownership only from links that
    // cannot be ambiguous:
    //   1. a posted invoice resolves through post_acc -> account -> book;
    //   2. an employee resolves through ccard_guid;
    //   3. an owner (customer/vendor/job) resolves when every invoice/job that
    //      references it agrees on one book;
    //   4. an unposted invoice, and an order, resolve from their owner;
    //   5. billterms/taxtables resolve from the entities that reference them,
    //      again only when unanimous;
    //   6. anything still unattributed is assigned only when the database holds
    //      exactly one book — otherwise it stays unowned and invisible, and is
    //      reported by reportUnattributedBusinessEntities().
    const businessEntityOwnershipTableDDL = `
        DO $$
        BEGIN
        PERFORM pg_advisory_xact_lock(hashtext('gnucash_web_business_entity_ownership_schema'));

        CREATE TABLE IF NOT EXISTS gnucash_web_business_entity_ownership (
            entity_type VARCHAR(16) NOT NULL,
            entity_guid VARCHAR(32) NOT NULL,
            book_guid VARCHAR(32) NOT NULL
                REFERENCES books(guid) ON DELETE CASCADE,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (entity_type, entity_guid)
        );
        CREATE INDEX IF NOT EXISTS idx_business_entity_ownership_book
            ON gnucash_web_business_entity_ownership(book_guid, entity_type);

        CREATE OR REPLACE FUNCTION gnucash_web_prevent_business_owner_change()
        RETURNS trigger AS $bizowner$
        BEGIN
            IF NEW.book_guid IS DISTINCT FROM OLD.book_guid THEN
                RAISE EXCEPTION 'Business entity ownership is immutable';
            END IF;
            RETURN NEW;
        END;
        $bizowner$ LANGUAGE plpgsql;

        DROP TRIGGER IF EXISTS trg_business_entity_ownership_immutable
            ON gnucash_web_business_entity_ownership;
        CREATE TRIGGER trg_business_entity_ownership_immutable
            BEFORE UPDATE OF book_guid ON gnucash_web_business_entity_ownership
            FOR EACH ROW
            EXECUTE FUNCTION gnucash_web_prevent_business_owner_change();

        CREATE TEMP TABLE IF NOT EXISTS tmp_book_account (
            book_guid VARCHAR(32),
            account_guid VARCHAR(32)
        ) ON COMMIT DROP;
        DELETE FROM tmp_book_account;

        WITH RECURSIVE book_accounts AS (
            SELECT b.guid AS book_guid, a.guid AS account_guid
            FROM books b
            JOIN accounts a ON a.guid = b.root_account_guid
            UNION ALL
            SELECT ba.book_guid, child.guid
            FROM book_accounts ba
            JOIN accounts child ON child.parent_guid = ba.account_guid
        )
        INSERT INTO tmp_book_account
        SELECT book_guid, account_guid FROM book_accounts;

        -- account -> book, only where unambiguous
        CREATE TEMP TABLE IF NOT EXISTS tmp_account_book (
            account_guid VARCHAR(32) PRIMARY KEY,
            book_guid VARCHAR(32)
        ) ON COMMIT DROP;
        DELETE FROM tmp_account_book;
        INSERT INTO tmp_account_book
        SELECT account_guid, MIN(book_guid)
        FROM tmp_book_account
        GROUP BY account_guid
        HAVING COUNT(DISTINCT book_guid) = 1;

        -- 1. posted invoices
        INSERT INTO gnucash_web_business_entity_ownership (entity_type, entity_guid, book_guid)
        SELECT 'invoice', i.guid, ab.book_guid
        FROM invoices i
        JOIN tmp_account_book ab ON ab.account_guid = i.post_acc
        ON CONFLICT DO NOTHING;

        -- 2. employees via their credit-card account
        INSERT INTO gnucash_web_business_entity_ownership (entity_type, entity_guid, book_guid)
        SELECT 'employee', e.guid, ab.book_guid
        FROM employees e
        JOIN tmp_account_book ab ON ab.account_guid = e.ccard_guid
        ON CONFLICT DO NOTHING;

        -- 3. owners referenced by already-attributed invoices (unanimous only)
        INSERT INTO gnucash_web_business_entity_ownership (entity_type, entity_guid, book_guid)
        SELECT owner_kind, owner_guid, MIN(book_guid)
        FROM (
            SELECT CASE i.owner_type WHEN 2 THEN 'customer' WHEN 3 THEN 'job'
                                     WHEN 4 THEN 'vendor'   WHEN 5 THEN 'employee' END AS owner_kind,
                   i.owner_guid, o.book_guid
            FROM invoices i
            JOIN gnucash_web_business_entity_ownership o
              ON o.entity_type = 'invoice' AND o.entity_guid = i.guid
            WHERE i.owner_guid IS NOT NULL AND i.owner_type IN (2,3,4,5)
        ) s
        WHERE owner_kind IS NOT NULL
        GROUP BY owner_kind, owner_guid
        HAVING COUNT(DISTINCT book_guid) = 1
        ON CONFLICT DO NOTHING;

        -- 4. jobs from their owner, then invoices/orders from theirs
        INSERT INTO gnucash_web_business_entity_ownership (entity_type, entity_guid, book_guid)
        SELECT 'job', j.guid, o.book_guid
        FROM jobs j
        JOIN gnucash_web_business_entity_ownership o
          ON o.entity_guid = j.owner_guid
         AND o.entity_type = CASE j.owner_type WHEN 2 THEN 'customer' WHEN 4 THEN 'vendor' END
        ON CONFLICT DO NOTHING;

        INSERT INTO gnucash_web_business_entity_ownership (entity_type, entity_guid, book_guid)
        SELECT 'invoice', i.guid, o.book_guid
        FROM invoices i
        JOIN gnucash_web_business_entity_ownership o
          ON o.entity_guid = i.owner_guid
         AND o.entity_type = CASE i.owner_type WHEN 2 THEN 'customer' WHEN 3 THEN 'job'
                                               WHEN 4 THEN 'vendor'   WHEN 5 THEN 'employee' END
        ON CONFLICT DO NOTHING;

        INSERT INTO gnucash_web_business_entity_ownership (entity_type, entity_guid, book_guid)
        SELECT 'order', ord.guid, o.book_guid
        FROM orders ord
        JOIN gnucash_web_business_entity_ownership o
          ON o.entity_guid = ord.owner_guid
         AND o.entity_type = CASE ord.owner_type WHEN 2 THEN 'customer' WHEN 3 THEN 'job'
                                                 WHEN 4 THEN 'vendor'   WHEN 5 THEN 'employee' END
        ON CONFLICT DO NOTHING;

        -- 5. billterms / taxtables from the entities that reference them
        INSERT INTO gnucash_web_business_entity_ownership (entity_type, entity_guid, book_guid)
        SELECT 'billterm', term_guid, MIN(book_guid)
        FROM (
            SELECT c.terms AS term_guid, o.book_guid FROM customers c
              JOIN gnucash_web_business_entity_ownership o
                ON o.entity_type='customer' AND o.entity_guid=c.guid
              WHERE c.terms IS NOT NULL
            UNION ALL
            SELECT v.terms, o.book_guid FROM vendors v
              JOIN gnucash_web_business_entity_ownership o
                ON o.entity_type='vendor' AND o.entity_guid=v.guid
              WHERE v.terms IS NOT NULL
            UNION ALL
            SELECT i.terms, o.book_guid FROM invoices i
              JOIN gnucash_web_business_entity_ownership o
                ON o.entity_type='invoice' AND o.entity_guid=i.guid
              WHERE i.terms IS NOT NULL
        ) t
        GROUP BY term_guid
        HAVING COUNT(DISTINCT book_guid) = 1
        ON CONFLICT DO NOTHING;

        INSERT INTO gnucash_web_business_entity_ownership (entity_type, entity_guid, book_guid)
        SELECT 'taxtable', tt_guid, MIN(book_guid)
        FROM (
            SELECT c.taxtable AS tt_guid, o.book_guid FROM customers c
              JOIN gnucash_web_business_entity_ownership o
                ON o.entity_type='customer' AND o.entity_guid=c.guid
              WHERE c.taxtable IS NOT NULL
            UNION ALL
            SELECT e.i_taxtable, o.book_guid FROM entries e
              JOIN gnucash_web_business_entity_ownership o
                ON o.entity_type='invoice' AND o.entity_guid=e.invoice
              WHERE e.i_taxtable IS NOT NULL
            UNION ALL
            SELECT e.b_taxtable, o.book_guid FROM entries e
              JOIN gnucash_web_business_entity_ownership o
                ON o.entity_type='invoice' AND o.entity_guid=e.invoice
              WHERE e.b_taxtable IS NOT NULL
        ) t
        GROUP BY tt_guid
        HAVING COUNT(DISTINCT book_guid) = 1
        ON CONFLICT DO NOTHING;

        -- Per-entity projections of the polymorphic owner table. Prisma cannot
        -- span (entity_type, entity_guid) with one relation, so each view gives
        -- its entity table a joinable 1:1 relation and list queries filter with
        -- a JOIN instead of materializing every owned guid into an IN list.
        CREATE OR REPLACE VIEW gnucash_web_customer_ownership AS
            SELECT entity_guid, book_guid FROM gnucash_web_business_entity_ownership
             WHERE entity_type = 'customer';
        CREATE OR REPLACE VIEW gnucash_web_vendor_ownership AS
            SELECT entity_guid, book_guid FROM gnucash_web_business_entity_ownership
             WHERE entity_type = 'vendor';
        CREATE OR REPLACE VIEW gnucash_web_employee_ownership AS
            SELECT entity_guid, book_guid FROM gnucash_web_business_entity_ownership
             WHERE entity_type = 'employee';
        CREATE OR REPLACE VIEW gnucash_web_job_ownership AS
            SELECT entity_guid, book_guid FROM gnucash_web_business_entity_ownership
             WHERE entity_type = 'job';
        CREATE OR REPLACE VIEW gnucash_web_invoice_ownership AS
            SELECT entity_guid, book_guid FROM gnucash_web_business_entity_ownership
             WHERE entity_type = 'invoice';
        CREATE OR REPLACE VIEW gnucash_web_order_ownership AS
            SELECT entity_guid, book_guid FROM gnucash_web_business_entity_ownership
             WHERE entity_type = 'order';
        CREATE OR REPLACE VIEW gnucash_web_billterm_ownership AS
            SELECT entity_guid, book_guid FROM gnucash_web_business_entity_ownership
             WHERE entity_type = 'billterm';
        CREATE OR REPLACE VIEW gnucash_web_taxtable_ownership AS
            SELECT entity_guid, book_guid FROM gnucash_web_business_entity_ownership
             WHERE entity_type = 'taxtable';

        -- 6. single-book database: nothing can be ambiguous, so adopt the rest
        IF (SELECT COUNT(*) FROM books) = 1 THEN
            INSERT INTO gnucash_web_business_entity_ownership (entity_type, entity_guid, book_guid)
            SELECT k, g, (SELECT guid FROM books)
            FROM (
                SELECT 'customer' k, guid g FROM customers
                UNION ALL SELECT 'vendor', guid FROM vendors
                UNION ALL SELECT 'employee', guid FROM employees
                UNION ALL SELECT 'job', guid FROM jobs
                UNION ALL SELECT 'invoice', guid FROM invoices
                UNION ALL SELECT 'order', guid FROM orders
                UNION ALL SELECT 'billterm', guid FROM billterms
                UNION ALL SELECT 'taxtable', guid FROM taxtables
            ) all_entities
            ON CONFLICT DO NOTHING;
        END IF;
        END $$;
    `;

    // Envelope configuration is also lazily guarded by budget-envelope.ts,
    // but startup must install its lifecycle FK before import/book deletion
    // can recycle a native budget GUID. Valid legacy rows are preserved;
    // only rows whose native budget is already gone are removed.
    const budgetEnvelopesTableDDL = `
        DO $$
        BEGIN
        PERFORM pg_advisory_xact_lock(hashtext('gnucash_web_budget_envelopes_schema'));

        CREATE TABLE IF NOT EXISTS gnucash_web_budget_envelopes (
            id SERIAL PRIMARY KEY,
            budget_guid VARCHAR(32) NOT NULL,
            account_guid VARCHAR(32) NOT NULL,
            rollover_enabled BOOLEAN NOT NULL DEFAULT TRUE,
            alert_threshold_pct INTEGER,
            goal_id INTEGER,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (budget_guid, account_guid)
        );

        CREATE INDEX IF NOT EXISTS idx_budget_envelopes_budget
            ON gnucash_web_budget_envelopes(budget_guid);

        DELETE FROM gnucash_web_budget_envelopes e
        WHERE NOT EXISTS (
            SELECT 1 FROM budgets b WHERE b.guid = e.budget_guid
        );

        IF NOT EXISTS (
            SELECT 1
            FROM pg_constraint
            WHERE conname = 'fk_budget_envelopes_budget'
              AND conrelid = 'gnucash_web_budget_envelopes'::regclass
        ) THEN
            ALTER TABLE gnucash_web_budget_envelopes
            ADD CONSTRAINT fk_budget_envelopes_budget
            FOREIGN KEY (budget_guid)
            REFERENCES budgets(guid)
            ON DELETE CASCADE;
        END IF;
        END $$;
    `;

    // Market wave H: renewals & contracts — upcoming renewal dates with
    // reminder lead time and dismissal.
    const renewalsTableDDL = `
        DO $$
        BEGIN
        PERFORM pg_advisory_xact_lock(hashtext('gnucash_web_market_wave_h'));

        CREATE TABLE IF NOT EXISTS gnucash_web_renewals (
            id SERIAL PRIMARY KEY,
            book_guid VARCHAR(32) NOT NULL,
            name VARCHAR(255) NOT NULL,
            renewal_date DATE NOT NULL,
            amount NUMERIC(12, 2),
            cadence_months INTEGER NOT NULL DEFAULT 12,
            remind_days INTEGER NOT NULL DEFAULT 30,
            source VARCHAR(20) NOT NULL DEFAULT 'manual',
            notes TEXT,
            dismissed_until DATE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_renewals_book_date
            ON gnucash_web_renewals(book_guid, renewal_date);
        ALTER TABLE gnucash_web_renewals
          ADD COLUMN IF NOT EXISTS document_id INTEGER;
        END $$;
    `;

    // Market wave I: home module — rooms, inventory items, maintenance
    // tasks, and the service log.
    const homeTablesDDL = `
        DO $$
        BEGIN
        PERFORM pg_advisory_xact_lock(hashtext('gnucash_web_market_wave_i'));

        CREATE TABLE IF NOT EXISTS gnucash_web_home_rooms (
            id SERIAL PRIMARY KEY,
            book_guid VARCHAR(32) NOT NULL,
            name VARCHAR(255) NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_home_rooms_book ON gnucash_web_home_rooms(book_guid);

        CREATE TABLE IF NOT EXISTS gnucash_web_home_items (
            id SERIAL PRIMARY KEY,
            book_guid VARCHAR(32) NOT NULL,
            room_id INTEGER NOT NULL REFERENCES gnucash_web_home_rooms(id) ON DELETE CASCADE,
            name VARCHAR(255) NOT NULL,
            category VARCHAR(50),
            est_value NUMERIC(12, 2),
            purchase_date DATE,
            receipt_id INTEGER,
            photo_key VARCHAR(500),
            warranty_expires DATE,
            serial VARCHAR(100),
            notes TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_home_items_room ON gnucash_web_home_items(room_id);
        CREATE INDEX IF NOT EXISTS idx_home_items_book ON gnucash_web_home_items(book_guid);

        CREATE TABLE IF NOT EXISTS gnucash_web_home_tasks (
            id SERIAL PRIMARY KEY,
            book_guid VARCHAR(32) NOT NULL,
            name VARCHAR(255) NOT NULL,
            cadence_months INTEGER,
            season VARCHAR(20),
            item_id INTEGER REFERENCES gnucash_web_home_items(id) ON DELETE SET NULL,
            last_done DATE,
            active BOOLEAN NOT NULL DEFAULT true,
            notes TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_home_tasks_book ON gnucash_web_home_tasks(book_guid);

        CREATE TABLE IF NOT EXISTS gnucash_web_home_service_log (
            id SERIAL PRIMARY KEY,
            book_guid VARCHAR(32) NOT NULL,
            task_id INTEGER REFERENCES gnucash_web_home_tasks(id) ON DELETE SET NULL,
            item_id INTEGER REFERENCES gnucash_web_home_items(id) ON DELETE SET NULL,
            service_date DATE NOT NULL,
            cost NUMERIC(12, 2),
            vendor VARCHAR(255),
            txn_guid VARCHAR(32),
            notes TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_home_service_log_book
            ON gnucash_web_home_service_log(book_guid);
        END $$;
    `;

    // Per-item photo gallery — its own block so the CREATE is committed before
    // the backfill below runs the DML against it (mixing DDL + DML that targets
    // the same new table inside one DO block fails to plan).
    const homeItemPhotosTableDDL = `
        DO $$
        BEGIN
        PERFORM pg_advisory_xact_lock(hashtext('gnucash_web_home_item_photos_schema'));

        CREATE TABLE IF NOT EXISTS gnucash_web_home_item_photos (
            id SERIAL PRIMARY KEY,
            book_guid VARCHAR(32) NOT NULL,
            item_id INTEGER NOT NULL REFERENCES gnucash_web_home_items(id) ON DELETE CASCADE,
            photo_key VARCHAR(500) NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_home_item_photos_item
            ON gnucash_web_home_item_photos(item_id);
        CREATE INDEX IF NOT EXISTS idx_home_item_photos_book
            ON gnucash_web_home_item_photos(book_guid);
        END $$;
    `;

    // One-time backfill of the legacy single photo into the gallery table.
    // Guarded by photo_key IS NOT NULL, which the UPDATE clears — so once it has
    // run, both statements match zero rows and re-running is a cheap no-op.
    const homeItemPhotosBackfillDDL = `
        INSERT INTO gnucash_web_home_item_photos (book_guid, item_id, photo_key, sort_order)
        SELECT book_guid, id, photo_key, 0
        FROM gnucash_web_home_items
        WHERE photo_key IS NOT NULL;
        UPDATE gnucash_web_home_items SET photo_key = NULL WHERE photo_key IS NOT NULL;
    `;

    // Inbound-webhook idempotency keys. The UNIQUE index is what actually
    // stops an n8n retry from posting a second ledger entry / dues payment
    // (see src/lib/webhook-idempotency.ts) — an application-level check would
    // be racy. Completed claims are pruned after 90 days.
    const webhookIdempotencyTableDDL = `
        CREATE TABLE IF NOT EXISTS gnucash_web_webhook_idempotency (
            id SERIAL PRIMARY KEY,
            book_guid VARCHAR(32) NOT NULL,
            endpoint VARCHAR(64) NOT NULL,
            idempotency_key VARCHAR(200) NOT NULL,
            result JSONB,
            completed_at TIMESTAMP,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE UNIQUE INDEX IF NOT EXISTS uq_webhook_idempotency
            ON gnucash_web_webhook_idempotency (book_guid, endpoint, idempotency_key);

        DELETE FROM gnucash_web_webhook_idempotency
        WHERE created_at < NOW() - INTERVAL '90 days';
    `;

    const importBatchesTableDDL = `
        CREATE TABLE IF NOT EXISTS gnucash_web_import_batches (
            id SERIAL PRIMARY KEY,
            book_guid VARCHAR(32) NOT NULL,
            source VARCHAR(50) NOT NULL,
            filename VARCHAR(500),
            total_items INTEGER NOT NULL DEFAULT 0,
            matched_items INTEGER NOT NULL DEFAULT 0,
            user_id INTEGER,
            status VARCHAR(20) NOT NULL DEFAULT 'processing',
            settings JSONB DEFAULT '{}',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            completed_at TIMESTAMP
        );

        ALTER TABLE gnucash_web_import_batches
          ALTER COLUMN source DROP DEFAULT;
    `;
    const notificationsTableDDL = `
        DO $$
        BEGIN
            PERFORM pg_advisory_xact_lock(hashtext('gnucash_web_notifications_schema'));

            CREATE TABLE IF NOT EXISTS gnucash_web_notifications (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES gnucash_web_users(id) ON DELETE CASCADE,
                book_guid VARCHAR(32),
                type VARCHAR(50) NOT NULL DEFAULT 'background_job',
                severity VARCHAR(20) NOT NULL DEFAULT 'info',
                title VARCHAR(255) NOT NULL,
                message TEXT,
                href TEXT,
                source VARCHAR(100),
                source_id VARCHAR(255),
                read_at TIMESTAMP,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE INDEX IF NOT EXISTS idx_notifications_user_created
                ON gnucash_web_notifications(user_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
                ON gnucash_web_notifications(user_id, read_at)
                WHERE read_at IS NULL;
            CREATE INDEX IF NOT EXISTS idx_notifications_user_book
                ON gnucash_web_notifications(user_id, book_guid, created_at DESC);
        END $$;
    `;

    const financialActionsTableDDL = `
        DO $$
        BEGIN
            PERFORM pg_advisory_xact_lock(hashtext('gnucash_web_financial_actions_schema'));
            ${FINANCIAL_ACTIONS_SCHEMA_SQL}
            ${CALCULATION_TRACES_SCHEMA_SQL}
        END $$;
    `;

    // Operator and business workflow foundations. These tables stay outside
    // the native GnuCash schema so desktop compatibility is preserved while
    // previews, processor events, workflow state, and explicit job links are
    // durable and book-scoped.
    const operatorBusinessWorkflowsDDL = `
        DO $$
        BEGIN
            PERFORM pg_advisory_xact_lock(hashtext('gnucash_web_operator_business_workflows'));

            CREATE TABLE IF NOT EXISTS gnucash_web_domain_commands (
                id VARCHAR(40) PRIMARY KEY,
                book_guid VARCHAR(32) NOT NULL,
                user_id INTEGER REFERENCES gnucash_web_users(id) ON DELETE SET NULL,
                command_type VARCHAR(80) NOT NULL,
                status VARCHAR(20) NOT NULL DEFAULT 'pending',
                input JSONB NOT NULL DEFAULT '{}',
                preview JSONB NOT NULL DEFAULT '{}',
                result JSONB,
                undo_payload JSONB,
                error_message TEXT,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                expires_at TIMESTAMP NOT NULL,
                executed_at TIMESTAMP,
                undone_at TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_domain_commands_book_created
                ON gnucash_web_domain_commands(book_guid, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_domain_commands_user_status
                ON gnucash_web_domain_commands(user_id, status, created_at DESC);

            CREATE TABLE IF NOT EXISTS gnucash_web_payment_connections (
                book_guid VARCHAR(32) PRIMARY KEY,
                provider VARCHAR(20) NOT NULL DEFAULT 'stripe',
                secret_key_encrypted TEXT,
                webhook_secret_encrypted TEXT,
                transfer_account_guid VARCHAR(32),
                fee_account_guid VARCHAR(32),
                enabled BOOLEAN NOT NULL DEFAULT false,
                updated_by INTEGER REFERENCES gnucash_web_users(id) ON DELETE SET NULL,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS gnucash_web_payment_events (
                id BIGSERIAL PRIMARY KEY,
                book_guid VARCHAR(32) NOT NULL,
                provider VARCHAR(20) NOT NULL,
                provider_event_id VARCHAR(255) NOT NULL,
                provider_payment_id VARCHAR(255),
                invoice_guid VARCHAR(32),
                status VARCHAR(30) NOT NULL,
                amount NUMERIC(14, 2),
                fee NUMERIC(14, 2),
                currency VARCHAR(10),
                payment_transaction_guid VARCHAR(32),
                fee_transaction_guid VARCHAR(32),
                payload JSONB NOT NULL DEFAULT '{}',
                error_message TEXT,
                received_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                processed_at TIMESTAMP,
                UNIQUE(provider, provider_event_id)
            );
            ALTER TABLE gnucash_web_payment_events
                ADD COLUMN IF NOT EXISTS received_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;
            CREATE INDEX IF NOT EXISTS idx_payment_events_invoice
                ON gnucash_web_payment_events(invoice_guid, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_payment_events_book_status
                ON gnucash_web_payment_events(book_guid, status, created_at DESC);

            CREATE TABLE IF NOT EXISTS gnucash_web_job_cost_links (
                id SERIAL PRIMARY KEY,
                book_guid VARCHAR(32) NOT NULL,
                job_guid VARCHAR(32) NOT NULL,
                source_type VARCHAR(20) NOT NULL,
                source_id VARCHAR(64),
                description TEXT,
                cost_date DATE NOT NULL,
                amount NUMERIC(14, 2) NOT NULL,
                billable BOOLEAN NOT NULL DEFAULT false,
                invoiced_invoice_guid VARCHAR(32),
                created_by INTEGER REFERENCES gnucash_web_users(id) ON DELETE SET NULL,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(book_guid, job_guid, source_type, source_id)
            );
            CREATE INDEX IF NOT EXISTS idx_job_cost_links_job_date
                ON gnucash_web_job_cost_links(book_guid, job_guid, cost_date DESC);

            CREATE TABLE IF NOT EXISTS gnucash_web_reimbursement_requests (
                id SERIAL PRIMARY KEY,
                book_guid VARCHAR(32) NOT NULL,
                receipt_id INTEGER REFERENCES gnucash_web_receipts(id) ON DELETE SET NULL,
                employee_guid VARCHAR(32) NOT NULL,
                submitted_by INTEGER REFERENCES gnucash_web_users(id) ON DELETE SET NULL,
                approved_by INTEGER REFERENCES gnucash_web_users(id) ON DELETE SET NULL,
                status VARCHAR(20) NOT NULL DEFAULT 'submitted',
                amount NUMERIC(14, 2) NOT NULL,
                expense_account_guid VARCHAR(32) NOT NULL,
                description TEXT,
                notes TEXT,
                expense_date DATE NOT NULL,
                due_date DATE,
                voucher_guid VARCHAR(32),
                rejection_reason TEXT,
                submitted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                reviewed_at TIMESTAMP,
                posted_at TIMESTAMP,
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_reimbursements_book_status
                ON gnucash_web_reimbursement_requests(book_guid, status, submitted_at DESC);
            CREATE INDEX IF NOT EXISTS idx_reimbursements_employee
                ON gnucash_web_reimbursement_requests(employee_guid, submitted_at DESC);
            CREATE UNIQUE INDEX IF NOT EXISTS idx_reimbursements_open_receipt
                ON gnucash_web_reimbursement_requests(book_guid, receipt_id)
                WHERE receipt_id IS NOT NULL AND status <> 'rejected';

            CREATE TABLE IF NOT EXISTS gnucash_web_reconciliation_sessions (
                id VARCHAR(40) PRIMARY KEY,
                book_guid VARCHAR(32) NOT NULL,
                account_guid VARCHAR(32) NOT NULL,
                user_id INTEGER REFERENCES gnucash_web_users(id) ON DELETE SET NULL,
                statement_date DATE,
                status VARCHAR(20) NOT NULL DEFAULT 'started',
                interaction_count INTEGER NOT NULL DEFAULT 0,
                started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                completed_at TIMESTAMP,
                ending_difference NUMERIC(14, 2),
                metadata JSONB NOT NULL DEFAULT '{}'
            );
            CREATE INDEX IF NOT EXISTS idx_reconciliation_sessions_book_started
                ON gnucash_web_reconciliation_sessions(book_guid, started_at DESC);
            CREATE INDEX IF NOT EXISTS idx_reconciliation_sessions_account
                ON gnucash_web_reconciliation_sessions(account_guid, started_at DESC);
        END $$;
    `;

    const resilienceProfilesDDL = `
        DO $$
        BEGIN
            PERFORM pg_advisory_xact_lock(hashtext('gnucash_web_resilience_profiles_schema'));
            CREATE TABLE IF NOT EXISTS gnucash_web_resilience_profiles (
                book_guid VARCHAR(32) NOT NULL,
                section VARCHAR(32) NOT NULL,
                data JSONB NOT NULL DEFAULT '{}'::jsonb,
                secret_encrypted TEXT,
                updated_by INTEGER REFERENCES gnucash_web_users(id) ON DELETE SET NULL,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (book_guid, section)
            );
            CREATE INDEX IF NOT EXISTS idx_resilience_profiles_book
                ON gnucash_web_resilience_profiles(book_guid);
        END $$;
    `;

    try {
        await query(userTableDDL);
        await query(auditTableDDL);
        await query(addBalanceReversalDDL);
        await query(addOidcColumnsDDL);
        await query(addBooksColumnsDDL);
        await query(savedReportsTableDDL);
        await query(savedReportsTriggerDDL);
        await query(commodityMetadataTableDDL);
        await query(depreciationSchedulesTableDDL);
        await query(userPreferencesTableDDL);
        await query(transactionMetaTableDDL);
        await query(rolesTableDDL);
        await query(bookPermissionsTableDDL);
        await query(invitationsTableDDL);
        await query(simpleFinConnectionsTableDDL);
        await query(simpleFinConnectionsAddHealthDDL);
        await query(simpleFinAccountMapTableDDL);
        await query(simpleFinAccountMapAddInvestmentDDL);
        await query(transactionMetaAddDeletedAtDDL);
        await query(transactionMetaNullableGuidDDL);
        await query(simpleFinAccountMapAddBalanceDDL);
        await query(transactionMetaAddMatchColumnsDDL);
        await query(transactionMetaAddOriginalDescriptionDDL);
        await query(toolConfigTableDDL);
        await runOneTimeMigration(
            '2026-08-05-tool-config-scope-normalization',
            () => query(toolConfigNormalizeDDL),
        );
        await query(toolConfigUniqueIndexesDDL);
        await query(toolConfigTriggerDDL);
        await query(accountPreferencesTableDDL);
        await query(accountPreferencesRetirementDDL);
        await query(contributionLimitsTableDDL);
        await query(contributionTaxYearTableDDL);
        await query(transactionTypesTableDDL);
        await query(receiptsTableDDL);
        await query(receiptsExtractedDataDDL);
        await query(receiptsFtsDDL);
        await query(payslipsTableDDL);
        await query(aiConfigTableDDL);
        await query(importBatchesTableDDL);
        await query(webhookIdempotencyTableDDL);
        await query(notificationsTableDDL);
        await query(financialActionsTableDDL);
        await query(operatorBusinessWorkflowsDDL);
        await query(resilienceProfilesDDL);
        await query(LIVING_PLAN_SCHEMA_SQL);
        await query(tagsTableDDL);
        await query(taxMappingsTableDDL);
        await query(entityProfilesTableDDL);
        await query(entityProfilesTaxColumnsDDL);
        await query(entityProfilesActivityColumnDDL);
        await query(bookFeaturesTableDDL);
        await query(bookLinksTableDDL);
        await query(FAMILY_OFFICE_SCHEMA_SQL);
        await query(membershipTablesDDL);
        await query(auditBookScopeDDL);
        await query(auditUndoColumnsDDL);
        await query(tagsBookScopeDDL);
        await query(savedReportsBookScopeDDL);
        await query(smbTablesDDL);
        await query(invoiceSharesDDL);
        await query(estimatesTablesDDL);
        await query(dunningTablesDDL);
        await query(timeEntriesTableDDL);
        await query(bookSettingsTableDDL);
        await query(receiptsHsaColumnsDDL);
        await query(budgetOwnershipTableDDL);
        await query(businessEntityOwnershipTableDDL);
        await query(budgetEnvelopesTableDDL);
        await query(budgetFundingRulesTableDDL);
        await query(renewalsTableDDL);
        await query(homeTablesDDL);
        await query(homeItemPhotosTableDDL);
        await query(homeItemPhotosBackfillDDL);
        await query(CANONICAL_DOCUMENT_SCHEMA_SQL);
        // The legacy backfill is search-index population, NOT structure. It
        // copies <legacy table>.book_guid into
        // gnucash_web_documents.book_guid REFERENCES books(guid), but several
        // of those legacy tables have no FK of their own — so ONE orphaned row
        // makes this statement fail on every single boot. Letting that abort
        // createExtensionTables meant createUniqueConstraintGuards(),
        // createPerformanceIndexes(), dropRedundantIndexes() and
        // tuneAutovacuum() never ran, and the app served traffic without the
        // unique indexes the SimpleFIN / autofund / price idempotency paths
        // rely on. Degrade instead: log loudly (with the offending rows) and
        // continue.
        try {
            await query(LEGACY_DOCUMENT_BACKFILL_SQL);
        } catch (backfillError) {
            console.error(
                'ERROR: legacy document backfill failed — the canonical document index may be stale. Schema initialization continues.',
                backfillError,
            );
            await reportOrphanedBookGuids();
        }
        await reportUnattributedBusinessEntities();

        // Backfill: grant admin on all books to existing users with no permissions
        await query(`
            INSERT INTO gnucash_web_book_permissions (user_id, book_guid, role_id, granted_by, granted_at)
            SELECT u.id, b.guid,
                (SELECT id FROM gnucash_web_roles WHERE name = 'admin'),
                u.id, NOW()
            FROM gnucash_web_users u
            CROSS JOIN books b
            WHERE NOT EXISTS (
                SELECT 1 FROM gnucash_web_book_permissions bp
                WHERE bp.user_id = u.id AND bp.book_guid = b.guid
            )
            ON CONFLICT (user_id, book_guid) DO NOTHING;
        `);
        console.log('✓ Extension tables created/verified successfully');
    } catch (error) {
        console.error('Error creating extension tables:', error);
        throw error;
    }
}

/**
 * Creates performance indexes on core GnuCash tables if they don't exist.
 * These indexes are critical for query performance - without them, tables like
 * prices get full sequential scans on every currency/price lookup.
 *
 * See sql/001-performance-indexes.sql for the standalone version with full documentation.
 */
async function createPerformanceIndexes() {
    const indexes = [
        // PRICES - Critical: eliminates full table scans on every price/currency lookup
        `CREATE INDEX IF NOT EXISTS idx_prices_commodity_currency_date
            ON prices (commodity_guid, currency_guid, date DESC)`,
        `CREATE INDEX IF NOT EXISTS idx_prices_commodity_date
            ON prices (commodity_guid, date DESC)`,

        // ACCOUNTS - High: recursive CTE performance for account hierarchies
        `CREATE INDEX IF NOT EXISTS idx_accounts_parent_guid
            ON accounts (parent_guid)`,
        `CREATE INDEX IF NOT EXISTS idx_accounts_account_type
            ON accounts (account_type)`,
        `CREATE INDEX IF NOT EXISTS idx_accounts_commodity_guid
            ON accounts (commodity_guid)`,

        // TRANSACTIONS - Medium: search and sort optimization
        // (idx_transactions_description was removed: it used varchar_pattern_ops,
        // which can never serve the app's ILIKE '%...%' searches — see
        // dropRedundantIndexes below.)
        `CREATE INDEX IF NOT EXISTS idx_transactions_post_date_enter
            ON transactions (post_date DESC, enter_date DESC)`,
        `CREATE INDEX IF NOT EXISTS idx_transactions_currency_guid
            ON transactions (currency_guid)`,

        // TRANSACTIONS - High: covering index for the ubiquitous
        // splits -> transactions join that only needs the post_date filter
        `CREATE INDEX IF NOT EXISTS idx_transactions_guid_postdate
            ON transactions (guid) INCLUDE (post_date)`,

        // SPLITS - Low: reconciliation workflow optimization
        `CREATE INDEX IF NOT EXISTS idx_splits_account_reconcile
            ON splits (account_guid, reconcile_state)`,

        // SPLITS - High: covering index enables index-only scans for balance aggregates
        `CREATE INDEX IF NOT EXISTS idx_splits_account_covering
            ON splits (account_guid) INCLUDE (tx_guid, quantity_num, quantity_denom, value_num, value_denom)`,
        `CREATE INDEX IF NOT EXISTS idx_splits_tx_account
            ON splits (tx_guid, account_guid)`,

        // SPLITS - High: lot-linked splits (invoice views, cost basis, payment
        // allocation) — partial index avoids full-table scans on lot_guid
        `CREATE INDEX IF NOT EXISTS idx_splits_lot_guid
            ON splits (lot_guid) WHERE lot_guid IS NOT NULL`,

        // LOTS - Medium: per-account lot listing (lot engine, invoices)
        `CREATE INDEX IF NOT EXISTS idx_lots_account_guid
            ON lots (account_guid)`,

        // SLOTS - Medium: notes/lot metadata lookups filtered by name
        `CREATE INDEX IF NOT EXISTS idx_slots_obj_name
            ON slots (obj_guid, name)`,

        // SLOTS - Medium: name-only lookups (forecast-data, equity-comp history)
        `CREATE INDEX IF NOT EXISTS idx_slots_name_obj
            ON slots (name, obj_guid)`,
    ];

    try {
        for (const ddl of indexes) {
            await query(ddl);
        }
        // Update planner statistics so indexes are used immediately
        await query('ANALYZE');
        console.log('✓ Performance indexes created/verified successfully');
    } catch (error) {
        console.error('Error creating performance indexes:', error);
        // Don't throw - indexes are an optimization, not required for functionality
    }
}

/**
 * Drops app-owned indexes that live-DB analysis showed to be redundant or
 * unserviceable. Native GnuCash indexes are deliberately preserved because
 * the same database may also be opened by the desktop application.
 */
async function dropRedundantIndexes() {
    const dropDDL = `
        DO $$
        BEGIN
            PERFORM pg_advisory_xact_lock(hashtext('gnucash_web_drop_redundant_indexes'));

            -- idx_txn_meta_simplefin_id is an exact duplicate of the unique
            -- partial index uq_txn_meta_simplefin_id. The unique guard skips
            -- creation on dirty data, so keep the non-unique index until the
            -- unique one exists.
            IF to_regclass('uq_txn_meta_simplefin_id') IS NOT NULL THEN
                DROP INDEX IF EXISTS idx_txn_meta_simplefin_id;
            END IF;

            -- idx_transactions_description used varchar_pattern_ops (prefix
            -- matching); the app searches with ILIKE '%...%', which this index
            -- can never serve. Live-DB stats showed 0 scans. Also removed from
            -- the creation list so it is not recreated.
            DROP INDEX IF EXISTS idx_transactions_description;
        END $$;
    `;

    try {
        await query(dropDDL);
        console.log('✓ Redundant indexes dropped/verified successfully');
    } catch (error) {
        console.error('Error dropping redundant indexes:', error);
        // Don't throw - dropping duplicates is an optimization, not required
    }
}

async function migrateDuplicatePrices() {
    const migrationDDL = `
        WITH ranked AS (
            SELECT guid, ROW_NUMBER() OVER (
                PARTITION BY commodity_guid, currency_guid, date
                ORDER BY (source IS DISTINCT FROM 'Finance::Quote') DESC, guid DESC
            ) AS rn
            FROM prices
        ), doomed AS (
            SELECT price.*
            FROM prices price
            JOIN ranked ON ranked.guid = price.guid
            WHERE ranked.rn > 1
        )
        INSERT INTO gnucash_web_migration_backups
          (step_name, source_table, row_key, row_data)
        SELECT
          '2026-08-05-prices-deduplicate',
          'prices',
          guid,
          to_jsonb(doomed)
        FROM doomed
        ON CONFLICT (step_name, source_table, row_key) DO NOTHING;

        WITH ranked AS (
            SELECT guid, ROW_NUMBER() OVER (
                PARTITION BY commodity_guid, currency_guid, date
                ORDER BY (source IS DISTINCT FROM 'Finance::Quote') DESC, guid DESC
            ) AS rn
            FROM prices
        )
        DELETE FROM prices
        WHERE guid IN (SELECT guid FROM ranked WHERE rn > 1);
    `;

    await runOneTimeMigration(
        '2026-08-05-prices-deduplicate',
        () => query(migrationDDL),
    );
}

/**
 * Tunes autovacuum for the hot, high-churn core tables. The default
 * autovacuum_vacuum_scale_factor of 0.2 lets dead tuples pile up on large
 * tables; 0.05 keeps splits/transactions statistics and visibility maps
 * fresh (important for the index-only scans the covering indexes enable).
 * Idempotent: re-applying the same storage parameter is harmless.
 */
async function tuneAutovacuum() {
    const autovacuumDDL = `
        DO $$
        BEGIN
            PERFORM pg_advisory_xact_lock(hashtext('gnucash_web_autovacuum_tuning'));
            ALTER TABLE splits SET (autovacuum_vacuum_scale_factor = 0.05);
            ALTER TABLE transactions SET (autovacuum_vacuum_scale_factor = 0.05);
        END $$;
    `;

    try {
        await query(autovacuumDDL);
        console.log('✓ Autovacuum tuning applied successfully');
    } catch (error) {
        console.error('Error applying autovacuum tuning:', error);
        // Don't throw - tuning is an optimization, not required
    }
}

/**
 * Creates unique indexes that turn silent duplicate races into clean errors
 * (concurrency audit Phase 3: H3/H4/H5/H6/H7 and the C4 funding sweep).
 *
 * db-init runs at startup on live databases, so every guard here must be
 * duplicate-safe: each block first checks whether existing rows already
 * violate the candidate key. Where deduping is provably safe (prices,
 * reconciliation sessions) the block cleans up in place; everywhere else it
 * RAISEs a WARNING with a count and skips index creation — user data is
 * never deleted or renamed automatically.
 *
 * Deliberately NOT constrained: slots(obj_guid, name). GnuCash KVP list
 * slots legitimately store repeated (obj_guid, name) rows (a list's elements
 * all share the list's name), so a global unique index would corrupt
 * desktop-written books. The invoice/voucher counter race on slots is
 * already serialized by the Phase 2a advisory lock in invoice-engine.
 */
interface UniqueGuardSkipDiagnostic {
    /** Index the guard creates when the data is clean. */
    indexName: string;
    /** Counts the duplicate groups that block the index (column alias: dupes). */
    countSql: string;
    /** Copy-pasteable SQL the operator can run to list the offending rows. */
    findSql: string;
    /** What breaks in the app while the index is missing. */
    impact: string;
    /** How to clean up (never done automatically — this is user data). */
    advice: string;
}

interface UniqueGuard {
    label: string;
    ddl: string;
    /** Set only for guards that SKIP creation on dirty data rather than cleaning up. */
    skipDiagnostic?: UniqueGuardSkipDiagnostic;
}

/**
 * Make a skipped unique index VISIBLE to the application.
 *
 * The guards above raise a Postgres `WARNING` and move on. No pool installs a
 * `notice` listener, so node-postgres discards it silently — one duplicate
 * meant the index was never created again on ANY restart, forever, with the
 * affected writer silently back on its racy SELECT-then-INSERT path. This
 * re-checks whether the index actually exists and logs at error level with the
 * duplicate count and the SQL to find the offending rows. It never deletes or
 * rewrites user data.
 */
async function reportSkippedUniqueGuard(
    label: string,
    diagnostic: UniqueGuardSkipDiagnostic,
): Promise<void> {
    try {
        const presence = await query('SELECT to_regclass($1) IS NOT NULL AS present', [
            diagnostic.indexName,
        ]);
        // Only a definitive `false` means "guard skipped"; anything else
        // (index present, or the check itself inconclusive) is not reportable.
        if (presence.rows?.[0]?.present !== false) return;

        let dupes = 'an unknown number of';
        try {
            const counted = await query(diagnostic.countSql);
            const value = counted.rows?.[0]?.dupes;
            if (value !== undefined && value !== null) dupes = String(value);
        } catch {
            // Fall through with the "unknown" wording.
        }

        console.error(
            `ERROR: unique index ${diagnostic.indexName} on ${label} was NOT created — ` +
            `${dupes} duplicate group(s) block it. Until this is fixed and the app restarted, ` +
            `${diagnostic.impact}. ${diagnostic.advice} ` +
            `List the offending rows with: ${diagnostic.findSql}`,
        );
    } catch (error) {
        console.error(`Failed to verify unique index ${diagnostic.indexName} for ${label}:`, error);
    }
}

async function createUniqueConstraintGuards() {
    // Duplicate rows are handled by migrateDuplicatePrices(), which runs once
    // and writes every removed row to gnucash_web_migration_backups first.
    // The guard itself is non-destructive if later manual writes introduce new
    // duplicates.
    const pricesUniqueDDL = `
        DO $$
        DECLARE
            v_dirty integer;
        BEGIN
            PERFORM pg_advisory_xact_lock(hashtext('gnucash_web_prices_unique_guard'));
            IF to_regclass('uq_prices_commodity_currency_date') IS NULL THEN
                SELECT COUNT(*) INTO v_dirty FROM (
                    SELECT commodity_guid, currency_guid, date
                    FROM prices
                    GROUP BY commodity_guid, currency_guid, date
                    HAVING COUNT(*) > 1
                ) dupes;
                IF v_dirty > 0 THEN
                    RAISE WARNING 'gnucash-web: skipping unique price index: % duplicate group(s) exist after the recorded migration', v_dirty;
                ELSE
                    CREATE UNIQUE INDEX IF NOT EXISTS uq_prices_commodity_currency_date
                        ON prices (commodity_guid, currency_guid, date);
                END IF;
            END IF;
        END $$;
    `;

    // C5/H4: duplicate commodities. Merging commodities automatically is NOT
    // safe (accounts/prices/transactions reference them by guid), so a dirty
    // table skips the index with a warning.
    const commoditiesUniqueDDL = `
        DO $$
        DECLARE
            v_dirty integer;
        BEGIN
            PERFORM pg_advisory_xact_lock(hashtext('gnucash_web_commodities_unique_guard'));
            IF to_regclass('uq_commodities_namespace_mnemonic') IS NULL THEN
                SELECT COUNT(*) INTO v_dirty FROM (
                    SELECT namespace, mnemonic
                    FROM commodities
                    GROUP BY namespace, mnemonic
                    HAVING COUNT(*) > 1
                ) dupes;
                IF v_dirty > 0 THEN
                    RAISE WARNING 'gnucash-web: skipping unique index on commodities(namespace, mnemonic): % duplicate group(s) exist; merge duplicate commodities manually, then restart', v_dirty;
                ELSE
                    CREATE UNIQUE INDEX IF NOT EXISTS uq_commodities_namespace_mnemonic
                        ON commodities (namespace, mnemonic);
                END IF;
            END IF;
        END $$;
    `;

    // H4/H7: duplicate sibling accounts. parent_guid is NULL for root
    // accounts (one per book), so the index is scoped to non-root rows.
    // Merging/renaming accounts automatically is NOT safe — skip+warn.
    const accountsUniqueDDL = `
        DO $$
        DECLARE
            v_dirty integer;
        BEGIN
            PERFORM pg_advisory_xact_lock(hashtext('gnucash_web_accounts_sibling_name_guard'));
            IF to_regclass('uq_accounts_parent_name') IS NULL THEN
                SELECT COUNT(*) INTO v_dirty FROM (
                    SELECT parent_guid, name
                    FROM accounts
                    WHERE parent_guid IS NOT NULL
                    GROUP BY parent_guid, name
                    HAVING COUNT(*) > 1
                ) dupes;
                IF v_dirty > 0 THEN
                    RAISE WARNING 'gnucash-web: skipping unique index on accounts(parent_guid, name): % duplicate sibling group(s) exist; rename or merge the duplicate accounts manually, then restart', v_dirty;
                ELSE
                    CREATE UNIQUE INDEX IF NOT EXISTS uq_accounts_parent_name
                        ON accounts (parent_guid, name)
                        WHERE parent_guid IS NOT NULL;
                END IF;
            END IF;
        END $$;
    `;

    // H3: duplicate SimpleFin imports. Duplicate rows mean transactions were
    // imported twice — those are real ledger transactions the user must
    // reconcile manually, so never NULL-out or delete automatically.
    const simpleFinIdUniqueDDL = `
        DO $$
        DECLARE
            v_dirty integer;
        BEGIN
            PERFORM pg_advisory_xact_lock(hashtext('gnucash_web_txn_meta_simplefin_unique_guard'));
            IF to_regclass('uq_txn_meta_simplefin_id') IS NULL THEN
                SELECT COUNT(*) INTO v_dirty FROM (
                    SELECT simplefin_transaction_id
                    FROM gnucash_web_transaction_meta
                    WHERE simplefin_transaction_id IS NOT NULL
                    GROUP BY simplefin_transaction_id
                    HAVING COUNT(*) > 1
                ) dupes;
                IF v_dirty > 0 THEN
                    RAISE WARNING 'gnucash-web: skipping unique index on gnucash_web_transaction_meta(simplefin_transaction_id): % duplicated id(s) exist; the duplicate imports are real transactions — reconcile and delete them manually, then restart', v_dirty;
                ELSE
                    CREATE UNIQUE INDEX IF NOT EXISTS uq_txn_meta_simplefin_id
                        ON gnucash_web_transaction_meta (simplefin_transaction_id)
                        WHERE simplefin_transaction_id IS NOT NULL;
                END IF;
            END IF;
        END $$;
    `;

    // H6: at most one 'started' reconciliation session per account. Deduping
    // is safe here — mark all but the most recent 'started' session per
    // account as 'abandoned' ('abandoned' is an existing terminal status,
    // see reconciliation-coverage.ts / the sessions PATCH route).
    const reconciliationStartedUniqueDDL = `
        DO $$
        DECLARE
            v_abandoned integer;
        BEGIN
            PERFORM pg_advisory_xact_lock(hashtext('gnucash_web_reconciliation_started_guard'));
            IF to_regclass('uq_reconciliation_sessions_started') IS NULL THEN
                WITH ranked AS (
                    SELECT id, ROW_NUMBER() OVER (
                        PARTITION BY account_guid
                        ORDER BY started_at DESC, id DESC
                    ) AS rn
                    FROM gnucash_web_reconciliation_sessions
                    WHERE status = 'started'
                )
                UPDATE gnucash_web_reconciliation_sessions s
                SET status = 'abandoned'
                FROM ranked r
                WHERE s.id = r.id AND r.rn > 1;
                GET DIAGNOSTICS v_abandoned = ROW_COUNT;
                IF v_abandoned > 0 THEN
                    RAISE WARNING 'gnucash-web: marked % duplicate started reconciliation session(s) as abandoned before creating uq_reconciliation_sessions_started', v_abandoned;
                END IF;
            END IF;
            CREATE UNIQUE INDEX IF NOT EXISTS uq_reconciliation_sessions_started
                ON gnucash_web_reconciliation_sessions (account_guid)
                WHERE status = 'started';
        END $$;
    `;

    // C4: funding-sweep dedupe key. funding-rules.service stamps sweep
    // transactions with num = 'autofund:<ruleId>:<triggerTxnGuid>'
    // (DEDUPE_PREFIX in src/lib/services/funding-rules.service.ts). Deduping
    // here is NOT safe — deleting a duplicate would delete a real sweep
    // transaction (real money movement) — so a dirty table skips with a
    // warning.
    const autofundNumUniqueDDL = `
        DO $$
        DECLARE
            v_dirty integer;
        BEGIN
            PERFORM pg_advisory_xact_lock(hashtext('gnucash_web_transactions_autofund_guard'));
            IF to_regclass('uq_transactions_autofund_num') IS NULL THEN
                SELECT COUNT(*) INTO v_dirty FROM (
                    SELECT num
                    FROM transactions
                    WHERE num LIKE 'autofund:%'
                    GROUP BY num
                    HAVING COUNT(*) > 1
                ) dupes;
                IF v_dirty > 0 THEN
                    RAISE WARNING 'gnucash-web: skipping unique index on transactions(num) for autofund sweeps: % duplicated sweep key(s) exist; the duplicates are real transactions — review and delete the double-sweeps manually, then restart', v_dirty;
                ELSE
                    CREATE UNIQUE INDEX IF NOT EXISTS uq_transactions_autofund_num
                        ON transactions (num)
                        WHERE num LIKE 'autofund:%';
                END IF;
            END IF;
        END $$;
    `;

    const guards: UniqueGuard[] = [
        { label: 'prices(commodity_guid, currency_guid, date)', ddl: pricesUniqueDDL },
        {
            label: 'commodities(namespace, mnemonic)',
            ddl: commoditiesUniqueDDL,
            skipDiagnostic: {
                indexName: 'uq_commodities_namespace_mnemonic',
                countSql: `SELECT COUNT(*)::int AS dupes FROM (
                    SELECT namespace, mnemonic FROM commodities
                    GROUP BY namespace, mnemonic HAVING COUNT(*) > 1) d`,
                findSql: `SELECT namespace, mnemonic, COUNT(*) FROM commodities GROUP BY 1, 2 HAVING COUNT(*) > 1;`,
                impact: 'commodity creation can race and produce more duplicates',
                advice: 'Merge the duplicate commodities manually, then restart.',
            },
        },
        {
            label: 'accounts(parent_guid, name)',
            ddl: accountsUniqueDDL,
            skipDiagnostic: {
                indexName: 'uq_accounts_parent_name',
                countSql: `SELECT COUNT(*)::int AS dupes FROM (
                    SELECT parent_guid, name FROM accounts WHERE parent_guid IS NOT NULL
                    GROUP BY parent_guid, name HAVING COUNT(*) > 1) d`,
                findSql: `SELECT parent_guid, name, COUNT(*) FROM accounts WHERE parent_guid IS NOT NULL GROUP BY 1, 2 HAVING COUNT(*) > 1;`,
                impact: 'findOrCreateAccount falls back to a racy SELECT-then-INSERT',
                advice: 'Rename or merge the duplicate sibling accounts manually, then restart.',
            },
        },
        {
            label: 'gnucash_web_transaction_meta(simplefin_transaction_id)',
            ddl: simpleFinIdUniqueDDL,
            skipDiagnostic: {
                indexName: 'uq_txn_meta_simplefin_id',
                countSql: `SELECT COUNT(*)::int AS dupes FROM (
                    SELECT simplefin_transaction_id FROM gnucash_web_transaction_meta
                    WHERE simplefin_transaction_id IS NOT NULL
                    GROUP BY simplefin_transaction_id HAVING COUNT(*) > 1) d`,
                findSql: `SELECT simplefin_transaction_id, COUNT(*) FROM gnucash_web_transaction_meta WHERE simplefin_transaction_id IS NOT NULL GROUP BY 1 HAVING COUNT(*) > 1;`,
                impact: 'SimpleFIN dedupe falls back to a racy SELECT-then-INSERT and can import MORE duplicates',
                advice: 'The duplicate imports are real transactions — reconcile and delete them manually, then restart.',
            },
        },
        {
            label: 'gnucash_web_reconciliation_sessions(account_guid) started',
            ddl: reconciliationStartedUniqueDDL,
        },
        {
            label: 'transactions(num) autofund',
            ddl: autofundNumUniqueDDL,
            skipDiagnostic: {
                indexName: 'uq_transactions_autofund_num',
                countSql: `SELECT COUNT(*)::int AS dupes FROM (
                    SELECT num FROM transactions WHERE num LIKE 'autofund:%'
                    GROUP BY num HAVING COUNT(*) > 1) d`,
                findSql: `SELECT num, COUNT(*) FROM transactions WHERE num LIKE 'autofund:%' GROUP BY 1 HAVING COUNT(*) > 1;`,
                impact: 'the budget auto-funding sweep can double-apply a rule',
                advice: 'The duplicates are real transactions (real money movement) — review and delete the double-sweeps manually, then restart.',
            },
        },
    ];

    for (const guard of guards) {
        try {
            await query(guard.ddl);
        } catch (error) {
            // One dirty/failed guard must not block the remaining guards or
            // app startup; the affected writer keeps its pre-index behavior.
            console.error(`Error creating unique constraint guard for ${guard.label}:`, error);
        }
        if (guard.skipDiagnostic) {
            await reportSkippedUniqueGuard(guard.label, guard.skipDiagnostic);
        }
    }
    console.log('✓ Unique constraint guards created/verified successfully');
}

/**
 * Initializes the database schema by creating required views and tables.
 * This should be called once when the application starts.
 */
export async function initializeDatabase() {
    try {
        console.log('Initializing database schema...');
        await withDatabaseAdvisoryLock('gnucash-web:database-initialization', async () => {
            await query(SCHEMA_META_DDL);
            await createAccountHierarchyView();
            await createExtensionTables();
            await migrateDuplicatePrices();
            await createUniqueConstraintGuards();
            await createPerformanceIndexes();
            // After the superseding indexes exist, retire the redundant ones
            await dropRedundantIndexes();
            await tuneAutovacuum();
        });
        console.log('✓ Database initialization complete');
    } catch (error) {
        // RETHROW. Swallowing this let the app come up on a half-migrated
        // schema — missing views, missing unique indexes — and serve traffic
        // normally, which is far worse than refusing to start. Each individual
        // optimization step (indexes, autovacuum, unique guards) already
        // swallows its own non-fatal errors, so anything reaching here is
        // structural.
        console.error('Database initialization failed:', error);
        throw error;
    }
}

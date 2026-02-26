import { query } from './db';

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
            WHERE a.parent_guid = (
                SELECT guid 
                FROM accounts 
                WHERE account_type = 'ROOT' 
                AND name LIKE 'Root%'
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
        CREATE INDEX IF NOT EXISTS idx_txn_meta_simplefin_id ON gnucash_web_transaction_meta(simplefin_transaction_id) WHERE simplefin_transaction_id IS NOT NULL;
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
            ('admin', 'Full access including user management and book administration')
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
            sync_enabled BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(user_id, book_guid)
        );
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

    try {
        await query(userTableDDL);
        await query(auditTableDDL);
        await query(addBalanceReversalDDL);
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
        await query(simpleFinAccountMapTableDDL);
        await query(simpleFinAccountMapAddInvestmentDDL);
        await query(transactionMetaAddDeletedAtDDL);
        await query(transactionMetaNullableGuidDDL);
        await query(simpleFinAccountMapAddBalanceDDL);

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
        `CREATE INDEX IF NOT EXISTS idx_transactions_post_date_enter
            ON transactions (post_date DESC, enter_date DESC)`,
        `CREATE INDEX IF NOT EXISTS idx_transactions_description
            ON transactions USING btree (description varchar_pattern_ops)`,
        `CREATE INDEX IF NOT EXISTS idx_transactions_currency_guid
            ON transactions (currency_guid)`,

        // SPLITS - Low: reconciliation workflow optimization
        `CREATE INDEX IF NOT EXISTS idx_splits_account_reconcile
            ON splits (account_guid, reconcile_state)`,
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
 * Initializes the database schema by creating required views and tables.
 * This should be called once when the application starts.
 */
export async function initializeDatabase() {
    try {
        console.log('Initializing database schema...');
        await createAccountHierarchyView();
        await createExtensionTables();
        await createPerformanceIndexes();
        console.log('✓ Database initialization complete');
    } catch (error) {
        console.error('Database initialization failed:', error);
        // Don't throw - allow the app to continue even if initialization fails
        // The views might already exist or there might be permission issues
    }
}

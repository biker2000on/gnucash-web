import { query } from './db';
import {
    CALCULATION_TRACES_SCHEMA_SQL,
    FINANCIAL_ACTIONS_SCHEMA_SQL,
} from './financial-actions/schema';
import {
    FAMILY_OFFICE_SCHEMA_SQL,
    LIVING_PLAN_SCHEMA_SQL,
} from './planning/schema';

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

        -- Singleton configs used to be implemented as read-then-create, which
        -- allowed duplicate rows under concurrent requests. Keep the newest
        -- singleton and enforce both personal and shared-book scopes while
        -- preserving account-associated multi-instance tools (mortgages).
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

        -- Farm setup is book policy: promote the newest legacy per-user row
        -- to the shared scope, then discard the stale personal copies.
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
        await query(toolConfigTableDDL);
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
        await query(notificationsTableDDL);
        await query(financialActionsTableDDL);
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
        await query(tagsBookScopeDDL);
        await query(savedReportsBookScopeDDL);
        await query(smbTablesDDL);
        await query(invoiceSharesDDL);
        await query(estimatesTablesDDL);
        await query(dunningTablesDDL);
        await query(timeEntriesTableDDL);
        await query(bookSettingsTableDDL);
        await query(receiptsHsaColumnsDDL);
        await query(budgetFundingRulesTableDDL);
        await query(renewalsTableDDL);
        await query(homeTablesDDL);
        await query(homeItemPhotosTableDDL);
        await query(homeItemPhotosBackfillDDL);

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

        // SPLITS - High: covering index enables index-only scans for balance aggregates
        `CREATE INDEX IF NOT EXISTS idx_splits_account_covering
            ON splits (account_guid) INCLUDE (tx_guid, quantity_num, quantity_denom, value_num, value_denom)`,
        `CREATE INDEX IF NOT EXISTS idx_splits_tx_account
            ON splits (tx_guid, account_guid)`,

        // SLOTS - Medium: notes/lot metadata lookups filtered by name
        `CREATE INDEX IF NOT EXISTS idx_slots_obj_name
            ON slots (obj_guid, name)`,
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

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

    try {
        await query(userTableDDL);
        await query(auditTableDDL);
        await query(addBalanceReversalDDL);
        console.log('✓ Extension tables created/verified successfully');
    } catch (error) {
        console.error('Error creating extension tables:', error);
        throw error;
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
        console.log('✓ Database initialization complete');
    } catch (error) {
        console.error('Database initialization failed:', error);
        // Don't throw - allow the app to continue even if initialization fails
        // The views might already exist or there might be permission issues
    }
}

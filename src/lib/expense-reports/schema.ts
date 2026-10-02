/**
 * Owner expense reports — schema (see src/lib/expense-reports/service.ts).
 *
 * An owner pays business expenses on a personal card; the household book
 * codes them to a "reimbursable" receivable. A report bundles those charges
 * (or parts of them) for a LINKED business book, which categorizes, approves,
 * and reimburses it. Nothing ever writes one transaction across two books:
 * each side gets its own balanced transaction, tied together by these rows.
 *
 *   settings  — per (business, household) book link: the household
 *               receivable, the owner's employee record in the business book,
 *               the settlement mode, contribution accounts, and the
 *               accountable-plan submission deadline.
 *   reports   — ER-<number> per business book, with the voucher / payment /
 *               household settlement transactions it produced.
 *   lines     — allocations of household splits. kind='business' lines
 *               belong to a report; kind='personal' rows record the part of a
 *               charge the user marked personal (the ledger rewrite that moved
 *               it off the receivable), so the history of every charge is
 *               explicit and auditable.
 *
 * Idempotent DDL behind an advisory lock (db-init runs in app and worker).
 */

export const EXPENSE_REPORTS_SCHEMA_SQL = `
DO $$
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('gnucash_web_expense_reports_schema'));

    CREATE TABLE IF NOT EXISTS gnucash_web_expense_report_settings (
        business_book_guid VARCHAR(32) NOT NULL,
        household_book_guid VARCHAR(32) NOT NULL,
        reimbursable_account_guid VARCHAR(32),
        employee_guid VARCHAR(32),
        settlement_mode VARCHAR(20) NOT NULL DEFAULT 'reimburse',
        contribution_account_guid VARCHAR(32),
        household_investment_account_guid VARCHAR(32),
        household_deposit_account_guid VARCHAR(32),
        payment_account_guid VARCHAR(32),
        submission_deadline_days INTEGER NOT NULL DEFAULT 60,
        report_since DATE,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (business_book_guid, household_book_guid)
    );
    -- Charges before this date are ignored (the receivable may hold years of
    -- charges that were reimbursed by hand before expense reports existed).
    ALTER TABLE gnucash_web_expense_report_settings ADD COLUMN IF NOT EXISTS report_since DATE;

    CREATE TABLE IF NOT EXISTS gnucash_web_expense_reports (
        id SERIAL PRIMARY KEY,
        business_book_guid VARCHAR(32) NOT NULL,
        household_book_guid VARCHAR(32) NOT NULL,
        number INTEGER NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'submitted',
        settlement_mode VARCHAR(20) NOT NULL DEFAULT 'reimburse',
        title TEXT,
        notes TEXT,
        submitted_by INTEGER,
        submitted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        approved_by INTEGER,
        approved_at TIMESTAMP,
        voucher_guid VARCHAR(32),
        business_txn_guid VARCHAR(32),
        payment_txn_guid VARCHAR(32),
        paid_at TIMESTAMP,
        household_txn_guid VARCHAR(32),
        household_settled_at TIMESTAMP,
        rejection_reason TEXT,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS gnucash_web_expense_reports_business_book_guid_number_key
        ON gnucash_web_expense_reports(business_book_guid, number);
    CREATE INDEX IF NOT EXISTS idx_expense_reports_household
        ON gnucash_web_expense_reports(household_book_guid, status);

    CREATE TABLE IF NOT EXISTS gnucash_web_expense_report_lines (
        id SERIAL PRIMARY KEY,
        report_id INTEGER REFERENCES gnucash_web_expense_reports(id) ON DELETE CASCADE,
        kind VARCHAR(10) NOT NULL DEFAULT 'business',
        household_book_guid VARCHAR(32) NOT NULL,
        business_book_guid VARCHAR(32) NOT NULL,
        source_split_guid VARCHAR(32) NOT NULL,
        source_tx_guid VARCHAR(32) NOT NULL,
        amount NUMERIC(14, 2) NOT NULL,
        expense_date DATE NOT NULL,
        description TEXT,
        business_purpose TEXT,
        expense_account_guid VARCHAR(32),
        categorized_by VARCHAR(40),
        personal_account_guid VARCHAR(32),
        personal_split_guid VARCHAR(32),
        document_ids INTEGER[] NOT NULL DEFAULT '{}',
        accountable_plan BOOLEAN NOT NULL DEFAULT false,
        late BOOLEAN NOT NULL DEFAULT false,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_by INTEGER,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_expense_report_lines_source
        ON gnucash_web_expense_report_lines(source_split_guid);
    CREATE INDEX IF NOT EXISTS idx_expense_report_lines_report
        ON gnucash_web_expense_report_lines(report_id, sort_order);
END $$;
`;

/**
 * Contractor portal links (src/lib/business/vendor-portal.service.ts). Lives
 * here only so db-init has one place for this release's business tables.
 */
export const VENDOR_PORTAL_SCHEMA_SQL = `
DO $$
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('gnucash_web_vendor_portal_schema'));
    CREATE TABLE IF NOT EXISTS gnucash_web_vendor_portal_links (
        id SERIAL PRIMARY KEY,
        book_guid VARCHAR(32) NOT NULL,
        vendor_guid VARCHAR(32) NOT NULL,
        token_hash CHAR(64) NOT NULL UNIQUE,
        prefix VARCHAR(16) NOT NULL,
        label VARCHAR(100),
        created_by INTEGER,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP NOT NULL,
        revoked_at TIMESTAMP,
        last_viewed_at TIMESTAMP,
        view_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_vendor_portal_links_vendor
        ON gnucash_web_vendor_portal_links(book_guid, vendor_guid);
END $$;
`;

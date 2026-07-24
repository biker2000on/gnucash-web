export const LIVING_PLAN_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS gnucash_web_living_plans (
    id VARCHAR(36) PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES gnucash_web_users(id) ON DELETE CASCADE,
    household_book_guid VARCHAR(32) NOT NULL,
    name VARCHAR(255) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'adopted',
    current_version INTEGER NOT NULL DEFAULT 1,
    adopted_at TIMESTAMP NOT NULL DEFAULT NOW(),
    archived_at TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_living_plan_one_adopted
    ON gnucash_web_living_plans(user_id, household_book_guid)
    WHERE status = 'adopted';

  CREATE TABLE IF NOT EXISTS gnucash_web_living_plan_versions (
    id BIGSERIAL PRIMARY KEY,
    plan_id VARCHAR(36) NOT NULL REFERENCES gnucash_web_living_plans(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    scenario JSONB NOT NULL,
    assumptions JSONB NOT NULL,
    life_events JSONB NOT NULL DEFAULT '[]'::jsonb,
    guardrails JSONB NOT NULL DEFAULT '{}'::jsonb,
    baseline JSONB NOT NULL,
    projection JSONB NOT NULL,
    change_note TEXT,
    created_by INTEGER NOT NULL REFERENCES gnucash_web_users(id),
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE (plan_id, version)
  );

  CREATE TABLE IF NOT EXISTS gnucash_web_living_plan_reconciliations (
    id BIGSERIAL PRIMARY KEY,
    plan_id VARCHAR(36) NOT NULL REFERENCES gnucash_web_living_plans(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    period VARCHAR(7) NOT NULL,
    actual_baseline JSONB NOT NULL,
    current_projection JSONB NOT NULL,
    variances JSONB NOT NULL,
    causes JSONB NOT NULL,
    guardrail_results JSONB NOT NULL DEFAULT '[]'::jsonb,
    reconciled_at TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE (plan_id, period)
  );

  CREATE TABLE IF NOT EXISTS gnucash_web_living_plan_decisions (
    id BIGSERIAL PRIMARY KEY,
    plan_id VARCHAR(36) NOT NULL REFERENCES gnucash_web_living_plans(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    alternatives JSONB NOT NULL DEFAULT '[]'::jsonb,
    assumptions JSONB NOT NULL DEFAULT '[]'::jsonb,
    selected_action TEXT NOT NULL,
    expected_impact TEXT,
    actual_outcome TEXT,
    decided_at TIMESTAMP NOT NULL DEFAULT NOW(),
    reviewed_at TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_living_plan_versions
    ON gnucash_web_living_plan_versions(plan_id, version DESC);
  CREATE INDEX IF NOT EXISTS idx_living_plan_reconciliations
    ON gnucash_web_living_plan_reconciliations(plan_id, period DESC);
  CREATE INDEX IF NOT EXISTS idx_living_plan_decisions
    ON gnucash_web_living_plan_decisions(plan_id, decided_at DESC);
`;

export const FAMILY_OFFICE_SCHEMA_SQL = `
  ALTER TABLE gnucash_web_book_links
    ADD COLUMN IF NOT EXISTS relationship_type VARCHAR(30) NOT NULL DEFAULT 'owned_business',
    ADD COLUMN IF NOT EXISTS notes TEXT;

  CREATE TABLE IF NOT EXISTS gnucash_web_interbook_eliminations (
    id BIGSERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES gnucash_web_users(id) ON DELETE CASCADE,
    household_book_guid VARCHAR(32) NOT NULL,
    left_book_guid VARCHAR(32) NOT NULL,
    left_transaction_guid VARCHAR(32) NOT NULL,
    right_book_guid VARCHAR(32) NOT NULL,
    right_transaction_guid VARCHAR(32) NOT NULL,
    amount NUMERIC(24, 8) NOT NULL,
    currency VARCHAR(16) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'approved',
    approved_at TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, left_transaction_guid, right_transaction_guid)
  );

  CREATE INDEX IF NOT EXISTS idx_interbook_eliminations_household
    ON gnucash_web_interbook_eliminations(user_id, household_book_guid, status);
`;

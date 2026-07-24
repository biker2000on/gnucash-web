export const FINANCIAL_ACTIONS_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS gnucash_web_financial_actions (
    id VARCHAR(40) PRIMARY KEY,
    stable_key VARCHAR(255) NOT NULL,
    user_id INTEGER NOT NULL REFERENCES gnucash_web_users(id) ON DELETE CASCADE,
    book_guid VARCHAR(32) NOT NULL,
    lane VARCHAR(20) NOT NULL,
    origin VARCHAR(50) NOT NULL,
    source_id VARCHAR(255) NOT NULL,
    severity VARCHAR(20) NOT NULL DEFAULT 'info',
    title VARCHAR(255) NOT NULL,
    summary TEXT NOT NULL,
    due_date DATE,
    impact JSONB,
    confidence DOUBLE PRECISION NOT NULL DEFAULT 1,
    score JSONB,
    assignee VARCHAR(255),
    operations JSONB NOT NULL DEFAULT '[]'::jsonb,
    trace JSONB NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    state VARCHAR(20) NOT NULL DEFAULT 'open',
    snoozed_until TIMESTAMP,
    first_seen_at TIMESTAMP NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMP NOT NULL DEFAULT NOW(),
    state_changed_at TIMESTAMP NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMP,
    UNIQUE (user_id, book_guid, stable_key)
  );

  CREATE INDEX IF NOT EXISTS idx_financial_actions_inbox
    ON gnucash_web_financial_actions(user_id, book_guid, state, lane);
  CREATE INDEX IF NOT EXISTS idx_financial_actions_due
    ON gnucash_web_financial_actions(user_id, book_guid, due_date)
    WHERE state IN ('open', 'snoozed', 'accepted');
  CREATE INDEX IF NOT EXISTS idx_financial_actions_weekly
    ON gnucash_web_financial_actions(user_id, book_guid, state_changed_at DESC);

  CREATE TABLE IF NOT EXISTS gnucash_web_financial_action_refresh (
    user_id INTEGER NOT NULL REFERENCES gnucash_web_users(id) ON DELETE CASCADE,
    book_guid VARCHAR(32) NOT NULL,
    last_successful_refresh TIMESTAMP NOT NULL,
    PRIMARY KEY (user_id, book_guid)
  );
`;

export const CALCULATION_TRACES_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS gnucash_web_calculation_traces (
    trace_id VARCHAR(64) NOT NULL,
    user_id INTEGER NOT NULL REFERENCES gnucash_web_users(id) ON DELETE CASCADE,
    book_guid VARCHAR(32) NOT NULL,
    title VARCHAR(255) NOT NULL,
    trace JSONB NOT NULL,
    first_generated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    last_generated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (trace_id, user_id, book_guid)
  );

  CREATE INDEX IF NOT EXISTS idx_calculation_traces_book
    ON gnucash_web_calculation_traces(user_id, book_guid, last_generated_at DESC);
`;

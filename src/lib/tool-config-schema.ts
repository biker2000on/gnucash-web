/** Preserve singleton tools while allowing named personal debt scenarios.
 * Create the replacement before dropping the old index; a single query runs
 * both statements atomically. No configuration rows are removed.
 */
export const TOOL_CONFIG_PERSONAL_INDEX_SQL = `
  CREATE UNIQUE INDEX IF NOT EXISTS uq_tool_config_user_singleton_v2
    ON gnucash_web_tool_config(user_id, book_guid, tool_type)
    WHERE user_id IS NOT NULL AND account_guid IS NULL AND tool_type <> 'debt-vs-invest';
  DROP INDEX IF EXISTS uq_tool_config_user_singleton;
`;

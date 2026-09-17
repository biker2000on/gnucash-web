import { expect, it } from 'vitest';
import { withTestClient } from './db';
import { TOOL_CONFIG_PERSONAL_INDEX_SQL } from '@/lib/tool-config-schema';

it('preserves existing configurations, allows named scenarios and retains singleton upserts', async () => {
  await withTestClient(async client => {
    await client.query('BEGIN');
    try {
      // A temporary shadow table keeps this migration proof fully isolated.
      await client.query(`CREATE TEMP TABLE gnucash_web_tool_config (user_id int, book_guid text, tool_type text, account_guid text, name text);
        CREATE UNIQUE INDEX uq_tool_config_user_singleton ON gnucash_web_tool_config(user_id, book_guid, tool_type) WHERE user_id IS NOT NULL AND account_guid IS NULL;
        INSERT INTO gnucash_web_tool_config VALUES (1, 'book', 'debt-vs-invest', NULL, 'Original'), (1, 'book', 'fire', NULL, 'Singleton');`);
      await client.query(TOOL_CONFIG_PERSONAL_INDEX_SQL);
      await client.query(TOOL_CONFIG_PERSONAL_INDEX_SQL);
      await client.query(`INSERT INTO gnucash_web_tool_config VALUES (1, 'book', 'debt-vs-invest', NULL, 'Alternative');`);
      expect((await client.query(`SELECT name FROM gnucash_web_tool_config WHERE tool_type = 'debt-vs-invest' ORDER BY name`)).rows).toEqual([{ name: 'Alternative' }, { name: 'Original' }]);
      await client.query(`INSERT INTO gnucash_web_tool_config VALUES (1, 'book', 'fire', NULL, 'Updated')
        ON CONFLICT (user_id, book_guid, tool_type)
        WHERE user_id IS NOT NULL AND account_guid IS NULL AND tool_type <> 'debt-vs-invest'
        DO UPDATE SET name = EXCLUDED.name;`);
      expect((await client.query(`SELECT name FROM gnucash_web_tool_config WHERE tool_type = 'fire'`)).rows).toEqual([{ name: 'Updated' }]);
      await client.query('SAVEPOINT duplicate');
      await expect(client.query(`INSERT INTO gnucash_web_tool_config VALUES (1, 'book', 'fire', NULL, 'Duplicate')`)).rejects.toMatchObject({ code: '23505' });
      await client.query('ROLLBACK TO SAVEPOINT duplicate');
    } finally { await client.query('ROLLBACK'); }
  });
});

import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

type IdempotencyModule = typeof import('../webhook-idempotency');
type PrismaModule = typeof import('../prisma');

// Vitest runs from the repository root, whether this checkout is a main
// worktree or a linked worktree. Missing credentials skip this optional suite;
// they must never make the regular unit suite fail to load.
loadEnv({ path: resolve(process.cwd(), '.env.test.local'), override: true, quiet: true });
const hasTestDatabase = Boolean(process.env.TEST_DATABASE_URL);
if (hasTestDatabase) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

let idempotency: IdempotencyModule;
let prismaModule: PrismaModule;
let secondPrisma: import('@prisma/client').PrismaClient;
const fixtureId = crypto.randomUUID().replaceAll('-', '');
const bookGuid = fixtureId;
const currencyGuid = crypto.randomUUID().replaceAll('-', '');
const rootAccountGuid = crypto.randomUUID().replaceAll('-', '');
const postingAccountGuid = crypto.randomUUID().replaceAll('-', '');
const testKeys: string[] = [];

function key(suffix: string): string {
  const value = `integration-${suffix}-${crypto.randomUUID()}`;
  testKeys.push(value);
  return value;
}

const sleep = (milliseconds: number) => new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds));

describe.skipIf(!hasTestDatabase)('webhook idempotency against PostgreSQL', () => {
  beforeAll(async () => {
    idempotency = await import('../webhook-idempotency');
    prismaModule = await import('../prisma');
    const [{ PrismaClient }, { Pool }, { PrismaPg }] = await Promise.all([
      import('@prisma/client'), import('pg'), import('@prisma/adapter-pg'),
    ]);
    secondPrisma = new PrismaClient({
      adapter: new PrismaPg(new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 })),
    });
    await idempotency.ensureWebhookIdempotencyTable();
    const prisma = prismaModule.default;
    // Integration fixtures own all prerequisite GnuCash rows; CI provisions
    // an empty database, so this suite must not depend on a developer's book.
    await prisma.$executeRaw`
      INSERT INTO commodities
        (guid, namespace, mnemonic, fullname, cusip, fraction, quote_flag, quote_source, quote_tz)
      VALUES (${currencyGuid}, 'CURRENCY', ${`IT${fixtureId.slice(0, 12)}`}, 'Integration Test Currency',
              NULL, 100, 0, NULL, NULL)
    `;
    await prisma.$executeRaw`
      INSERT INTO accounts
        (guid, name, account_type, commodity_guid, commodity_scu, non_std_scu,
         parent_guid, code, description, hidden, placeholder)
      VALUES (${rootAccountGuid}, 'Integration Test Root', 'ROOT', ${currencyGuid}, 100, 0,
              NULL, NULL, NULL, 0, 1)
    `;
    await prisma.$executeRaw`
      INSERT INTO accounts
        (guid, name, account_type, commodity_guid, commodity_scu, non_std_scu,
         parent_guid, code, description, hidden, placeholder)
      VALUES (${postingAccountGuid}, 'Integration Test Posting', 'ASSET', ${currencyGuid}, 100, 0,
              ${rootAccountGuid}, NULL, NULL, 0, 0)
    `;
    await prisma.$executeRaw`
      INSERT INTO books (guid, root_account_guid, root_template_guid, name, description)
      VALUES (${bookGuid}, ${rootAccountGuid}, ${rootAccountGuid}, 'Webhook idempotency integration fixture', NULL)
    `;
  });

  afterAll(async () => {
    const prisma = prismaModule.default;
    await prisma.$executeRaw`
      DELETE FROM gnucash_web_webhook_idempotency
      WHERE book_guid = ${bookGuid} AND idempotency_key = ANY(${testKeys}::text[])
    `;
    const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS count
      FROM gnucash_web_webhook_idempotency
      WHERE book_guid = ${bookGuid} AND idempotency_key = ANY(${testKeys}::text[])
    `;
    expect(rows[0]?.count ?? 0n).toBe(0n);
    await prisma.$executeRaw`DELETE FROM books WHERE guid = ${bookGuid}`;
    await prisma.$executeRaw`DELETE FROM accounts WHERE guid = ${postingAccountGuid}`;
    await prisma.$executeRaw`DELETE FROM accounts WHERE guid = ${rootAccountGuid}`;
    await prisma.$executeRaw`DELETE FROM commodities WHERE guid = ${currencyGuid}`;
    await secondPrisma.$disconnect();
    await prisma.$disconnect();
  });

  it('blocks a second connection on the fence, then replays after the owner commits', async () => {
    const eventKey = key('fence');
    const prisma = prismaModule.default;
    expect(await idempotency.claimWebhookIdempotency(bookGuid, 'transaction', eventKey))
      .toEqual({ status: 'claimed', attempt: 1 });

    let fenceHeld!: () => void;
    const fenceHeldPromise = new Promise<void>(resolvePromise => { fenceHeld = resolvePromise; });
    let allowCommit!: () => void;
    const allowCommitPromise = new Promise<void>(resolvePromise => { allowCommit = resolvePromise; });
    const owner = prisma.$transaction(async (tx) => {
      await idempotency.lockWebhookIdempotencyAttempt(bookGuid, 'transaction', eventKey, 1, tx);
      fenceHeld();
      await allowCommitPromise;
      await idempotency.completeWebhookIdempotency(
        bookGuid, 'transaction', eventKey, 1, { success: true }, tx,
      );
    });
    await fenceHeldPromise;

    let contenderSettled = false;
    const contender = idempotency.claimWebhookIdempotency(
      bookGuid, 'transaction', eventKey, secondPrisma,
    ).finally(() => { contenderSettled = true; });
    await sleep(100);
    expect(contenderSettled).toBe(false);

    allowCommit();
    await owner;
    await expect(contender).resolves.toEqual({ status: 'replay', result: { success: true } });
  });

  it('rolls back a fenced ledger write and leaves the claim reclaimable', async () => {
    const eventKey = key('rollback');
    const txGuid = crypto.randomUUID().replaceAll('-', '');
    const splitGuid = crypto.randomUUID().replaceAll('-', '');
    const prisma = prismaModule.default;
    expect(await idempotency.claimWebhookIdempotency(bookGuid, 'transaction', eventKey))
      .toEqual({ status: 'claimed', attempt: 1 });
    const account = { account_guid: postingAccountGuid, currency_guid: currencyGuid };

    await expect(prisma.$transaction(async (database) => {
      await idempotency.lockWebhookIdempotencyAttempt(bookGuid, 'transaction', eventKey, 1, database);
      await database.$executeRaw`
        INSERT INTO transactions (guid, currency_guid, num, post_date, enter_date, description)
        VALUES (${txGuid}, ${account.currency_guid}, '', NOW(), NOW(), 'idempotency rollback test')
      `;
      await database.$executeRaw`
        INSERT INTO splits
          (guid, tx_guid, account_guid, memo, action, reconcile_state, reconcile_date,
           value_num, value_denom, quantity_num, quantity_denom, lot_guid)
        VALUES
          (${splitGuid}, ${txGuid}, ${account.account_guid}, '', '', 'n', NULL,
           1, 1, 1, 1, NULL)
      `;
      throw new Error('intentional rollback');
    })).rejects.toThrow('intentional rollback');

    const writes = await prisma.$queryRaw<Array<{ transactions: bigint; splits: bigint }>>`
      SELECT
        (SELECT COUNT(*)::bigint FROM transactions WHERE guid = ${txGuid}) AS transactions,
        (SELECT COUNT(*)::bigint FROM splits WHERE tx_guid = ${txGuid}) AS splits
    `;
    expect(writes).toEqual([{ transactions: 0n, splits: 0n }]);

    await prisma.$executeRaw`
      UPDATE gnucash_web_webhook_idempotency
      SET claim_started_at = CURRENT_TIMESTAMP - INTERVAL '6 minutes'
      WHERE book_guid = ${bookGuid} AND endpoint = 'transaction' AND idempotency_key = ${eventKey}
    `;
    await expect(idempotency.claimWebhookIdempotency(bookGuid, 'transaction', eventKey, secondPrisma))
      .resolves.toEqual({ status: 'claimed', attempt: 2 });
  });
});

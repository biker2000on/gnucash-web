import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

type IdempotencyModule = typeof import('../webhook-idempotency');
type PrismaModule = typeof import('../prisma');

const testEnv = loadEnv({
  path: resolve(process.cwd(), '../../.env.test.local'),
  override: true,
  quiet: true,
});

if (testEnv.error || !process.env.TEST_DATABASE_URL) {
  throw new Error('webhook idempotency integration tests require ../../.env.test.local TEST_DATABASE_URL');
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

let idempotency: IdempotencyModule;
let prismaModule: PrismaModule;
const bookGuid = 'f'.repeat(32);
const testKeys: string[] = [];

class RollbackForTest extends Error {}

beforeAll(async () => {
  idempotency = await import('../webhook-idempotency');
  prismaModule = await import('../prisma');
  await idempotency.ensureWebhookIdempotencyTable();
});

afterAll(async () => {
  const prisma = prismaModule.default;
  const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::bigint AS count
    FROM gnucash_web_webhook_idempotency
    WHERE book_guid = ${bookGuid} AND idempotency_key = ANY(${testKeys}::text[])
  `;
  expect(rows[0]?.count ?? 0n).toBe(0n);
  await prisma.$disconnect();
});

function key(suffix: string): string {
  const value = `integration-${suffix}-${crypto.randomUUID()}`;
  testKeys.push(value);
  return value;
}

describe('webhook idempotency against PostgreSQL', () => {
  it('does not reclaim a completed row at any age', async () => {
    const eventKey = key('completed');
    const prisma = prismaModule.default;
    await expect(prisma.$transaction(async (tx) => {
      const initial = await idempotency.claimWebhookIdempotency(
        bookGuid, 'transaction', eventKey, tx
      );
      expect(initial).toEqual({ status: 'claimed', attempt: 1 });
      expect(await idempotency.completeWebhookIdempotency(
        bookGuid, 'transaction', eventKey, 1, { success: true }, tx
      )).toBe(true);
      await tx.$executeRaw`
        UPDATE gnucash_web_webhook_idempotency
        SET claim_started_at = NOW() - INTERVAL '1 day'
        WHERE book_guid = ${bookGuid} AND endpoint = 'transaction' AND idempotency_key = ${eventKey}
      `;
      await expect(idempotency.claimWebhookIdempotency(
        bookGuid, 'transaction', eventKey, tx
      )).resolves.toEqual({ status: 'replay', result: { success: true } });
      throw new RollbackForTest();
    })).rejects.toBeInstanceOf(RollbackForTest);
  });

  it('reclaims a stale processing row and increments its attempt in PostgreSQL', async () => {
    const eventKey = key('stale');
    const prisma = prismaModule.default;
    await expect(prisma.$transaction(async (tx) => {
      await idempotency.claimWebhookIdempotency(bookGuid, 'transaction', eventKey, tx);
      await tx.$executeRaw`
        UPDATE gnucash_web_webhook_idempotency
        SET claim_started_at = NOW() - INTERVAL '6 minutes'
        WHERE book_guid = ${bookGuid} AND endpoint = 'transaction' AND idempotency_key = ${eventKey}
      `;
      await expect(idempotency.claimWebhookIdempotency(
        bookGuid, 'transaction', eventKey, tx
      )).resolves.toEqual({ status: 'claimed', attempt: 2 });
      const rows = await tx.$queryRaw<Array<{ attempts: number }>>`
        SELECT attempts FROM gnucash_web_webhook_idempotency
        WHERE book_guid = ${bookGuid} AND endpoint = 'transaction' AND idempotency_key = ${eventKey}
      `;
      expect(rows).toEqual([{ attempts: 2 }]);
      throw new RollbackForTest();
    })).rejects.toBeInstanceOf(RollbackForTest);
  });

  it('fences an older completion after a newer attempt has reclaimed the row', async () => {
    const eventKey = key('fenced');
    const prisma = prismaModule.default;
    await expect(prisma.$transaction(async (tx) => {
      await idempotency.claimWebhookIdempotency(bookGuid, 'transaction', eventKey, tx);
      await tx.$executeRaw`
        UPDATE gnucash_web_webhook_idempotency
        SET claim_started_at = NOW() - INTERVAL '6 minutes'
        WHERE book_guid = ${bookGuid} AND endpoint = 'transaction' AND idempotency_key = ${eventKey}
      `;
      await idempotency.claimWebhookIdempotency(bookGuid, 'transaction', eventKey, tx);
      await expect(idempotency.completeWebhookIdempotency(
        bookGuid, 'transaction', eventKey, 1, { success: true }, tx
      )).resolves.toBe(false);
      const rows = await tx.$queryRaw<Array<{ result: unknown; attempts: number }>>`
        SELECT result, attempts FROM gnucash_web_webhook_idempotency
        WHERE book_guid = ${bookGuid} AND endpoint = 'transaction' AND idempotency_key = ${eventKey}
      `;
      expect(rows).toEqual([{ result: null, attempts: 2 }]);
      throw new RollbackForTest();
    })).rejects.toBeInstanceOf(RollbackForTest);
  });
});

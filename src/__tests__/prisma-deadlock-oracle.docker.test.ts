// @vitest-environment node

/**
 * A self-contained integration proof for the Prisma branch of isDeadlock.
 *
 * This deliberately is not named *.integration.test.ts: that tier is pointed
 * at TEST_DATABASE_URL before its setup runs, whereas this proof must create
 * and remove its own PostgreSQL instance. Run it with the ordinary unit suite
 * (or directly with `npx vitest run src/__tests__/prisma-deadlock-oracle.docker.test.ts`)
 * on a machine where `docker --context default` is available.
 *
 * The test creates a private container, seeds a private table, creates a real
 * advisory-lock cycle through two real Prisma + @prisma/adapter-pg clients,
 * and gives the actual rejected error object to isDeadlock. The table is
 * dropped and the --rm container is forcibly removed in afterAll even when an
 * assertion fails.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { PrismaClient } from '@prisma/client';
import { isDeadlock } from './integration/deadlock';

const execFileAsync = promisify(execFile);
const containerName = `gnucash-prisma-deadlock-${randomUUID().slice(0, 8)}`;
const databaseName = 'oracle_proof';
const databaseUser = 'oracle';
const databasePassword = randomUUID();

let databaseUrl: string;
let fixturePool: Pool;
let firstPrisma: PrismaClient;
let secondPrisma: PrismaClient;
let firstPool: Pool;
let secondPool: Pool;

async function docker(...args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('docker', ['--context', 'default', ...args]);
    return stdout;
}

async function waitForDatabase(url: string): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 240; attempt += 1) {
        const pool = new Pool({ connectionString: url, max: 1 });
        try {
            await pool.query('SELECT 1');
            await pool.end();
            return;
        } catch (error) {
            lastError = error;
            await pool.end().catch(() => undefined);
            await new Promise(resolve => setTimeout(resolve, 250));
        }
    }
    throw lastError instanceof Error ? lastError : new Error('PostgreSQL did not become ready');
}

async function waitUntil(predicate: () => Promise<boolean>, description: string): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if (await predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for ${description}`);
}

describe('Prisma deadlock oracle against a disposable PostgreSQL container', () => {
    beforeAll(async () => {
        await docker(
            'run', '--detach', '--rm', '--name', containerName,
            // Let Docker choose an unused host port, but bind it to loopback
            // so the disposable server is not exposed beyond this machine.
            '--publish', '127.0.0.1:0:5432',
            '--env', `POSTGRES_DB=${databaseName}`,
            '--env', `POSTGRES_USER=${databaseUser}`,
            '--env', `POSTGRES_PASSWORD=${databasePassword}`,
            'postgres:16-alpine',
        );
        const portOutput = await docker('port', containerName, '5432/tcp');
        const port = portOutput.match(/:(\d+)\s*$/m)?.[1];
        if (!port) throw new Error(`Could not determine disposable PostgreSQL port: ${portOutput}`);
        databaseUrl = `postgresql://${databaseUser}:${databasePassword}@127.0.0.1:${port}/${databaseName}`;
        await waitForDatabase(databaseUrl);

        fixturePool = new Pool({ connectionString: databaseUrl, max: 2 });
        await fixturePool.query('CREATE TABLE oracle_fixture (id integer PRIMARY KEY, note text NOT NULL)');
        await fixturePool.query("INSERT INTO oracle_fixture (id, note) VALUES (1, 'self-contained Prisma oracle proof')");

        firstPool = new Pool({ connectionString: databaseUrl, max: 1 });
        secondPool = new Pool({ connectionString: databaseUrl, max: 1 });
        // Keep Prisma's generated runtime out of Vitest's test-discovery path.
        // The proof needs the real client only after its disposable server is
        // accepting connections.
        const [{ PrismaClient }, { PrismaPg }] = await Promise.all([
            import('@prisma/client'),
            import('@prisma/adapter-pg'),
        ]);
        firstPrisma = new PrismaClient({ adapter: new PrismaPg(firstPool) });
        secondPrisma = new PrismaClient({ adapter: new PrismaPg(secondPool) });
    }, 60_000);

    afterAll(async () => {
        await firstPrisma?.$disconnect().catch(() => undefined);
        await secondPrisma?.$disconnect().catch(() => undefined);
        await firstPool?.end().catch(() => undefined);
        await secondPool?.end().catch(() => undefined);
        if (fixturePool) {
            await fixturePool.query('DROP TABLE IF EXISTS oracle_fixture').catch(() => undefined);
            await fixturePool.end().catch(() => undefined);
        }
        await docker('rm', '--force', containerName).catch(() => undefined);
    }, 30_000);

    it('recognises the genuine Prisma error PostgreSQL returns for a deadlock', async () => {
        let firstPid = 0;
        let secondPid = 0;
        let firstHasLock!: () => void;
        let secondHasLock!: () => void;
        let letFirstRequestSecond!: () => void;
        const firstHasLockPromise = new Promise<void>(resolve => { firstHasLock = resolve; });
        const secondHasLockPromise = new Promise<void>(resolve => { secondHasLock = resolve; });
        const letFirstRequestSecondPromise = new Promise<void>(resolve => { letFirstRequestSecond = resolve; });

        const first = firstPrisma.$transaction(async tx => {
            const rows = await tx.$queryRawUnsafe<Array<{ pid: number }>>('SELECT pg_backend_pid() AS pid');
            firstPid = rows[0]!.pid;
            await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(71001)');
            firstHasLock();
            await letFirstRequestSecondPromise;
            await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(71002)');
        }, { timeout: 15_000, maxWait: 5_000 });
        first.catch(() => undefined);
        await firstHasLockPromise;

        const second = secondPrisma.$transaction(async tx => {
            const rows = await tx.$queryRawUnsafe<Array<{ pid: number }>>('SELECT pg_backend_pid() AS pid');
            secondPid = rows[0]!.pid;
            await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(71002)');
            secondHasLock();
            await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(71001)');
        }, { timeout: 15_000, maxWait: 5_000 });
        second.catch(() => undefined);
        await secondHasLockPromise;

        try {
            await waitUntil(async () => {
                const result = await fixturePool.query<{ blocked: boolean }>(
                    'SELECT $1::integer = ANY(pg_blocking_pids($2::integer)) AS blocked', [firstPid, secondPid],
                );
                return result.rows[0]?.blocked === true;
            }, 'the second Prisma transaction to block on the first advisory lock');
        } finally {
            // Do not strand the first interactive transaction if the
            // observation assertion above fails; its timeout would otherwise
            // obscure the actual failure and delay container cleanup.
            letFirstRequestSecond();
        }
        const settled = await Promise.allSettled([first, second]);
        const errors = settled
            .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
            .map(result => result.reason);

        expect(errors).toHaveLength(1);
        expect(isDeadlock(errors[0])).toBe(true);
    }, 30_000);
});

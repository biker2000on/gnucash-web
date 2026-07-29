import { createHash } from 'node:crypto';
import prisma from '@/lib/prisma';
import type {
  CalculationStep,
  CalculationTrace,
  EvidenceRef,
} from '@/lib/financial-actions/types';
import { CALCULATION_TRACES_SCHEMA_SQL } from '@/lib/financial-actions/schema';

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

export function stableTraceId(namespace: string, identity: unknown): string {
  const digest = createHash('sha256')
    .update(`${namespace}:${JSON.stringify(stableValue(identity))}`)
    .digest('hex')
    .slice(0, 32);
  return `trace_${digest}`;
}

export function createCalculationTrace(input: {
  namespace: string;
  identity: unknown;
  title: string;
  summary: string;
  asOfDate?: string;
  formula?: string;
  result: CalculationTrace['result'];
  unit?: CalculationTrace['unit'];
  range?: CalculationTrace['range'];
  steps?: CalculationStep[];
  evidence?: EvidenceRef[];
  assumptions?: string[];
  warnings?: string[];
  metadata?: Record<string, unknown>;
}): CalculationTrace {
  const generatedAt = new Date().toISOString();
  return {
    id: stableTraceId(input.namespace, input.identity),
    version: 1,
    title: input.title,
    summary: input.summary,
    generatedAt,
    asOfDate: input.asOfDate ?? generatedAt.slice(0, 10),
    formula: input.formula,
    result: input.result,
    unit: input.unit,
    range: input.range,
    steps: input.steps ?? [],
    evidence: input.evidence ?? [],
    assumptions: input.assumptions ?? [],
    warnings: input.warnings ?? [],
    metadata: input.metadata,
  };
}

let ensurePromise: Promise<void> | null = null;
export const MAX_TRACES_PER_BOOK = 1_000;

export function ensureProvenanceTable(): Promise<void> {
  if (!ensurePromise) {
    ensurePromise = prisma.$executeRawUnsafe(`
      DO $$
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtext('gnucash_web_calculation_traces_schema'));
        ${CALCULATION_TRACES_SCHEMA_SQL}
      END $$;
    `).then(() => undefined);
  }
  return ensurePromise;
}

export async function persistCalculationTrace(
  userId: number,
  bookGuid: string,
  trace: CalculationTrace,
): Promise<void> {
  await persistCalculationTraces(userId, bookGuid, [trace]);
}

export async function persistCalculationTraces(
  userId: number,
  bookGuid: string,
  traces: CalculationTrace[],
): Promise<void> {
  await ensureProvenanceTable();
  await Promise.all(traces.map(trace => prisma.$executeRaw`
    INSERT INTO gnucash_web_calculation_traces
      (trace_id, user_id, book_guid, title, trace)
    VALUES
      (${trace.id}, ${userId}, ${bookGuid}, ${trace.title}, ${JSON.stringify(trace)}::jsonb)
    ON CONFLICT (trace_id, user_id, book_guid)
    DO UPDATE SET
      title = EXCLUDED.title,
      trace = EXCLUDED.trace,
      last_generated_at = NOW()
  `));
  await pruneCalculationTraces(userId, bookGuid);
}

async function pruneCalculationTraces(userId: number, bookGuid: string): Promise<void> {
  await prisma.$executeRaw`
    DELETE FROM gnucash_web_calculation_traces
    WHERE user_id = ${userId}
      AND book_guid = ${bookGuid}
      AND trace_id IN (
        SELECT trace_id
        FROM gnucash_web_calculation_traces
        WHERE user_id = ${userId}
          AND book_guid = ${bookGuid}
        ORDER BY last_generated_at DESC
        OFFSET ${MAX_TRACES_PER_BOOK}
      )
  `;
}

export async function getCalculationTrace(
  userId: number,
  bookGuid: string,
  traceId: string,
): Promise<CalculationTrace | null> {
  await ensureProvenanceTable();
  const rows = await prisma.$queryRaw<Array<{ trace: CalculationTrace }>>`
    SELECT trace
    FROM gnucash_web_calculation_traces
    WHERE trace_id = ${traceId}
      AND user_id = ${userId}
      AND book_guid = ${bookGuid}
    LIMIT 1
  `;
  return rows[0]?.trace ?? null;
}

export async function listCalculationTraces(
  userId: number,
  bookGuid: string,
): Promise<CalculationTrace[]> {
  await ensureProvenanceTable();
  const rows = await prisma.$queryRaw<Array<{ trace: CalculationTrace }>>`
    SELECT trace
    FROM gnucash_web_calculation_traces
    WHERE user_id = ${userId}
      AND book_guid = ${bookGuid}
    ORDER BY last_generated_at DESC
    LIMIT ${MAX_TRACES_PER_BOOK}
  `;
  return rows.map(row => row.trace);
}

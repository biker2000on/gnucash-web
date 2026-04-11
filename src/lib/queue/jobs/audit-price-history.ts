import { Job } from 'bullmq';

export async function handleAuditPriceHistory(job: Job): Promise<void> {
  const { symbols } = job.data as { symbols?: string[] };

  console.log(`[Job ${job.id}] Starting price audit${symbols?.length ? ` for ${symbols.join(', ')}` : ''}...`);

  // Diagnostic: a previous run reported "0 commodities" even though the
  // DB has 10 rows matching the filter. Log both the Prisma-ORM count and
  // a raw SQL count so any mismatch shows up in the worker logs.
  try {
    const { default: prisma } = await import('@/lib/prisma');
    const ormCount = await prisma.commodities.count({
      where: { quote_flag: 1, NOT: { namespace: 'CURRENCY' } },
    });
    const rawCount = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS count FROM commodities
      WHERE quote_flag = 1 AND namespace <> 'CURRENCY'
    `;
    console.log(
      `[Job ${job.id}] Quotable commodities — ORM=${ormCount}, raw=${rawCount[0]?.count ?? 'n/a'}`
    );
  } catch (e) {
    console.error(`[Job ${job.id}] Diagnostic query failed:`, e instanceof Error ? e.message : e);
  }

  const { auditAndBackfillPrices } = await import('@/lib/yahoo-price-service');
  const result = await auditAndBackfillPrices(symbols);

  console.log(
    `[Job ${job.id}] Price audit complete: ${result.stored} prices stored across ${result.audited} commodities, ${result.failed} failed`
  );
}

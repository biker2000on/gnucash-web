import prisma from './prisma';

let cachedEarliestDate: Date | null = null;
let cachedAt: number = 0;
let cachedBookKey: string | null = null;
const CACHE_TTL_MS = 60_000; // 60 seconds

export async function getEffectiveStartDate(
  startDateParam: string | null,
  bookAccountGuids?: string[]
): Promise<Date> {
  if (startDateParam) {
    const parsed = new Date(startDateParam);
    if (isNaN(parsed.getTime())) {
      return new Date('2000-01-01T00:00:00Z'); // fallback for invalid date
    }
    return parsed;
  }

  // Cache key based on book scope
  const bookKey = bookAccountGuids ? bookAccountGuids.slice(0, 3).join(',') : '__all__';
  const now = Date.now();
  if (cachedEarliestDate && (now - cachedAt) < CACHE_TTL_MS && cachedBookKey === bookKey) {
    return cachedEarliestDate;
  }

  if (bookAccountGuids && bookAccountGuids.length > 0) {
    // Find earliest transaction that has splits in the active book's accounts
    const result = await prisma.$queryRaw<{ post_date: Date | null }[]>`
      SELECT MIN(t.post_date) as post_date
      FROM transactions t
      INNER JOIN splits s ON s.tx_guid = t.guid
      WHERE t.post_date IS NOT NULL
        AND s.account_guid = ANY(${bookAccountGuids})
    `;
    cachedEarliestDate = result[0]?.post_date || new Date('2000-01-01T00:00:00Z');
  } else {
    const earliest = await prisma.transactions.findFirst({
      orderBy: { post_date: 'asc' },
      where: { post_date: { not: null } },
      select: { post_date: true },
    });
    cachedEarliestDate = earliest?.post_date || new Date('2000-01-01T00:00:00Z');
  }

  cachedAt = now;
  cachedBookKey = bookKey;
  return cachedEarliestDate;
}

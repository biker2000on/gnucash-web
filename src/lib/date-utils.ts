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

  const earliest = await prisma.transactions.findFirst({
    where: {
      post_date: { not: null },
      ...(bookAccountGuids && bookAccountGuids.length > 0
        ? { splits: { some: { account_guid: { in: bookAccountGuids } } } }
        : {}),
    },
    orderBy: { post_date: 'asc' },
    select: { post_date: true },
  });
  cachedEarliestDate = earliest?.post_date || new Date('2000-01-01T00:00:00Z');

  cachedAt = now;
  cachedBookKey = bookKey;
  return cachedEarliestDate;
}

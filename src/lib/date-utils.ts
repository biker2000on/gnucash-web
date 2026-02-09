import prisma from './prisma';

let cachedEarliestDate: Date | null = null;
let cachedAt: number = 0;
const CACHE_TTL_MS = 60_000; // 60 seconds

export async function getEffectiveStartDate(startDateParam: string | null): Promise<Date> {
  if (startDateParam) {
    const parsed = new Date(startDateParam);
    if (isNaN(parsed.getTime())) {
      return new Date(2000, 0, 1); // fallback for invalid date
    }
    return parsed;
  }

  const now = Date.now();
  if (cachedEarliestDate && (now - cachedAt) < CACHE_TTL_MS) {
    return cachedEarliestDate;
  }

  const earliest = await prisma.transactions.findFirst({
    orderBy: { post_date: 'asc' },
    where: { post_date: { not: null } },
    select: { post_date: true },
  });
  cachedEarliestDate = earliest?.post_date || new Date(2000, 0, 1);
  cachedAt = now;
  return cachedEarliestDate;
}

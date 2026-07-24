import { Prisma } from '@prisma/client';
import prisma from '@/lib/prisma';
import { getAccountGuidsForBook } from '@/lib/book-scope';
import { findExchangeRate, getBaseCurrencyForBook, type Currency } from '@/lib/currency';
import { getUserBooks, roleAtLeast } from '@/lib/services/permission.service';
import { FinancialSummaryService, type FinancialSummary } from '@/lib/services/financial-summary.service';
import { getMoneyTimeline } from '@/lib/money-timeline/service';
import type { FinancialEvent, TimelineConflict } from '@/lib/money-timeline/types';

export interface FamilyOfficeEntity {
  bookGuid: string;
  name: string;
  entityType: string;
  entityName: string | null;
  role: string;
  reportingCurrency: string;
}

export interface FamilyOfficeRelationship {
  fromBookGuid: string;
  toBookGuid: string;
  type: string;
  ownershipPercent: number;
}

export interface FamilyOfficeGraph {
  rootBookGuid: string;
  entities: FamilyOfficeEntity[];
  relationships: FamilyOfficeRelationship[];
}

export interface ConsolidatedEntitySummary {
  entity: FamilyOfficeEntity;
  ownershipPercent: number;
  included: boolean;
  exclusionReason: string | null;
  summary: FinancialSummary | null;
  ownedSummary: FinancialSummary | null;
  liquidity: number | null;
  ownedLiquidity: number | null;
}

export interface FamilyOfficeSummary {
  generatedAt: string;
  reportingCurrency: string;
  graph: FamilyOfficeGraph;
  entities: ConsolidatedEntitySummary[];
  consolidated: {
    netWorth: number;
    totalIncome: number;
    totalExpenses: number;
    cashFlow: number;
    investmentValue: number;
    liquidity: number;
  };
  warnings: string[];
}

async function loadBookLiquidity(bookGuid: string, asOf: Date): Promise<number> {
  const accountGuids = await getAccountGuidsForBook(bookGuid);
  if (accountGuids.length === 0) return 0;
  const rows = await prisma.$queryRaw<Array<{ balance: unknown }>>`
    SELECT COALESCE(SUM(CAST(s.quantity_num AS numeric) / NULLIF(s.quantity_denom, 0)), 0) AS balance
    FROM splits s
    JOIN accounts a ON a.guid = s.account_guid
    JOIN transactions t ON t.guid = s.tx_guid
    WHERE s.account_guid IN (${Prisma.join(accountGuids)})
      AND a.account_type IN ('BANK', 'CASH')
      AND t.post_date <= ${asOf}
  `;
  const amount = Number(rows[0]?.balance ?? 0);
  return Number.isFinite(amount) ? amount : 0;
}

export interface FamilyLinkInput {
  businessBookGuid: string;
  householdBookGuid: string;
}

/**
 * Pure permission boundary used before graph expansion. Links never introduce
 * a book that is absent from the caller's authorized set.
 */
export function resolveConnectedBookGuids(
  activeBookGuid: string,
  authorizedBookGuids: Iterable<string>,
  links: FamilyLinkInput[],
): Set<string> {
  const authorized = new Set(authorizedBookGuids);
  if (!authorized.has(activeBookGuid)) return new Set();
  const touching = new Map<string, FamilyLinkInput[]>();
  for (const link of links) {
    if (!authorized.has(link.businessBookGuid) || !authorized.has(link.householdBookGuid)) continue;
    for (const guid of [link.businessBookGuid, link.householdBookGuid]) {
      const list = touching.get(guid) ?? [];
      list.push(link);
      touching.set(guid, list);
    }
  }
  const connected = new Set<string>([activeBookGuid]);
  const queue = [activeBookGuid];
  while (queue.length > 0) {
    const guid = queue.shift()!;
    for (const link of touching.get(guid) ?? []) {
      for (const endpoint of [link.businessBookGuid, link.householdBookGuid]) {
        if (connected.has(endpoint)) continue;
        connected.add(endpoint);
        queue.push(endpoint);
      }
    }
  }
  return connected;
}

export interface TransferCandidate {
  id: string;
  leftBookGuid: string;
  leftBookName: string;
  leftTransactionGuid: string;
  leftDate: string;
  leftDescription: string;
  rightBookGuid: string;
  rightBookName: string;
  rightTransactionGuid: string;
  rightDate: string;
  rightDescription: string;
  amount: number;
  currency: string;
  dayDifference: number;
  confidence: number;
  approved: boolean;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

async function currencyForBook(bookGuid: string): Promise<Currency> {
  return (await getBaseCurrencyForBook(bookGuid)) ?? {
    guid: '',
    mnemonic: 'UNKNOWN',
    fullname: null,
    fraction: 100,
  };
}

/**
 * Resolve only relationships whose two endpoints are already authorized for
 * the caller. The graph never grants access; it can only reduce an existing
 * permission set.
 */
export async function getAuthorizedFamilyGraph(
  userId: number,
  activeBookGuid: string,
): Promise<FamilyOfficeGraph> {
  const userBooks = await getUserBooks(userId);
  const authorized = new Map(
    userBooks
      .filter(book => roleAtLeast(book.role, 'readonly'))
      .map(book => [book.guid, book]),
  );
  if (!authorized.has(activeBookGuid)) {
    return { rootBookGuid: activeBookGuid, entities: [], relationships: [] };
  }
  type LinkRow = {
    business_book_guid: string;
    household_book_guid: string;
    ownership_percent: unknown;
    relationship_type: string;
  };
  const links = await prisma.$queryRaw<LinkRow[]>`
    SELECT business_book_guid, household_book_guid, ownership_percent,
           COALESCE(relationship_type, 'owned_business') AS relationship_type
    FROM gnucash_web_book_links
    WHERE business_book_guid IN (${Prisma.join([...authorized.keys()])})
      AND household_book_guid IN (${Prisma.join([...authorized.keys()])})
  `;
  const connected = resolveConnectedBookGuids(
    activeBookGuid,
    authorized.keys(),
    links.map(link => ({
      businessBookGuid: link.business_book_guid,
      householdBookGuid: link.household_book_guid,
    })),
  );

  let rootBookGuid = activeBookGuid;
  const visitedRoots = new Set<string>();
  while (!visitedRoots.has(rootBookGuid)) {
    visitedRoots.add(rootBookGuid);
    const parent = links.find(link => link.business_book_guid === rootBookGuid)?.household_book_guid;
    if (!parent || !connected.has(parent)) break;
    rootBookGuid = parent;
  }
  const guids = [...connected];
  const [profiles, currencies] = await Promise.all([
    prisma.gnucash_web_entity_profiles.findMany({ where: { book_guid: { in: guids } } }),
    Promise.all(guids.map(async guid => [guid, await currencyForBook(guid)] as const)),
  ]);
  const profileOf = new Map(profiles.map(profile => [profile.book_guid, profile]));
  const currencyOf = new Map(currencies);

  const entities = guids.map(guid => {
    const book = authorized.get(guid)!;
    const profile = profileOf.get(guid);
    return {
      bookGuid: guid,
      name: book.name,
      entityType: profile?.entity_type ?? 'household',
      entityName: profile?.entity_name ?? null,
      role: book.role,
      reportingCurrency: currencyOf.get(guid)?.mnemonic ?? 'UNKNOWN',
    };
  }).sort((a, b) => a.bookGuid === rootBookGuid ? -1 : b.bookGuid === rootBookGuid ? 1 : a.name.localeCompare(b.name));

  return {
    rootBookGuid,
    entities,
    relationships: links
      .filter(link => connected.has(link.business_book_guid) && connected.has(link.household_book_guid))
      .map(link => ({
        fromBookGuid: link.household_book_guid,
        toBookGuid: link.business_book_guid,
        type: link.relationship_type,
        ownershipPercent: Number(link.ownership_percent),
      })),
  };
}

function scaleSummary(summary: FinancialSummary, percent: number): FinancialSummary {
  const scale = percent / 100;
  return {
    ...summary,
    netWorth: round2(summary.netWorth * scale),
    netWorthChange: round2(summary.netWorthChange * scale),
    totalIncome: round2(summary.totalIncome * scale),
    totalExpenses: round2(summary.totalExpenses * scale),
    topExpenseAmount: round2(summary.topExpenseAmount * scale),
    investmentValue: round2(summary.investmentValue * scale),
  };
}

export function ownershipByBook(graph: FamilyOfficeGraph): Map<string, number> {
  const ownership = new Map<string, number>([[graph.rootBookGuid, 100]]);
  for (let pass = 0; pass < graph.entities.length; pass++) {
    let changed = false;
    for (const relationship of graph.relationships) {
      const parent = ownership.get(relationship.fromBookGuid);
      if (parent === undefined) continue;
      const candidate = parent * relationship.ownershipPercent / 100;
      if (candidate > (ownership.get(relationship.toBookGuid) ?? -1)) {
        ownership.set(relationship.toBookGuid, candidate);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return ownership;
}

export async function getFamilyOfficeSummary(
  userId: number,
  activeBookGuid: string,
  now: Date = new Date(),
): Promise<FamilyOfficeSummary> {
  const graph = await getAuthorizedFamilyGraph(userId, activeBookGuid);
  const reporting = await getBaseCurrencyForBook(graph.rootBookGuid);
  const reportingCurrency = reporting?.mnemonic ?? 'UNKNOWN';
  const ownership = ownershipByBook(graph);
  const start = new Date(now);
  start.setUTCFullYear(start.getUTCFullYear() - 1);
  const warnings: string[] = [];
  const rows: ConsolidatedEntitySummary[] = [];

  for (const entity of graph.entities) {
    const entityOwnership = ownership.get(entity.bookGuid) ?? 0;
    const sourceCurrency = await currencyForBook(entity.bookGuid);
    if (!reporting || !sourceCurrency.guid) {
      const reason = !reporting
        ? 'The family graph root has no reporting currency.'
        : `${entity.name} has no valid book currency.`;
      warnings.push(`${entity.name} excluded: ${reason}`);
      rows.push({
        entity,
        ownershipPercent: entityOwnership,
        included: false,
        exclusionReason: reason,
        summary: null,
        ownedSummary: null,
        liquidity: null,
        ownedLiquidity: null,
      });
      continue;
    }
    const exchange = reporting
      && sourceCurrency.guid !== reporting.guid
      ? await findExchangeRate(sourceCurrency.guid, reporting.guid, now)
      : null;
    if (sourceCurrency.guid !== reporting.guid && !exchange) {
      const reason = `No ${sourceCurrency.mnemonic}/${reportingCurrency} rate is available as of ${now.toISOString().slice(0, 10)}.`;
      warnings.push(`${entity.name} excluded: ${reason}`);
      rows.push({
        entity,
        ownershipPercent: entityOwnership,
        included: false,
        exclusionReason: reason,
        summary: null,
        ownedSummary: null,
        liquidity: null,
        ownedLiquidity: null,
      });
      continue;
    }
    const accountGuids = await getAccountGuidsForBook(entity.bookGuid);
    const sourceSummary = await FinancialSummaryService.computeFullSummary(
      accountGuids,
      start,
      now,
      sourceCurrency,
    );
    const rate = exchange?.rate ?? 1;
    const summary = scaleSummary(sourceSummary, rate * 100);
    const liquidity = round2((await loadBookLiquidity(entity.bookGuid, now)) * rate);
    rows.push({
      entity,
      ownershipPercent: entityOwnership,
      included: true,
      exclusionReason: null,
      summary,
      ownedSummary: scaleSummary(summary, entityOwnership),
      liquidity,
      ownedLiquidity: round2(liquidity * entityOwnership / 100),
    });
  }

  const consolidated = rows.reduce((total, row) => {
    if (!row.ownedSummary) return total;
    total.netWorth += row.ownedSummary.netWorth;
    total.totalIncome += row.ownedSummary.totalIncome;
    total.totalExpenses += row.ownedSummary.totalExpenses;
    total.investmentValue += row.ownedSummary.investmentValue;
    total.liquidity += row.ownedLiquidity ?? 0;
    return total;
  }, { netWorth: 0, totalIncome: 0, totalExpenses: 0, investmentValue: 0, liquidity: 0 });
  return {
    generatedAt: now.toISOString(),
    reportingCurrency,
    graph,
    entities: rows,
    consolidated: {
      netWorth: round2(consolidated.netWorth),
      totalIncome: round2(consolidated.totalIncome),
      totalExpenses: round2(consolidated.totalExpenses),
      cashFlow: round2(consolidated.totalIncome - consolidated.totalExpenses),
      investmentValue: round2(consolidated.investmentValue),
      liquidity: round2(consolidated.liquidity),
    },
    warnings,
  };
}

type CashTransferRow = {
  book_guid: string;
  transaction_guid: string;
  currency_guid: string;
  post_date: Date;
  description: string | null;
  amount: unknown;
};

async function transferRows(graph: FamilyOfficeGraph): Promise<CashTransferRow[]> {
  const parts: CashTransferRow[] = [];
  for (const entity of graph.entities) {
    const accountGuids = await getAccountGuidsForBook(entity.bookGuid);
    if (accountGuids.length === 0) continue;
    const rows = await prisma.$queryRaw<Array<Omit<CashTransferRow, 'book_guid'>>>`
      SELECT t.guid AS transaction_guid, t.currency_guid, t.post_date,
             COALESCE(t.description, '') AS description,
             SUM(CAST(s.value_num AS numeric) / NULLIF(s.value_denom, 0)) AS amount
      FROM transactions t
      JOIN splits s ON s.tx_guid = t.guid
      JOIN accounts a ON a.guid = s.account_guid
      WHERE s.account_guid IN (${Prisma.join(accountGuids)})
        AND a.account_type IN ('BANK', 'CASH')
        AND t.post_date IS NOT NULL
      GROUP BY t.guid, t.currency_guid, t.post_date, t.description
      HAVING ABS(SUM(CAST(s.value_num AS numeric) / NULLIF(s.value_denom, 0))) > 0.009
      ORDER BY t.post_date DESC
      LIMIT 1000
    `;
    parts.push(...rows.map(row => ({ ...row, book_guid: entity.bookGuid })));
  }
  return parts;
}

function dateDays(a: Date, b: Date): number {
  return Math.abs(Math.round((a.getTime() - b.getTime()) / 86_400_000));
}

export async function findInterbookTransferCandidates(
  userId: number,
  activeBookGuid: string,
): Promise<TransferCandidate[]> {
  const graph = await getAuthorizedFamilyGraph(userId, activeBookGuid);
  if (graph.entities.length < 2) return [];
  const [rows, approvedRows] = await Promise.all([
    transferRows(graph),
    prisma.$queryRaw<Array<{ left_transaction_guid: string; right_transaction_guid: string }>>`
      SELECT left_transaction_guid, right_transaction_guid
      FROM gnucash_web_interbook_eliminations
      WHERE user_id = ${userId} AND household_book_guid = ${graph.rootBookGuid}
        AND status = 'approved'
    `,
  ]);
  const approved = new Set(approvedRows.flatMap(row => [
    `${row.left_transaction_guid}:${row.right_transaction_guid}`,
    `${row.right_transaction_guid}:${row.left_transaction_guid}`,
  ]));
  const nameOf = new Map(graph.entities.map(entity => [entity.bookGuid, entity.name]));
  const currencyRows = await prisma.commodities.findMany({
    where: { guid: { in: [...new Set(rows.map(row => row.currency_guid))] } },
    select: { guid: true, mnemonic: true },
  });
  const currencyOf = new Map(currencyRows.map(row => [row.guid, row.mnemonic]));
  const candidates: TransferCandidate[] = [];
  const used = new Set<string>();

  for (let i = 0; i < rows.length; i++) {
    const left = rows[i];
    const leftAmount = Number(left.amount);
    if (!Number.isFinite(leftAmount)) continue;
    for (let j = i + 1; j < rows.length; j++) {
      const right = rows[j];
      if (left.book_guid === right.book_guid) continue;
      if (left.currency_guid !== right.currency_guid) continue;
      const rightAmount = Number(right.amount);
      if (!Number.isFinite(rightAmount) || Math.abs(leftAmount + rightAmount) > 0.01) continue;
      const days = dateDays(left.post_date, right.post_date);
      if (days > 3) continue;
      const pair = `${left.transaction_guid}:${right.transaction_guid}`;
      if (used.has(left.transaction_guid) || used.has(right.transaction_guid)) continue;
      used.add(left.transaction_guid);
      used.add(right.transaction_guid);
      const descriptionMatch = (left.description ?? '').trim().toLowerCase() === (right.description ?? '').trim().toLowerCase();
      candidates.push({
        id: pair,
        leftBookGuid: left.book_guid,
        leftBookName: nameOf.get(left.book_guid) ?? left.book_guid,
        leftTransactionGuid: left.transaction_guid,
        leftDate: left.post_date.toISOString().slice(0, 10),
        leftDescription: left.description ?? '',
        rightBookGuid: right.book_guid,
        rightBookName: nameOf.get(right.book_guid) ?? right.book_guid,
        rightTransactionGuid: right.transaction_guid,
        rightDate: right.post_date.toISOString().slice(0, 10),
        rightDescription: right.description ?? '',
        amount: round2(Math.abs(leftAmount)),
        currency: currencyOf.get(left.currency_guid) ?? 'UNKNOWN',
        dayDifference: days,
        confidence: descriptionMatch ? 0.98 : days === 0 ? 0.92 : 0.8,
        approved: approved.has(pair),
      });
      break;
    }
  }
  return candidates.sort((a, b) => b.leftDate.localeCompare(a.leftDate));
}

export async function approveInterbookElimination(
  userId: number,
  activeBookGuid: string,
  candidateId: string,
): Promise<TransferCandidate> {
  const candidate = (await findInterbookTransferCandidates(userId, activeBookGuid))
    .find(item => item.id === candidateId);
  if (!candidate) throw new Error('Transfer candidate not found in the authorized family graph');
  const graph = await getAuthorizedFamilyGraph(userId, activeBookGuid);
  await prisma.$executeRaw`
    INSERT INTO gnucash_web_interbook_eliminations
      (user_id, household_book_guid, left_book_guid, left_transaction_guid,
       right_book_guid, right_transaction_guid, amount, currency, status)
    VALUES (
      ${userId}, ${graph.rootBookGuid}, ${candidate.leftBookGuid},
      ${candidate.leftTransactionGuid}, ${candidate.rightBookGuid},
      ${candidate.rightTransactionGuid}, ${candidate.amount}, ${candidate.currency}, 'approved'
    )
    ON CONFLICT (user_id, left_transaction_guid, right_transaction_guid)
    DO UPDATE SET status = 'approved', approved_at = NOW()
  `;
  return { ...candidate, approved: true };
}

export interface FamilyDocumentResult {
  id: string;
  bookGuid: string;
  bookName: string;
  kind: 'entity_document' | 'receipt';
  title: string;
  detail: string | null;
  date: string;
  href: string;
}

export async function searchFamilyDocuments(
  userId: number,
  activeBookGuid: string,
  query: string,
): Promise<FamilyDocumentResult[]> {
  const graph = await getAuthorizedFamilyGraph(userId, activeBookGuid);
  if (graph.entities.length === 0) return [];
  const guids = graph.entities.map(entity => entity.bookGuid);
  const needle = `%${query.trim().replace(/[%_]/g, '\\$&')}%`;
  type Row = { id: number; book_guid: string; title: string; detail: string | null; date: Date; kind: string };
  const rows = await prisma.$queryRaw<Row[]>`
    SELECT id, book_guid, title, detail, date, kind
    FROM (
      SELECT id, book_guid, title, COALESCE(notes, file_name) AS detail,
             uploaded_at AS date, 'entity_document' AS kind
      FROM gnucash_web_entity_documents
      WHERE book_guid IN (${Prisma.join(guids)})
        AND (${query.trim() === ''} OR title ILIKE ${needle} OR notes ILIKE ${needle} OR file_name ILIKE ${needle})
      UNION ALL
      SELECT id, book_guid, filename AS title, LEFT(ocr_text, 240) AS detail,
             created_at AS date, 'receipt' AS kind
      FROM gnucash_web_receipts
      WHERE book_guid IN (${Prisma.join(guids)})
        AND (${query.trim() === ''} OR filename ILIKE ${needle} OR ocr_text ILIKE ${needle})
    ) docs
    ORDER BY date DESC
    LIMIT 100
  `;
  const nameOf = new Map(graph.entities.map(entity => [entity.bookGuid, entity.name]));
  return rows.map(row => ({
    id: `${row.kind}:${row.id}`,
    bookGuid: row.book_guid,
    bookName: nameOf.get(row.book_guid) ?? row.book_guid,
    kind: row.kind === 'receipt' ? 'receipt' : 'entity_document',
    title: row.title,
    detail: row.detail,
    date: row.date.toISOString(),
    href: row.kind === 'receipt' ? '/receipts' : '/business/documents',
  }));
}

export async function getFamilyTimeline(
  userId: number,
  activeBookGuid: string,
  from?: string,
  to?: string,
): Promise<{ events: FinancialEvent[]; conflicts: TimelineConflict[] }> {
  const graph = await getAuthorizedFamilyGraph(userId, activeBookGuid);
  const timelines = await Promise.all(
    graph.entities.map(entity => getMoneyTimeline(userId, entity.bookGuid, { from, to })),
  );
  return {
    events: timelines.flatMap(timeline => timeline.events)
      .sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title)),
    conflicts: timelines.flatMap(timeline => timeline.conflicts)
      .sort((a, b) => a.date.localeCompare(b.date)),
  };
}

export async function getFamilyActionCounts(
  userId: number,
  activeBookGuid: string,
): Promise<Record<string, number>> {
  const graph = await getAuthorizedFamilyGraph(userId, activeBookGuid);
  if (graph.entities.length === 0) return {};
  type Row = { book_guid: string; count: bigint };
  const rows = await prisma.$queryRaw<Row[]>`
    SELECT book_guid, COUNT(*) AS count
    FROM gnucash_web_financial_actions
    WHERE user_id = ${userId}
      AND book_guid IN (${Prisma.join(graph.entities.map(entity => entity.bookGuid))})
      AND state IN ('open', 'snoozed', 'accepted')
    GROUP BY book_guid
  `;
  return Object.fromEntries(rows.map(row => [row.book_guid, Number(row.count)]));
}

/**
 * REAL POSTGRESQL exercise of the effective-dated entity status history.
 *
 * Proves the properties that only a real database can: the dry-run rollback
 * really persists nothing, the per-book advisory lock serializes concurrent
 * first edits (one seed row, not two), the (book_guid, effective_from) unique
 * key, the profile's derived entity_type sync, and the audit trail.
 *
 * Cleanup follows the tier convention (see vitest.integration.config.ts):
 * every book guid carries a per-run tag and is deleted in afterAll.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import prisma from '../prisma';
import {
  applyLegacyEntityType,
  correctEntityStatusRow,
  deleteEntityStatusRow,
  EntityStatusValidationError,
  getEntityStatusAt,
  getEntityStatusForTaxYear,
  listEntityStatusHistories,
  listEntityStatusHistory,
  recordEntityStatusChange,
  syncAllProfileEntityTypes,
} from '../services/entity-status.service';
import { getEntityProfile, saveEntityProfile } from '../services/entity.service';

const RUN_TAG = randomUUID().replace(/-/g, '').slice(0, 12);
let seq = 0;
const newBook = () => `${RUN_TAG}bk${String(++seq).padStart(4, '0')}`.padEnd(32, '0').slice(0, 32);

const TODAY = '2026-09-30';

async function makeLlcBook(): Promise<string> {
  const book = newBook();
  await prisma.gnucash_web_entity_profiles.create({
    data: {
      book_guid: book,
      entity_type: 'llc_single',
      entity_name: 'Lotus Bud Test',
      created_at: new Date('2026-03-01T12:00:00Z'),
    },
  });
  return book;
}

const S_ELECTION = {
  effectiveFrom: '2027-01-01',
  legalForm: 'llc_single_member' as const,
  taxClassification: 's_corp' as const,
  electionForm: '2553' as const,
  electionFiledOn: '2026-12-01',
};

afterAll(async () => {
  const like = `${RUN_TAG}%`;
  await prisma.$executeRawUnsafe('DELETE FROM gnucash_web_entity_status_history WHERE book_guid LIKE $1', like);
  await prisma.$executeRawUnsafe('DELETE FROM gnucash_web_entity_members WHERE book_guid LIKE $1', like);
  await prisma.$executeRawUnsafe('DELETE FROM gnucash_web_entity_profiles WHERE book_guid LIKE $1', like);
  await prisma.$executeRawUnsafe('DELETE FROM gnucash_web_audit WHERE book_guid LIKE $1', like);
  await prisma.$disconnect();
});

describe('entity status history against real PostgreSQL', () => {
  it('synthesizes a row from the profile without writing anything', async () => {
    const book = await makeLlcBook();
    const history = await listEntityStatusHistory(book);
    expect(history.synthesized).toBe(true);
    expect(history.rows).toMatchObject([
      { id: null, effectiveFrom: '1900-01-01', legalForm: 'llc_single_member', taxClassification: 'disregarded' },
    ]);
    expect(await prisma.gnucash_web_entity_status_history.count({ where: { book_guid: book } })).toBe(0);

    const noProfile = newBook();
    expect((await getEntityStatusAt(noProfile, TODAY)).entityType).toBe('household');
  });

  it('dry-runs a planned S election without persisting it', async () => {
    const book = await makeLlcBook();
    const preview = await recordEntityStatusChange(book, S_ELECTION, { dryRun: true, today: TODAY });
    expect(preview.dryRun).toBe(true);
    expect(preview.affectedYears).toEqual([2027, 2028]);
    expect(preview.history).toHaveLength(2);
    // Neither the seed nor the new row survives the rolled-back transaction.
    expect(await prisma.gnucash_web_entity_status_history.count({ where: { book_guid: book } })).toBe(0);
    expect(await prisma.gnucash_web_audit.count({ where: { book_guid: book } })).toBe(0);
  });

  it('records a planned election that applies only from its effective date', async () => {
    const book = await makeLlcBook();
    const result = await recordEntityStatusChange(book, S_ELECTION, { today: TODAY, userId: null });
    expect(result.currentEntityType).toBe('llc_single');
    expect(result.history.map((r) => r.effectiveFrom)).toEqual(['1900-01-01', '2027-01-01']);

    const rows = await prisma.gnucash_web_entity_status_history.findMany({ where: { book_guid: book } });
    expect(rows).toHaveLength(2);

    expect((await getEntityStatusForTaxYear(book, 2026)).entityType).toBe('llc_single');
    expect((await getEntityStatusForTaxYear(book, 2027)).entityType).toBe('s_corp');
    expect((await getEntityStatusAt(book, '2026-12-31')).entityType).toBe('llc_single');
    expect((await getEntityStatusAt(book, '2027-01-01')).entityType).toBe('s_corp');

    // The profile's derived type is untouched until the election takes effect.
    const profile = await prisma.gnucash_web_entity_profiles.findUnique({ where: { book_guid: book } });
    expect(profile?.entity_type).toBe('llc_single');

    const audit = await prisma.gnucash_web_audit.findMany({ where: { book_guid: book } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'CREATE', entity_type: 'ENTITY_STATUS' });
    expect(audit[0].new_values).toMatchObject({ affectedYears: [2027, 2028] });
  });

  it('syncs the profile when a change is already in effect today', async () => {
    const book = await makeLlcBook();
    await recordEntityStatusChange(
      book,
      { ...S_ELECTION, effectiveFrom: '2026-01-01', electionFiledOn: '2026-02-01' },
      { today: TODAY },
    );
    const profile = await prisma.gnucash_web_entity_profiles.findUnique({ where: { book_guid: book } });
    expect(profile?.entity_type).toBe('s_corp');
  });

  it('refuses a mid-year change until the short year is confirmed', async () => {
    const book = await makeLlcBook();
    const mid = { ...S_ELECTION, effectiveFrom: '2027-07-01' };
    await expect(recordEntityStatusChange(book, mid, { today: TODAY })).rejects.toThrow(/short tax years/);
    const ok = await recordEntityStatusChange(book, { ...mid, shortYearConfirmed: true }, { today: TODAY });
    expect(ok.affectedYears).toContain(2027);
    const y = await getEntityStatusForTaxYear(book, 2027);
    expect(y.mixed).toBe(true);
    expect(y.shortYearConfirmed).toBe(true);
    expect(y.segments.map((s) => s.from)).toEqual(['2027-01-01', '2027-07-01']);
  });

  it('rejects invalid pairs, duplicate dates, and foreign documents', async () => {
    const book = await makeLlcBook();
    await expect(
      recordEntityStatusChange(book, { ...S_ELECTION, legalForm: 'sole_prop' }, { today: TODAY }),
    ).rejects.toBeInstanceOf(EntityStatusValidationError);
    await expect(
      recordEntityStatusChange(book, { ...S_ELECTION, electionForm: '2553', taxClassification: 'c_corp' }, { today: TODAY }),
    ).rejects.toThrow(/Form 2553/);
    await recordEntityStatusChange(book, S_ELECTION, { today: TODAY });
    await expect(recordEntityStatusChange(book, S_ELECTION, { today: TODAY })).rejects.toThrow(/already recorded/);
    await expect(
      recordEntityStatusChange(
        book,
        { ...S_ELECTION, effectiveFrom: '2028-01-01', electionDocumentId: 2147483000 },
        { today: TODAY },
      ),
    ).rejects.toThrow(/belong to this book/);
  });

  it('previews and applies a correction, reporting the affected years', async () => {
    const book = await makeLlcBook();
    const { history } = await recordEntityStatusChange(book, S_ELECTION, { today: TODAY });
    const seed = history[0];
    const correction = {
      effectiveFrom: seed.effectiveFrom,
      legalForm: 'llc_single_member' as const,
      taxClassification: 'c_corp' as const,
    };
    const preview = await correctEntityStatusRow(book, seed.id!, correction, { dryRun: true, today: TODAY });
    expect(preview.affectedYears).toEqual([2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026]);
    expect((await getEntityStatusForTaxYear(book, 2026)).entityType).toBe('llc_single');

    await correctEntityStatusRow(book, seed.id!, correction, { today: TODAY });
    expect((await getEntityStatusForTaxYear(book, 2026)).entityType).toBe('c_corp');
    const profile = await prisma.gnucash_web_entity_profiles.findUnique({ where: { book_guid: book } });
    expect(profile?.entity_type).toBe('c_corp');
    const updates = await prisma.gnucash_web_audit.findMany({ where: { book_guid: book, action: 'UPDATE' } });
    expect(updates).toHaveLength(1);
  });

  it('deletes rows but never the last one', async () => {
    const book = await makeLlcBook();
    const { history } = await recordEntityStatusChange(book, S_ELECTION, { today: TODAY });
    const election = history[1];
    const preview = await deleteEntityStatusRow(book, election.id!, { dryRun: true, today: TODAY });
    expect(preview.affectedYears).toEqual([2027, 2028]);
    await deleteEntityStatusRow(book, election.id!, { today: TODAY });
    await expect(deleteEntityStatusRow(book, history[0].id!, { today: TODAY })).rejects.toThrow(/at least one status/);
    await expect(deleteEntityStatusRow(book, 999999999, { today: TODAY })).rejects.toThrow(/not found/);
  });

  it('serializes concurrent first edits into a single seed row', async () => {
    const book = await makeLlcBook();
    await Promise.all([
      recordEntityStatusChange(book, S_ELECTION, { today: TODAY }),
      recordEntityStatusChange(book, { ...S_ELECTION, effectiveFrom: '2028-01-01' }, { today: TODAY }),
    ]);
    const rows = await prisma.gnucash_web_entity_status_history.findMany({
      where: { book_guid: book },
      orderBy: { effective_from: 'asc' },
    });
    expect(rows.map((r) => r.effective_from.toISOString().slice(0, 10))).toEqual([
      '1900-01-01',
      '2027-01-01',
      '2028-01-01',
    ]);
  });

  it('bridges the legacy single-field editor to a correction of today’s row', async () => {
    const book = await makeLlcBook();
    await recordEntityStatusChange(book, S_ELECTION, { today: TODAY });
    // No-op when the type already matches — nothing is written.
    expect(await applyLegacyEntityType(book, 'llc_single', { today: TODAY })).toBeNull();

    const result = await applyLegacyEntityType(book, 'sole_prop', { today: TODAY });
    expect(result?.row).toMatchObject({ legalForm: 'sole_prop', taxClassification: 'disregarded' });
    // The planned election stays in place for 2027.
    expect(result?.history.map((r) => r.effectiveFrom)).toEqual(['1900-01-01', '2027-01-01']);
    expect((await getEntityStatusForTaxYear(book, 2027)).entityType).toBe('s_corp');
  });

  it('keeps getEntityProfile/saveEntityProfile consistent with the history', async () => {
    const book = await makeLlcBook();
    // A past-effective S election makes today's derived type s_corp even
    // though nobody touched the profile row's type column directly.
    await recordEntityStatusChange(
      book,
      { ...S_ELECTION, effectiveFrom: '2026-01-01', electionFiledOn: '2026-02-01' },
    );
    expect((await getEntityProfile(book, 1)).entityType).toBe('s_corp');

    // Saving the legacy editor with the same type is a no-op for history.
    const before = await prisma.gnucash_web_entity_status_history.count({ where: { book_guid: book } });
    await saveEntityProfile(book, { entityType: 's_corp', entityName: 'Lotus Bud Test', members: [] });
    expect(await prisma.gnucash_web_entity_status_history.count({ where: { book_guid: book } })).toBe(before);

    // A different type corrects the row in effect today and keeps the LLC form.
    await saveEntityProfile(book, { entityType: 'c_corp', entityName: 'Lotus Bud Test', members: [] });
    const now = await getEntityStatusAt(book, TODAY);
    expect(now.row).toMatchObject({ legalForm: 'llc_single_member', taxClassification: 'c_corp', electionForm: null });
    expect((await getEntityProfile(book, 1)).entityType).toBe('c_corp');
  });

  it('re-derives the profile type on the day a planned change arrives', async () => {
    const book = await makeLlcBook();
    await recordEntityStatusChange(book, S_ELECTION, { today: TODAY });
    expect(await syncAllProfileEntityTypes(TODAY)).not.toContain(book);
    expect((await prisma.gnucash_web_entity_profiles.findUnique({ where: { book_guid: book } }))?.entity_type).toBe('llc_single');

    const updated = await syncAllProfileEntityTypes('2027-01-01');
    expect(updated).toContain(book);
    expect((await prisma.gnucash_web_entity_profiles.findUnique({ where: { book_guid: book } }))?.entity_type).toBe('s_corp');
    // Idempotent.
    expect(await syncAllProfileEntityTypes('2027-01-01')).not.toContain(book);
  });

  it('loads many histories at once, synthesizing the missing ones', async () => {
    const a = await makeLlcBook();
    await recordEntityStatusChange(a, S_ELECTION, { today: TODAY });
    const b = await makeLlcBook();
    const map = await listEntityStatusHistories([a, b, a]);
    expect(map.get(a)).toHaveLength(2);
    expect(map.get(b)).toMatchObject([{ id: null, taxClassification: 'disregarded' }]);
  });
});

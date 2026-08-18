/**
 * In-memory stand-in for `gnucash_web_avg_basis_history`.
 *
 * The table is app-owned and has no Prisma model, so `src/lib/avg-basis-history.ts`
 * reaches it through tagged-template raw SQL. Every fake Prisma client in the
 * lot test suite therefore needs to answer those statements, or the engine
 * loses its pooled-basis history the moment a test drives an average scrub.
 *
 * Dispatch is on the `gnucash_web_avg_basis_history: <name>` marker each
 * statement carries, not on SQL text, so reformatting a query cannot silently
 * stop matching and leave assertions passing against an empty table. A
 * statement that names the table without a marker is an error for the same
 * reason. Anything else returns `undefined` so the host fake can fall through
 * to its own handling (the FOR UPDATE lock helpers).
 *
 * The real statements are exercised against PostgreSQL in
 * src/lib/__tests__/avg-basis-history.integration.test.ts.
 */

export interface FakeHistoryRow {
  lot_guid: string;
  seq_no: number;
  run_id: string | null;
  basis_val: string;
}

export interface AvgBasisHistoryFake {
  /** The table contents. Mutate directly to simulate a damaged row. */
  rows: FakeHistoryRow[];
  /**
   * lot GUID -> owning account GUID, for the book-deletion cleanup, which
   * finds its rows through a subquery over `lots`. Tests that exercise that
   * path populate this; everything else can leave it empty.
   */
  lotAccounts: Map<string, string>;
  /**
   * Whether `to_regclass` reports the table as present. Set false to stand in
   * for a database where the lazy table has never been created — the cleanup
   * paths must be no-ops there, not errors.
   */
  tablePresent: boolean;
  reset(): void;
  /** Rows for one lot, oldest first. */
  forLot(lotGuid: string): FakeHistoryRow[];
  /** Handles a history SELECT, or returns undefined if this is not one. */
  query(strings: TemplateStringsArray, values: unknown[]): Record<string, unknown>[] | undefined;
  /** Handles a history write, or returns undefined if this is not one. */
  execute(strings: TemplateStringsArray, values: unknown[]): number | undefined;
}

function statementName(strings: TemplateStringsArray): string | null {
  const sql = strings.join(' ? ');
  const match = sql.match(/gnucash_web_avg_basis_history:\s*([a-z-]+)/);
  if (match) return match[1];
  if (sql.includes('gnucash_web_avg_basis_history')) {
    throw new Error(`Untagged avg-basis-history SQL in test fake: ${sql.slice(0, 160)}`);
  }
  return null;
}

export function createAvgBasisHistoryFake(): AvgBasisHistoryFake {
  const fake: AvgBasisHistoryFake = {
    rows: [],
    lotAccounts: new Map(),
    tablePresent: true,
    reset() {
      fake.rows = [];
      fake.lotAccounts = new Map();
      fake.tablePresent = true;
    },
    forLot(lotGuid: string) {
      return fake.rows
        .filter(r => r.lot_guid === lotGuid)
        .sort((a, b) => a.seq_no - b.seq_no);
    },
    query(strings, values) {
      const name = statementName(strings);
      if (name === null) return undefined;
      switch (name) {
        case 'select-stack':
          return fake.forLot(values[0] as string).map(r => ({
            seq_no: r.seq_no, run_id: r.run_id, basis_val: r.basis_val,
          }));
        case 'lots-for-run':
          return [...new Set(
            fake.rows.filter(r => r.run_id === values[0]).map(r => r.lot_guid),
          )].map(lot_guid => ({ lot_guid }));
        case 'exists':
          return fake.forLot(values[0] as string).slice(0, 1).map(() => ({ present: 1 }));
        case 'table-exists':
          return [{ reg: fake.tablePresent ? 'gnucash_web_avg_basis_history' : null }];
        default:
          throw new Error(`Unhandled avg-basis-history query in test fake: ${name}`);
      }
    },
    execute(strings, values) {
      const name = statementName(strings);
      if (name === null) return undefined;
      switch (name) {
        case 'insert-at': {
          const [lot_guid, seq_no, run_id, basis_val] = values as
            [string, number, string | null, string];
          const existing = fake.rows.find(r => r.lot_guid === lot_guid && r.seq_no === seq_no);
          if (existing) Object.assign(existing, { run_id, basis_val });
          else fake.rows.push({ lot_guid, seq_no, run_id, basis_val });
          return 1;
        }
        case 'append': {
          const [lot_guid, run_id, basis_val] = values as [string, string | null, string];
          const rows = fake.forLot(lot_guid);
          const seq_no = rows.length > 0 ? rows[rows.length - 1].seq_no + 1 : 0;
          fake.rows.push({ lot_guid, seq_no, run_id, basis_val });
          return 1;
        }
        case 'pop-top-for-run': {
          const [lot_guid, run_id] = values as [string, string];
          const rows = fake.forLot(lot_guid);
          const top = rows[rows.length - 1];
          if (!top || top.run_id !== run_id) return 0;
          fake.rows = fake.rows.filter(r => r !== top);
          return 1;
        }
        case 'delete-lots': {
          const doomed = new Set(values[0] as string[]);
          const before = fake.rows.length;
          fake.rows = fake.rows.filter(r => !doomed.has(r.lot_guid));
          return before - fake.rows.length;
        }
        case 'delete-by-account': {
          const accounts = new Set(values[0] as string[]);
          const before = fake.rows.length;
          fake.rows = fake.rows.filter(
            r => !accounts.has(fake.lotAccounts.get(r.lot_guid) ?? ''),
          );
          return before - fake.rows.length;
        }
        default:
          throw new Error(`Unhandled avg-basis-history statement in test fake: ${name}`);
      }
    },
  };
  return fake;
}

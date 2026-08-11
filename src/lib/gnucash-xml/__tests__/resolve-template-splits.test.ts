import { describe, it, expect, vi } from 'vitest';

// resolveTemplateSplits defaults to the global prisma client; these tests
// always pass an explicit fake client, so the module mock stays empty.
vi.mock('@/lib/prisma', () => ({ default: {} }));

import { parseGnuCashXml } from '../parser';
import { slotsToDbRows, type DbSlotRow } from '../slots';
import {
  resolveTemplateSplits,
  resolveTemplateSplitsBatch,
  type DbClient,
} from '@/lib/scheduled-transactions';

/**
 * Minimal in-memory prisma stand-in covering the query shapes the resolver
 * issues (findMany with equality / IN filters; select lists are ignored —
 * returning extra columns is harmless).
 */
type Row = Record<string, unknown>;

function rowMatches(row: Row, where: Row | undefined): boolean {
  return Object.entries(where ?? {}).every(([key, cond]) => {
    if (cond && typeof cond === 'object' && 'in' in (cond as Row)) {
      return ((cond as { in: unknown[] }).in).includes(row[key]);
    }
    return row[key] === cond;
  });
}

function fakeClient(store: { accounts: Row[]; splits: Row[]; slots: Row[] }): DbClient {
  const table = (rows: Row[]) => ({
    findMany: async (args?: { where?: Row }) => rows.filter((r) => rowMatches(r, args?.where)),
  });
  return {
    accounts: table(store.accounts),
    splits: table(store.splits),
    slots: table(store.slots),
  } as unknown as DbClient;
}

/**
 * A native-layout template imported from GnuCash XML: the template account
 * holds the splits directly and each split carries the sched-xaction KVP
 * frame. The slot rows are produced by the SAME parser + codec pipeline the
 * importer uses, so this proves the app's SX engine reads imported books.
 */
const NATIVE_TEMPLATE_XML = `<?xml version="1.0" encoding="utf-8" ?>
<gnc-v2>
<gnc:book version="2.0.0">
<book:id type="guid">b00k0000000000000000000000000003</book:id>
<gnc:template-transactions>
  <gnc:account version="2.0.0">
    <act:name>Template Root</act:name>
    <act:id type="guid">native-tmpl-root</act:id>
    <act:type>ROOT</act:type>
  </gnc:account>
  <gnc:account version="2.0.0">
    <act:name>native-sx-guid</act:name>
    <act:id type="guid">native-templ-acct</act:id>
    <act:type>BANK</act:type>
    <act:commodity>
      <cmdty:space>template</cmdty:space>
      <cmdty:id>template</cmdty:id>
    </act:commodity>
    <act:commodity-scu>1</act:commodity-scu>
    <act:parent type="guid">native-tmpl-root</act:parent>
  </gnc:account>
  <gnc:transaction version="2.0.0">
    <trn:id type="guid">native-tmpl-txn</trn:id>
    <trn:currency>
      <cmdty:space>CURRENCY</cmdty:space>
      <cmdty:id>USD</cmdty:id>
    </trn:currency>
    <trn:date-posted>
      <ts:date>2024-01-01 00:00:00 +0000</ts:date>
    </trn:date-posted>
    <trn:date-entered>
      <ts:date>2024-01-01 00:00:00 +0000</ts:date>
    </trn:date-entered>
    <trn:description>Hotel</trn:description>
    <trn:splits>
      <trn:split>
        <split:id type="guid">native-split-debit</split:id>
        <split:reconciled-state>n</split:reconciled-state>
        <split:value>0/100</split:value>
        <split:quantity>0/1</split:quantity>
        <split:account type="guid">native-templ-acct</split:account>
        <split:slots>
          <slot>
            <slot:key>sched-xaction</slot:key>
            <slot:value type="frame">
              <slot>
                <slot:key>account</slot:key>
                <slot:value type="guid">real-expense-acct</slot:value>
              </slot>
              <slot>
                <slot:key>credit-numeric</slot:key>
                <slot:value type="numeric">0/1</slot:value>
              </slot>
              <slot>
                <slot:key>debit-formula</slot:key>
                <slot:value type="string">26.65</slot:value>
              </slot>
              <slot>
                <slot:key>debit-numeric</slot:key>
                <slot:value type="numeric">533/20</slot:value>
              </slot>
            </slot:value>
          </slot>
        </split:slots>
      </trn:split>
      <trn:split>
        <split:id type="guid">native-split-credit</split:id>
        <split:reconciled-state>n</split:reconciled-state>
        <split:value>0/100</split:value>
        <split:quantity>0/1</split:quantity>
        <split:account type="guid">native-templ-acct</split:account>
        <split:slots>
          <slot>
            <slot:key>sched-xaction</slot:key>
            <slot:value type="frame">
              <slot>
                <slot:key>account</slot:key>
                <slot:value type="guid">real-asset-acct</slot:value>
              </slot>
              <slot>
                <slot:key>credit-formula</slot:key>
                <slot:value type="string">26.65</slot:value>
              </slot>
              <slot>
                <slot:key>credit-numeric</slot:key>
                <slot:value type="numeric">533/20</slot:value>
              </slot>
              <slot>
                <slot:key>debit-numeric</slot:key>
                <slot:value type="numeric">0/1</slot:value>
              </slot>
            </slot:value>
          </slot>
        </split:slots>
      </trn:split>
    </trn:splits>
  </gnc:transaction>
</gnc:template-transactions>
</gnc:book>
</gnc-v2>`;

/** Build the store rows the importer would write for the native fixture. */
function nativeStore(): { accounts: Row[]; splits: Row[]; slots: Row[] } {
  const data = parseGnuCashXml(Buffer.from(NATIVE_TEMPLATE_XML, 'utf-8'));
  expect(data.skipped).toEqual([]);
  const accounts: Row[] = [
    { guid: 'native-tmpl-root', name: 'Template Root', parent_guid: null },
    { guid: 'native-templ-acct', name: 'native-sx-guid', parent_guid: 'native-tmpl-root' },
    { guid: 'real-expense-acct', name: 'Hotels', parent_guid: 'real-root' },
    { guid: 'real-asset-acct', name: 'USD Transfer Account', parent_guid: 'real-root' },
  ];
  const splits: Row[] = [];
  const slots: DbSlotRow[] = [];
  for (const txn of data.templateTransactions!) {
    for (const split of txn.splits) {
      splits.push({
        guid: split.id,
        tx_guid: txn.id,
        account_guid: split.accountId,
        value_num: 0n,
        value_denom: 100n,
      });
      if (split.slots) slots.push(...slotsToDbRows(split.id, split.slots));
    }
  }
  return { accounts, splits, slots: slots as unknown as Row[] };
}

/** Store rows exactly as scheduled-tx-create writes them (app layout). */
function appStore(): { accounts: Row[]; splits: Row[]; slots: Row[] } {
  return {
    accounts: [
      { guid: 'app-sx-root', name: 'My SX', parent_guid: 'app-tmpl-root' },
      { guid: 'app-child-a', name: '', parent_guid: 'app-sx-root' },
      { guid: 'app-child-b', name: '', parent_guid: 'app-sx-root' },
      { guid: 'real-expense-acct', name: 'Hotels', parent_guid: 'real-root' },
      { guid: 'real-asset-acct', name: 'USD Transfer Account', parent_guid: 'real-root' },
    ],
    splits: [
      { guid: 'app-sp-a', account_guid: 'app-child-a', value_num: 2665n, value_denom: 100n },
      { guid: 'app-sp-b', account_guid: 'app-child-b', value_num: -2665n, value_denom: 100n },
    ],
    slots: [
      { obj_guid: 'app-child-a', name: 'account', slot_type: 4, string_val: null, guid_val: 'real-expense-acct' },
      { obj_guid: 'app-child-b', name: 'account', slot_type: 4, string_val: null, guid_val: 'real-asset-acct' },
    ],
  };
}

describe('resolveTemplateSplitsBatch — native GnuCash layout (imported books)', () => {
  it('resolves accounts and amounts from imported sched-xaction slot rows', async () => {
    const client = fakeClient(nativeStore());

    const result = await resolveTemplateSplitsBatch(['native-templ-acct'], client);
    const splits = result.get('native-templ-acct')!;

    // Debit side positive, credit side negative — matching the sign
    // convention of app-created templates (verified against a real
    // GnuCash-created schedule: 26.65 daily Hotels expense).
    expect(splits).toEqual([
      {
        accountGuid: 'real-expense-acct',
        accountName: 'Hotels',
        amount: 26.65,
        templateAccountGuid: 'native-templ-acct',
      },
      {
        accountGuid: 'real-asset-acct',
        accountName: 'USD Transfer Account',
        amount: -26.65,
        templateAccountGuid: 'native-templ-acct',
      },
    ]);
  });

  it('resolveTemplateSplits (singular) reads the native layout too', async () => {
    const client = fakeClient(nativeStore());
    const splits = await resolveTemplateSplits('native-templ-acct', client);
    expect(splits.map((s) => s.amount)).toEqual([26.65, -26.65]);
  });

  it('falls back to plain-number formulas when numerics are absent, and keeps variable-formula splits at amount 0', async () => {
    const store = nativeStore();
    // Strip the numerics from the debit split's frame rows (pre-2.6 file).
    store.slots = store.slots.filter(
      (r) =>
        !(
          String(r.name).endsWith('-numeric') &&
          store.slots.some(
            (frame) =>
              frame.obj_guid === 'native-split-debit' && frame.guid_val === r.obj_guid,
          )
        ),
    );
    // And make the credit split's frame formula-only with a VARIABLE formula.
    store.slots = store.slots.filter(
      (r) =>
        !(
          (String(r.name).endsWith('-numeric') || String(r.name).endsWith('-formula')) &&
          store.slots.some(
            (frame) =>
              frame.obj_guid === 'native-split-credit' && frame.guid_val === r.obj_guid,
          )
        ),
    );
    const creditFrame = store.slots.find(
      (r) => r.obj_guid === 'native-split-credit' && r.name === 'sched-xaction',
    )!;
    store.slots.push({
      obj_guid: creditFrame.guid_val,
      name: 'sched-xaction/credit-formula',
      slot_type: 4,
      string_val: 'salary*0.5',
      guid_val: null,
    });

    const client = fakeClient(store);
    const splits = await resolveTemplateSplits('native-templ-acct', client);

    expect(splits).toHaveLength(2);
    // debit-formula "26.65" parsed as a plain number.
    expect(splits.find((s) => s.accountGuid === 'real-expense-acct')?.amount).toBe(26.65);
    // Variable formulas are legitimately unresolvable: split kept, amount 0.
    expect(splits.find((s) => s.accountGuid === 'real-asset-acct')?.amount).toBe(0);
  });
});

describe('resolveTemplateSplitsBatch — app layout precedence (regression)', () => {
  it('still resolves app-created templates exactly as before', async () => {
    const client = fakeClient(appStore());
    const result = await resolveTemplateSplitsBatch(['app-sx-root'], client);
    expect(result.get('app-sx-root')).toEqual([
      {
        accountGuid: 'real-expense-acct',
        accountName: 'Hotels',
        amount: 26.65,
        templateAccountGuid: 'app-child-a',
      },
      {
        accountGuid: 'real-asset-acct',
        accountName: 'USD Transfer Account',
        amount: -26.65,
        templateAccountGuid: 'app-child-b',
      },
    ]);
  });

  it('prefers the app layout when a template account has both layouts', async () => {
    const app = appStore();
    // Add a native-style direct split on the SX root that would resolve to a
    // different amount — it must be ignored because the app layout resolved.
    app.splits.push({
      guid: 'native-ish-split',
      account_guid: 'app-sx-root',
      value_num: 0n,
      value_denom: 100n,
    });
    app.slots.push(
      { obj_guid: 'native-ish-split', name: 'sched-xaction', slot_type: 9, string_val: null, guid_val: 'native-ish-frame' },
      { obj_guid: 'native-ish-frame', name: 'sched-xaction/account', slot_type: 5, string_val: null, guid_val: 'real-expense-acct' },
      { obj_guid: 'native-ish-frame', name: 'sched-xaction/debit-numeric', slot_type: 3, string_val: null, guid_val: null, numeric_val_num: 99900n, numeric_val_denom: 100n },
    );

    const client = fakeClient(app);
    const result = await resolveTemplateSplitsBatch(['app-sx-root'], client);
    const amounts = result.get('app-sx-root')!.map((s) => s.amount);
    expect(amounts).toEqual([26.65, -26.65]);
    expect(amounts).not.toContain(999);
  });

  it('resolves mixed batches: one app root and one native root together', async () => {
    const native = nativeStore();
    const app = appStore();
    const client = fakeClient({
      accounts: [...native.accounts, ...app.accounts],
      splits: [...native.splits, ...app.splits],
      slots: [...native.slots, ...app.slots],
    });

    const result = await resolveTemplateSplitsBatch(
      ['native-templ-acct', 'app-sx-root'],
      client,
    );
    expect(result.get('native-templ-acct')!.map((s) => s.amount)).toEqual([26.65, -26.65]);
    expect(result.get('app-sx-root')!.map((s) => s.amount)).toEqual([26.65, -26.65]);
  });
});

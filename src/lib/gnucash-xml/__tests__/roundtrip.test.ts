import { describe, it, expect } from 'vitest';
import { parseGnuCashXml } from '../parser';
import { buildGnuCashXml } from '../builder';
import type { GnuCashXmlData } from '../types';

/**
 * Fixture book exercising the wave-1 fidelity surface: account slots
 * (notes/color/hidden/placeholder), a transaction with trn:slots (incl.
 * the date-posted gdate slot) and split:slots, a lot with title/notes and
 * a split referencing it, a commodity with quote flags and cmdty:slots,
 * book:slots, non-standard SCU, and a budget recurrence with weekend_adj.
 */
const FIXTURE = `<?xml version="1.0" encoding="utf-8" ?>
<gnc-v2
     xmlns:gnc="http://www.gnucash.org/XML/gnc"
     xmlns:act="http://www.gnucash.org/XML/act"
     xmlns:book="http://www.gnucash.org/XML/book"
     xmlns:cd="http://www.gnucash.org/XML/cd"
     xmlns:cmdty="http://www.gnucash.org/XML/cmdty"
     xmlns:slot="http://www.gnucash.org/XML/slot"
     xmlns:split="http://www.gnucash.org/XML/split"
     xmlns:trn="http://www.gnucash.org/XML/trn"
     xmlns:ts="http://www.gnucash.org/XML/ts"
     xmlns:bgt="http://www.gnucash.org/XML/bgt"
     xmlns:recurrence="http://www.gnucash.org/XML/recurrence"
     xmlns:lot="http://www.gnucash.org/XML/lot">
<gnc:count-data cd:type="book">1</gnc:count-data>
<gnc:book version="2.0.0">
<book:id type="guid">b00k0000000000000000000000000001</book:id>
<book:slots>
  <slot>
    <slot:key>counters</slot:key>
    <slot:value type="frame">
      <slot>
        <slot:key>gncInvoice</slot:key>
        <slot:value type="integer">17</slot:value>
      </slot>
    </slot:value>
  </slot>
  <slot>
    <slot:key>features</slot:key>
    <slot:value type="frame">
      <slot>
        <slot:key>Register sort and filter settings stored in .gcm file</slot:key>
        <slot:value type="string">Store the register sort and filter settings in .gcm metadata file</slot:value>
      </slot>
    </slot:value>
  </slot>
</book:slots>
<gnc:count-data cd:type="commodity">2</gnc:count-data>
<gnc:count-data cd:type="account">3</gnc:count-data>
<gnc:count-data cd:type="transaction">1</gnc:count-data>
<gnc:count-data cd:type="budget">1</gnc:count-data>
<gnc:commodity version="2.0.0">
  <cmdty:space>CURRENCY</cmdty:space>
  <cmdty:id>USD</cmdty:id>
  <cmdty:get_quotes/>
  <cmdty:quote_source>currency</cmdty:quote_source>
  <cmdty:quote_tz/>
</gnc:commodity>
<gnc:commodity version="2.0.0">
  <cmdty:space>NASDAQ</cmdty:space>
  <cmdty:id>AAPL</cmdty:id>
  <cmdty:name>Apple Inc</cmdty:name>
  <cmdty:xcode>037833100</cmdty:xcode>
  <cmdty:fraction>10000</cmdty:fraction>
  <cmdty:get_quotes/>
  <cmdty:quote_source>yahoo_json</cmdty:quote_source>
  <cmdty:slots>
    <slot>
      <slot:key>user_symbol</slot:key>
      <slot:value type="string">AAPL.O</slot:value>
    </slot>
  </cmdty:slots>
</gnc:commodity>
<gnc:account version="2.0.0">
  <act:name>Root Account</act:name>
  <act:id type="guid">r00t0000000000000000000000000001</act:id>
  <act:type>ROOT</act:type>
</gnc:account>
<gnc:account version="2.0.0">
  <act:name>Investments</act:name>
  <act:id type="guid">acc00000000000000000000000000001</act:id>
  <act:type>ASSET</act:type>
  <act:commodity>
    <cmdty:space>CURRENCY</cmdty:space>
    <cmdty:id>USD</cmdty:id>
  </act:commodity>
  <act:commodity-scu>100</act:commodity-scu>
  <act:slots>
    <slot>
      <slot:key>color</slot:key>
      <slot:value type="string">rgb(233,236,74)</slot:value>
    </slot>
    <slot>
      <slot:key>notes</slot:key>
      <slot:value type="string">Brokerage sweep</slot:value>
    </slot>
    <slot>
      <slot:key>placeholder</slot:key>
      <slot:value type="string">true</slot:value>
    </slot>
  </act:slots>
  <act:parent type="guid">r00t0000000000000000000000000001</act:parent>
</gnc:account>
<gnc:account version="2.0.0">
  <act:name>AAPL</act:name>
  <act:id type="guid">acc00000000000000000000000000002</act:id>
  <act:type>STOCK</act:type>
  <act:commodity>
    <cmdty:space>NASDAQ</cmdty:space>
    <cmdty:id>AAPL</cmdty:id>
  </act:commodity>
  <act:commodity-scu>10000</act:commodity-scu>
  <act:non-standard-scu/>
  <act:slots>
    <slot>
      <slot:key>hidden</slot:key>
      <slot:value type="string">true</slot:value>
    </slot>
    <slot>
      <slot:key>reconcile-info</slot:key>
      <slot:value type="frame">
        <slot>
          <slot:key>include-children</slot:key>
          <slot:value type="integer">0</slot:value>
        </slot>
        <slot>
          <slot:key>last-date</slot:key>
          <slot:value type="integer">1704067199</slot:value>
        </slot>
      </slot:value>
    </slot>
  </act:slots>
  <act:parent type="guid">acc00000000000000000000000000001</act:parent>
  <act:lots>
    <gnc:lot version="2.0.0">
      <lot:id type="guid">10t00000000000000000000000000001</lot:id>
      <lot:slots>
        <slot>
          <slot:key>notes</slot:key>
          <slot:value type="string">Opened by scrub</slot:value>
        </slot>
        <slot>
          <slot:key>title</slot:key>
          <slot:value type="string">Lot 0</slot:value>
        </slot>
      </lot:slots>
    </gnc:lot>
  </act:lots>
</gnc:account>
<gnc:transaction version="2.0.0">
  <trn:id type="guid">7xn00000000000000000000000000001</trn:id>
  <trn:currency>
    <cmdty:space>CURRENCY</cmdty:space>
    <cmdty:id>USD</cmdty:id>
  </trn:currency>
  <trn:date-posted>
    <ts:date>2024-01-15 10:59:00 +0000</ts:date>
  </trn:date-posted>
  <trn:date-entered>
    <ts:date>2024-01-16 08:00:00 +0000</ts:date>
  </trn:date-entered>
  <trn:description>Buy AAPL</trn:description>
  <trn:slots>
    <slot>
      <slot:key>date-posted</slot:key>
      <slot:value type="gdate">
        <gdate>2024-01-15</gdate>
      </slot:value>
    </slot>
    <slot>
      <slot:key>notes</slot:key>
      <slot:value type="string">First tranche</slot:value>
    </slot>
  </trn:slots>
  <trn:splits>
    <trn:split>
      <split:id type="guid">5p1a0000000000000000000000000001</split:id>
      <split:reconciled-state>n</split:reconciled-state>
      <split:value>10000/100</split:value>
      <split:quantity>10000/10000</split:quantity>
      <split:account type="guid">acc00000000000000000000000000002</split:account>
      <split:lot type="guid">10t00000000000000000000000000001</split:lot>
      <split:slots>
        <slot>
          <slot:key>gains-split</slot:key>
          <slot:value type="guid">9a1n5000000000000000000000000001</slot:value>
        </slot>
      </split:slots>
    </trn:split>
    <trn:split>
      <split:id type="guid">5p1b0000000000000000000000000001</split:id>
      <split:reconciled-state>y</split:reconciled-state>
      <split:reconcile-date>
        <ts:date>2024-02-01 00:00:00 +0000</ts:date>
      </split:reconcile-date>
      <split:value>-10000/100</split:value>
      <split:quantity>-10000/100</split:quantity>
      <split:account type="guid">acc00000000000000000000000000001</split:account>
    </trn:split>
  </trn:splits>
</gnc:transaction>
<gnc:budget version="2.0.0">
  <bgt:id type="guid">6d9e7000000000000000000000000001</bgt:id>
  <bgt:name>Yearly</bgt:name>
  <bgt:num-periods>12</bgt:num-periods>
  <bgt:recurrence version="1.0.0">
    <recurrence:mult>1</recurrence:mult>
    <recurrence:period_type>month</recurrence:period_type>
    <recurrence:start>
      <gdate>2024-01-01</gdate>
    </recurrence:start>
    <recurrence:weekend_adj>back</recurrence:weekend_adj>
  </bgt:recurrence>
  <bgt:slots>
    <slot>
      <slot:key>acc00000000000000000000000000001</slot:key>
      <slot:value type="frame">
        <slot>
          <slot:key>0</slot:key>
          <slot:value type="numeric">500/1</slot:value>
        </slot>
      </slot:value>
    </slot>
    <slot>
      <slot:key>notes</slot:key>
      <slot:value type="frame">
        <slot>
          <slot:key>acc00000000000000000000000000001</slot:key>
          <slot:value type="frame">
            <slot>
              <slot:key>0</slot:key>
              <slot:value type="string">January note</slot:value>
            </slot>
          </slot:value>
        </slot>
      </slot:value>
    </slot>
  </bgt:slots>
</gnc:budget>
</gnc:book>
</gnc-v2>
`;

function parseFixture(): GnuCashXmlData {
  return parseGnuCashXml(Buffer.from(FIXTURE, 'utf-8'));
}

describe('round-trip — parse', () => {
  it('parses commodity quote flags from empty get_quotes elements (NaN regression)', () => {
    const data = parseFixture();
    const usd = data.commodities.find((c) => c.id === 'USD')!;
    const aapl = data.commodities.find((c) => c.id === 'AAPL')!;
    expect(usd.quoteFlag).toBe(1);
    expect(aapl.quoteFlag).toBe(1);
    expect(Number.isNaN(usd.quoteFlag)).toBe(false);
    expect(aapl.slots).toEqual([
      { key: 'user_symbol', value: { type: 'string', value: 'AAPL.O' } },
    ]);
  });

  it('parses act:non-standard-scu, full act:slots, and column mirrors', () => {
    const data = parseFixture();
    const investments = data.accounts.find((a) => a.name === 'Investments')!;
    const aapl = data.accounts.find((a) => a.name === 'AAPL')!;

    expect(aapl.nonStdScu).toBe(true);
    expect(investments.nonStdScu).toBeUndefined();

    // Column mirrors still extracted…
    expect(investments.placeholder).toBe(true);
    expect(investments.notes).toBe('Brokerage sweep');
    expect(aapl.hidden).toBe(true);

    // …and the full frame is preserved (color, reconcile-info).
    expect(investments.slots).toContainEqual({
      key: 'color',
      value: { type: 'string', value: 'rgb(233,236,74)' },
    });
    expect(aapl.slots).toContainEqual({
      key: 'reconcile-info',
      value: {
        type: 'frame',
        slots: [
          { key: 'include-children', value: { type: 'integer', value: '0' } },
          { key: 'last-date', value: { type: 'integer', value: '1704067199' } },
        ],
      },
    });
  });

  it('parses act:lots with lot slots (title/notes no longer lost)', () => {
    const data = parseFixture();
    const aapl = data.accounts.find((a) => a.name === 'AAPL')!;
    expect(aapl.lots).toEqual([
      {
        id: '10t00000000000000000000000000001',
        slots: [
          { key: 'notes', value: { type: 'string', value: 'Opened by scrub' } },
          { key: 'title', value: { type: 'string', value: 'Lot 0' } },
        ],
      },
    ]);
    // split:lot reference still parsed alongside declared lots.
    expect(data.transactions[0].splits[0].lotId).toBe('10t00000000000000000000000000001');
  });

  it('parses trn:slots (incl. date-posted gdate) and split:slots', () => {
    const data = parseFixture();
    const tx = data.transactions[0];
    expect(tx.slots).toEqual([
      { key: 'date-posted', value: { type: 'gdate', value: '2024-01-15' } },
      { key: 'notes', value: { type: 'string', value: 'First tranche' } },
    ]);
    // date-posted is preserved as a slot; the timespec keeps feeding
    // the transactions table.
    expect(tx.datePosted).toBe('2024-01-15 10:59:00 +0000');
    expect(tx.splits[0].slots).toEqual([
      { key: 'gains-split', value: { type: 'guid', value: '9a1n5000000000000000000000000001' } },
    ]);
  });

  it('parses book:slots and partitions budget amount frames from passthrough slots', () => {
    const data = parseFixture();
    expect(data.book.slots).toHaveLength(2);
    expect(data.book.slots).toContainEqual({
      key: 'counters',
      value: {
        type: 'frame',
        slots: [{ key: 'gncInvoice', value: { type: 'integer', value: '17' } }],
      },
    });

    const budget = data.budgets[0];
    expect(budget.amounts).toEqual([
      { accountId: 'acc00000000000000000000000000001', periodNum: 0, amount: '500/1' },
    ]);
    // The per-period notes frame is NOT an amount frame — passthrough.
    expect(budget.slots).toHaveLength(1);
    expect(budget.slots![0].key).toBe('notes');
    expect(budget.recurrence).toEqual({
      mult: 1,
      periodType: 'month',
      periodStart: '2024-01-01',
      weekendAdjust: 'back',
    });
  });
});

describe('round-trip — build and reparse', () => {
  it('loses nothing across parse → build → reparse', () => {
    const first = parseFixture();
    const xml = buildGnuCashXml(first);
    const second = parseGnuCashXml(Buffer.from(xml, 'utf-8'));

    // Book slots survive.
    expect(second.book.id).toBe(first.book.id);
    expect(second.book.slots).toEqual(first.book.slots);

    // Commodities: quote flags and slots survive.
    const aapl1 = first.commodities.find((c) => c.id === 'AAPL')!;
    const aapl2 = second.commodities.find((c) => c.id === 'AAPL')!;
    expect(aapl2.quoteFlag).toBe(1);
    expect(aapl2.slots).toEqual(aapl1.slots);

    // Accounts: slots, non-standard-scu, lots, mirrors.
    for (const acc1 of first.accounts) {
      const acc2 = second.accounts.find((a) => a.id === acc1.id)!;
      expect(acc2).toBeDefined();
      expect(acc2.slots).toEqual(acc1.slots);
      expect(acc2.nonStdScu).toEqual(acc1.nonStdScu);
      expect(acc2.lots).toEqual(acc1.lots);
      expect(acc2.hidden).toEqual(acc1.hidden);
      expect(acc2.placeholder).toEqual(acc1.placeholder);
      expect(acc2.notes).toEqual(acc1.notes);
    }

    // Transactions: trn:slots, split:slots, split:lot.
    const tx1 = first.transactions[0];
    const tx2 = second.transactions[0];
    expect(tx2.slots).toEqual(tx1.slots);
    expect(tx2.splits.map((s) => s.slots)).toEqual(tx1.splits.map((s) => s.slots));
    expect(tx2.splits[0].lotId).toBe(tx1.splits[0].lotId);

    // Budget: amounts, passthrough slots, weekend_adj.
    expect(second.budgets[0].amounts).toEqual(first.budgets[0].amounts);
    expect(second.budgets[0].slots).toEqual(first.budgets[0].slots);
    expect(second.budgets[0].recurrence).toEqual(first.budgets[0].recurrence);

    // Nothing was recorded as skipped in either pass.
    expect(first.skipped).toEqual([]);
    expect(second.skipped).toEqual([]);
  });

  it('emits count-data for every emitted family, omitting zero counts', () => {
    const data = parseFixture();
    const xml = buildGnuCashXml(data);
    const reparsed = parseGnuCashXml(Buffer.from(xml, 'utf-8'));

    expect(reparsed.countData).toEqual({
      commodity: 2,
      account: 3,
      transaction: 1,
      budget: 1,
    });
    // No pricedb in the fixture → no price count element at all.
    expect(xml).not.toContain('cd:type="price"');
    // The cd:type attribute is emitted literally (upstream BADXML quirk).
    expect(xml).toContain('cd:type="account"');
  });

  it('emits weekend_adj only when not none', () => {
    const data = parseFixture();
    let xml = buildGnuCashXml(data);
    expect(xml).toContain('<recurrence:weekend_adj>back</recurrence:weekend_adj>');

    delete data.budgets[0].recurrence!.weekendAdjust;
    xml = buildGnuCashXml(data);
    expect(xml).not.toContain('weekend_adj');
  });

  it('emits non-standard-scu and get_quotes as empty elements', () => {
    const xml = buildGnuCashXml(parseFixture());
    expect(xml).toMatch(/<act:non-standard-scu\s*\/>/);
    expect(xml).toMatch(/<cmdty:get_quotes\s*\/>/);
  });
});

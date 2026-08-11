import { describe, it, expect } from 'vitest';
import { XMLParser, XMLBuilder } from 'fast-xml-parser';
import {
  parseSlotsContainer,
  buildSlotsContainer,
  slotsToDbRows,
  indexDbSlotRows,
  dbRowsToSlots,
  formatSlotDouble,
  SLOT_TYPE,
} from '../slots';
import type { GnuCashSlot } from '../types';

/** Parse a `<test:slots>…</test:slots>` snippet the way parser.ts does. */
function parseXmlSlots(inner: string, skipped: string[] = []): GnuCashSlot[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseTagValue: false,
    trimValues: true,
  });
  const parsed = parser.parse(`<test:slots>${inner}</test:slots>`);
  return parseSlotsContainer(parsed['test:slots'], skipped, 'test');
}

describe('slots codec — XML to typed', () => {
  it('parses every upstream value type', () => {
    const slots = parseXmlSlots(`
      <slot><slot:key>int</slot:key><slot:value type="integer">9223372036854775807</slot:value></slot>
      <slot><slot:key>dbl</slot:key><slot:value type="double">0.100000000000000006</slot:value></slot>
      <slot><slot:key>num</slot:key><slot:value type="numeric">123/456</slot:value></slot>
      <slot><slot:key>str</slot:key><slot:value type="string">hello &amp; goodbye</slot:value></slot>
      <slot><slot:key>gid</slot:key><slot:value type="guid">abcdefabcdefabcdefabcdefabcdefab</slot:value></slot>
      <slot><slot:key>ts</slot:key><slot:value type="timespec"><ts:date>2024-01-15 10:30:00 +0000</ts:date></slot:value></slot>
      <slot><slot:key>gd</slot:key><slot:value type="gdate"><gdate>2024-01-15</gdate></slot:value></slot>
      <slot><slot:key>lst</slot:key><slot:value type="list">
        <slot:value type="integer">1</slot:value>
        <slot:value type="string">two</slot:value>
      </slot:value></slot>
      <slot><slot:key>frm</slot:key><slot:value type="frame">
        <slot><slot:key>inner</slot:key><slot:value type="frame">
          <slot><slot:key>deep</slot:key><slot:value type="string">nested</slot:value></slot>
        </slot:value></slot>
      </slot:value></slot>
    `);

    expect(slots).toEqual([
      { key: 'int', value: { type: 'integer', value: '9223372036854775807' } },
      { key: 'dbl', value: { type: 'double', value: 0.1 } },
      { key: 'num', value: { type: 'numeric', value: '123/456' } },
      { key: 'str', value: { type: 'string', value: 'hello & goodbye' } },
      { key: 'gid', value: { type: 'guid', value: 'abcdefabcdefabcdefabcdefabcdefab' } },
      { key: 'ts', value: { type: 'timespec', value: '2024-01-15 10:30:00 +0000' } },
      { key: 'gd', value: { type: 'gdate', value: '2024-01-15' } },
      {
        key: 'lst',
        value: {
          type: 'list',
          values: [
            { type: 'integer', value: '1' },
            { type: 'string', value: 'two' },
          ],
        },
      },
      {
        key: 'frm',
        value: {
          type: 'frame',
          slots: [
            {
              key: 'inner',
              value: {
                type: 'frame',
                slots: [{ key: 'deep', value: { type: 'string', value: 'nested' } }],
              },
            },
          ],
        },
      },
    ]);
  });

  it('parses empty string values and typed slot keys', () => {
    const slots = parseXmlSlots(`
      <slot><slot:key type="guid">acct000000000000000000000000000f</slot:key><slot:value type="string"></slot:value></slot>
    `);
    expect(slots).toEqual([
      { key: 'acct000000000000000000000000000f', value: { type: 'string', value: '' } },
    ]);
  });

  it('records binary values in skipped instead of throwing', () => {
    const skipped: string[] = [];
    const slots = parseXmlSlots(
      `<slot><slot:key>legacy</slot:key><slot:value type="binary">deadbeef</slot:value></slot>
       <slot><slot:key>keep</slot:key><slot:value type="string">kept</slot:value></slot>`,
      skipped,
    );
    expect(slots).toEqual([{ key: 'keep', value: { type: 'string', value: 'kept' } }]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toContain('Binary slot value skipped');
    expect(skipped[0]).toContain('legacy');
  });

  it('records unknown value types in skipped', () => {
    const skipped: string[] = [];
    const slots = parseXmlSlots(
      `<slot><slot:key>weird</slot:key><slot:value type="martian">?</slot:value></slot>`,
      skipped,
    );
    expect(slots).toEqual([]);
    expect(skipped[0]).toContain('Unsupported slot value type "martian"');
  });
});

describe('slots codec — typed to XML', () => {
  it('round-trips through build + reparse without loss', () => {
    const original = parseXmlSlots(`
      <slot><slot:key>int</slot:key><slot:value type="integer">-42</slot:value></slot>
      <slot><slot:key>ts</slot:key><slot:value type="timespec"><ts:date>2024-01-15 10:30:00 +0000</ts:date></slot:value></slot>
      <slot><slot:key>gd</slot:key><slot:value type="gdate"><gdate>2024-01-15</gdate></slot:value></slot>
      <slot><slot:key>frm</slot:key><slot:value type="frame">
        <slot><slot:key>n</slot:key><slot:value type="numeric">1/3</slot:value></slot>
      </slot:value></slot>
      <slot><slot:key>lst</slot:key><slot:value type="list">
        <slot:value type="gdate"><gdate>2020-06-30</gdate></slot:value>
      </slot:value></slot>
    `);

    // Build to fast-xml-parser objects, serialize, reparse, re-decode.
    const builder = new XMLBuilder({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      suppressEmptyNode: true,
    });
    const xml = builder.build({ 'test:slots': buildSlotsContainer(original) });
    const reparsed = parseXmlSlots(xml.replace(/^<test:slots>|<\/test:slots>$/g, ''));
    expect(reparsed).toEqual(original);
  });

  it('emits the timespec ts:date child and gdate child forms', () => {
    const built = buildSlotsContainer([
      { key: 'ts', value: { type: 'timespec', value: '2024-01-15 10:30:00 +0000' } },
      { key: 'gd', value: { type: 'gdate', value: '2024-01-15' } },
    ])!;
    const slotEls = built.slot as Array<Record<string, unknown>>;
    expect(slotEls[0]['slot:value']).toEqual({
      '@_type': 'timespec',
      'ts:date': '2024-01-15 10:30:00 +0000',
    });
    expect(slotEls[1]['slot:value']).toEqual({ '@_type': 'gdate', gdate: '2024-01-15' });
  });

  it('returns undefined for empty slot lists (omit-when-empty rule)', () => {
    expect(buildSlotsContainer([])).toBeUndefined();
    expect(buildSlotsContainer(undefined)).toBeUndefined();
  });
});

describe('formatSlotDouble', () => {
  it('matches the %.18g conventions', () => {
    expect(formatSlotDouble(1.5)).toBe('1.5');
    expect(formatSlotDouble(0.1)).toBe('0.100000000000000006');
    expect(formatSlotDouble(100)).toBe('100');
    expect(formatSlotDouble(0)).toBe('0');
    expect(formatSlotDouble(1e20)).toBe('1e+20');
  });
});

describe('slots codec — DB row mapping', () => {
  const sampleSlots: GnuCashSlot[] = [
    { key: 'notes', value: { type: 'string', value: 'hello' } },
    { key: 'count', value: { type: 'integer', value: '12' } },
    { key: 'ratio', value: { type: 'numeric', value: '7/2' } },
    { key: 'when', value: { type: 'timespec', value: '2024-01-15 10:30:00 +0000' } },
    { key: 'day', value: { type: 'gdate', value: '2024-01-15' } },
    {
      key: 'reconcile-info',
      value: {
        type: 'frame',
        slots: [
          { key: 'include-children', value: { type: 'integer', value: '0' } },
          {
            key: 'last-interval',
            value: {
              type: 'frame',
              slots: [{ key: 'months', value: { type: 'integer', value: '1' } }],
            },
          },
        ],
      },
    },
    {
      key: 'series',
      value: {
        type: 'list',
        values: [
          { type: 'integer', value: '1' },
          { type: 'integer', value: '2' },
        ],
      },
    },
  ];

  it('flattens frames with hierarchical slash-joined names and guid-linked children', () => {
    const rows = slotsToDbRows('obj0000000000000000000000000000aa', sampleSlots);

    const frameRow = rows.find((r) => r.name === 'reconcile-info')!;
    expect(frameRow.slot_type).toBe(SLOT_TYPE.FRAME);
    expect(frameRow.obj_guid).toBe('obj0000000000000000000000000000aa');
    expect(frameRow.guid_val).toMatch(/^[0-9a-f]{32}$/);

    // Frame children: obj_guid = frame guid, name = parent-path/child.
    const child = rows.find((r) => r.name === 'reconcile-info/include-children')!;
    expect(child.obj_guid).toBe(frameRow.guid_val);
    expect(child.slot_type).toBe(SLOT_TYPE.INT64);
    expect(child.int64_val).toBe(0n);

    const innerFrame = rows.find((r) => r.name === 'reconcile-info/last-interval')!;
    const grandchild = rows.find((r) => r.name === 'reconcile-info/last-interval/months')!;
    expect(grandchild.obj_guid).toBe(innerFrame.guid_val);

    // List children: obj_guid = list guid, empty key (name ends with '/').
    const listRow = rows.find((r) => r.name === 'series')!;
    expect(listRow.slot_type).toBe(SLOT_TYPE.LIST);
    const listChildren = rows.filter((r) => r.obj_guid === listRow.guid_val);
    expect(listChildren).toHaveLength(2);
    expect(listChildren.every((r) => r.name === 'series/')).toBe(true);

    // Scalar column mapping.
    expect(rows.find((r) => r.name === 'notes')).toMatchObject({
      slot_type: SLOT_TYPE.STRING,
      string_val: 'hello',
    });
    expect(rows.find((r) => r.name === 'count')).toMatchObject({
      slot_type: SLOT_TYPE.INT64,
      int64_val: 12n,
    });
    expect(rows.find((r) => r.name === 'ratio')).toMatchObject({
      slot_type: SLOT_TYPE.NUMERIC,
      numeric_val_num: 7n,
      numeric_val_denom: 2n,
    });
    expect(rows.find((r) => r.name === 'when')!.timespec_val).toEqual(
      new Date('2024-01-15T10:30:00.000Z'),
    );
    expect(rows.find((r) => r.name === 'day')!.gdate_val).toEqual(
      new Date('2024-01-15T00:00:00.000Z'),
    );
  });

  it('round-trips typed slots through DB rows and back', () => {
    const rows = slotsToDbRows('obj0000000000000000000000000000aa', sampleSlots);
    const index = indexDbSlotRows(rows);
    const decoded = dbRowsToSlots(index, 'obj0000000000000000000000000000aa');

    // dbRowsToSlots sorts by key; compare against a key-sorted deep copy.
    const sortSlots = (slots: GnuCashSlot[]): GnuCashSlot[] =>
      [...slots]
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
        .map((s) =>
          s.value.type === 'frame'
            ? { key: s.key, value: { type: 'frame' as const, slots: sortSlots(s.value.slots) } }
            : s,
        );
    expect(decoded).toEqual(sortSlots(sampleSlots));
  });

  it('records unknown slot_type rows in skipped when decoding', () => {
    const skipped: string[] = [];
    const index = indexDbSlotRows([
      {
        obj_guid: 'obj1',
        name: 'mystery',
        slot_type: 7,
        int64_val: null,
        string_val: null,
        double_val: null,
        timespec_val: null,
        guid_val: null,
        numeric_val_num: null,
        numeric_val_denom: null,
        gdate_val: null,
      },
    ]);
    expect(dbRowsToSlots(index, 'obj1', skipped)).toEqual([]);
    expect(skipped[0]).toContain('slot_type 7');
  });
});

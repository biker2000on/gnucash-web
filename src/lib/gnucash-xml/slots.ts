/**
 * Generic GnuCash KVP slot codec.
 *
 * Three representations of the same KVP data are handled here:
 *
 * 1. XML `<slot>` subtrees (as produced by fast-xml-parser with the
 *    options used in parser.ts) — see upstream sixtp-dom-generators.cpp /
 *    sixtp-dom-parsers.cpp for the wire format.
 * 2. The typed in-memory form (`GnuCashSlot` / `SlotValue` in types.ts),
 *    which is what GnuCashXmlData carries around.
 * 3. Native `slots` table rows, matching the upstream SQL backend
 *    (gnc-slots-sql.cpp): hierarchical slash-joined names, frame/list
 *    children stored under a fresh guid carried in guid_val.
 *
 * Value types covered: integer (int64), double, numeric, string, guid,
 * timespec, gdate, list, frame. The legacy `binary` type is never emitted
 * by any GnuCash v2 writer; on read it is recorded in the caller's
 * skipped list instead of throwing.
 */

import { generateGuid } from '@/lib/gnucash';
import type { GnuCashSlot, SlotValue } from './types';

/** slot_type integers used by the native slots table (KvpValue::Type). */
export const SLOT_TYPE = {
  INT64: 1,
  DOUBLE: 2,
  NUMERIC: 3,
  STRING: 4,
  GUID: 5,
  TIMESPEC: 6,
  LIST: 8,
  FRAME: 9,
  GDATE: 10,
} as const;

/** One row of the native `slots` table (insert-ready shape). */
export interface DbSlotRow {
  obj_guid: string;
  name: string;
  slot_type: number;
  int64_val: bigint | null;
  string_val: string | null;
  double_val: number | null;
  timespec_val: Date | null;
  guid_val: string | null;
  numeric_val_num: bigint | null;
  numeric_val_denom: bigint | null;
  gdate_val: Date | null;
}

/* ============================================================
 * Shared helpers
 * ============================================================ */

/**
 * Ensure a value is always an array (fast-xml-parser returns a single
 * object when there's only one element).
 */
function ensureArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value;
  return [value];
}

/** Text content of a fast-xml-parser node (bare string or `#text`). */
function extractText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    const text = (value as Record<string, unknown>)['#text'];
    if (text != null) return String(text);
    return '';
  }
  return String(value);
}

/** Parse a `num/denom` fraction into BigInt parts (bare int → denom 1). */
function parseFractionParts(fractionStr: string): { num: bigint; denom: bigint } {
  const parts = fractionStr.split('/');
  try {
    if (parts.length === 2) {
      return { num: BigInt(parts[0].trim()), denom: BigInt(parts[1].trim()) };
    }
    return { num: BigInt(parts[0].trim() || '0'), denom: 1n };
  } catch {
    return { num: 0n, denom: 1n };
  }
}

/** Parse a GnuCash timespec string ("YYYY-MM-DD HH:MM:SS +0000") to a Date. */
function parseTimespecString(value: string): Date | null {
  if (!value) return null;
  const trimmed = value.trim();
  const isoLike = trimmed.replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/, '$1T$2');
  const date = new Date(isoLike);
  if (!isNaN(date.getTime())) return date;
  const fallback = new Date(trimmed);
  if (!isNaN(fallback.getTime())) return fallback;
  return null;
}

/** Format a Date as the upstream timespec string (UTC, literal ` +0000`). */
function formatTimespec(date: Date): string {
  return date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' +0000');
}

/**
 * Format a double the way the upstream writer does (`%24.18g`, then
 * whitespace-stripped): 18 significant digits with trailing zeros removed.
 */
export function formatSlotDouble(value: number): string {
  if (!isFinite(value)) return String(value);
  let s = value.toPrecision(18);
  if (s.includes('e')) {
    // Strip trailing mantissa zeros in exponent form: 1.000…0e+20 → 1e+20
    s = s.replace(/\.?0+e/, 'e');
    return s;
  }
  if (s.includes('.')) {
    s = s.replace(/0+$/, '').replace(/\.$/, '');
  }
  return s;
}

/* ============================================================
 * XML → typed
 * ============================================================ */

/**
 * Parse a `*:slots` container element (fast-xml-parser object) into typed
 * slots. Unsupported value types (binary, unknown) are recorded in
 * `skipped` — never thrown — and their slot is dropped.
 */
export function parseSlotsContainer(
  container: unknown,
  skipped: string[],
  context: string,
): GnuCashSlot[] {
  if (!container || typeof container !== 'object') return [];
  const slotList = ensureArray((container as Record<string, unknown>)['slot']);
  const result: GnuCashSlot[] = [];
  for (const raw of slotList) {
    const slot = parseSlot(raw, skipped, context);
    if (slot) result.push(slot);
  }
  return result;
}

function parseSlot(raw: unknown, skipped: string[], context: string): GnuCashSlot | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const key = extractText(obj['slot:key']);
  const value = parseSlotValue(obj['slot:value'], skipped, `${context}/${key}`);
  if (value === null) return null;
  return { key, value };
}

function parseSlotValue(raw: unknown, skipped: string[], context: string): SlotValue | null {
  if (raw === undefined || raw === null) {
    skipped.push(`Slot with no value skipped (${context})`);
    return null;
  }
  // Untyped bare text — upstream always writes a type attribute, but be
  // tolerant on read and treat it as a string.
  if (typeof raw === 'string') return { type: 'string', value: raw };
  const obj = raw as Record<string, unknown>;
  const type = String(obj['@_type'] ?? 'string');

  switch (type) {
    case 'integer':
      return { type: 'integer', value: extractText(obj) || '0' };
    case 'double':
      return { type: 'double', value: Number(extractText(obj) || '0') };
    case 'numeric':
      return { type: 'numeric', value: extractText(obj) || '0/1' };
    case 'string':
      return { type: 'string', value: extractText(obj) };
    case 'guid':
      return { type: 'guid', value: extractText(obj) };
    case 'timespec':
      return { type: 'timespec', value: extractText(obj['ts:date']) };
    case 'gdate':
      return { type: 'gdate', value: extractText(obj['gdate']) };
    case 'frame': {
      const children = ensureArray(obj['slot']);
      const slots: GnuCashSlot[] = [];
      for (const child of children) {
        const slot = parseSlot(child, skipped, context);
        if (slot) slots.push(slot);
      }
      return { type: 'frame', slots };
    }
    case 'list': {
      const children = ensureArray(obj['slot:value']);
      const values: SlotValue[] = [];
      for (const child of children) {
        const value = parseSlotValue(child, skipped, context);
        if (value) values.push(value);
      }
      return { type: 'list', values };
    }
    case 'binary':
      skipped.push(`Binary slot value skipped (${context})`);
      return null;
    default:
      skipped.push(`Unsupported slot value type "${type}" skipped (${context})`);
      return null;
  }
}

/* ============================================================
 * Typed → XML
 * ============================================================ */

/**
 * Build the fast-xml-parser object for a `*:slots` container. Returns
 * undefined for an empty slot list so callers can follow the upstream
 * omit-when-empty rule.
 */
export function buildSlotsContainer(
  slots: GnuCashSlot[] | undefined,
): Record<string, unknown> | undefined {
  if (!slots || slots.length === 0) return undefined;
  return { slot: slots.map(buildSlot) };
}

function buildSlot(slot: GnuCashSlot): Record<string, unknown> {
  return {
    'slot:key': slot.key,
    'slot:value': buildSlotValue(slot.value),
  };
}

function buildSlotValue(value: SlotValue): Record<string, unknown> {
  switch (value.type) {
    case 'integer':
      return { '@_type': 'integer', '#text': value.value };
    case 'double':
      return { '@_type': 'double', '#text': formatSlotDouble(value.value) };
    case 'numeric':
      return { '@_type': 'numeric', '#text': value.value };
    case 'string':
      return { '@_type': 'string', '#text': value.value };
    case 'guid':
      return { '@_type': 'guid', '#text': value.value };
    case 'timespec':
      return { '@_type': 'timespec', 'ts:date': value.value };
    case 'gdate':
      return { '@_type': 'gdate', gdate: value.value };
    case 'frame':
      return {
        '@_type': 'frame',
        ...(value.slots.length > 0 ? { slot: value.slots.map(buildSlot) } : {}),
      };
    case 'list':
      return {
        '@_type': 'list',
        ...(value.values.length > 0
          ? { 'slot:value': value.values.map(buildSlotValue) }
          : {}),
      };
  }
}

/* ============================================================
 * Typed → DB rows
 * ============================================================ */

function emptyRow(objGuid: string, name: string, slotType: number): DbSlotRow {
  return {
    obj_guid: objGuid,
    name,
    slot_type: slotType,
    int64_val: null,
    string_val: null,
    double_val: null,
    timespec_val: null,
    guid_val: null,
    numeric_val_num: null,
    numeric_val_denom: null,
    gdate_val: null,
  };
}

/**
 * Flatten typed slots into native `slots` table rows for one object,
 * following the upstream SQL backend layout: frames/lists get their own
 * row whose guid_val is a freshly generated guid, and their children carry
 * `parent-path/child` names with obj_guid = that guid. List children use
 * an empty key (name ends with `/`), matching gnc-slots-sql.cpp.
 */
export function slotsToDbRows(objGuid: string, slots: GnuCashSlot[]): DbSlotRow[] {
  const rows: DbSlotRow[] = [];
  const walk = (owner: string, parentPath: string, children: GnuCashSlot[]) => {
    for (const slot of children) {
      pushValueRows(owner, parentPath + slot.key, slot.value);
    }
  };
  const pushValueRows = (owner: string, name: string, value: SlotValue) => {
    switch (value.type) {
      case 'integer': {
        const row = emptyRow(owner, name, SLOT_TYPE.INT64);
        row.int64_val = BigInt(value.value || '0');
        rows.push(row);
        break;
      }
      case 'double': {
        const row = emptyRow(owner, name, SLOT_TYPE.DOUBLE);
        row.double_val = value.value;
        rows.push(row);
        break;
      }
      case 'numeric': {
        const row = emptyRow(owner, name, SLOT_TYPE.NUMERIC);
        const fraction = parseFractionParts(value.value);
        row.numeric_val_num = fraction.num;
        row.numeric_val_denom = fraction.denom;
        rows.push(row);
        break;
      }
      case 'string': {
        const row = emptyRow(owner, name, SLOT_TYPE.STRING);
        row.string_val = value.value;
        rows.push(row);
        break;
      }
      case 'guid': {
        const row = emptyRow(owner, name, SLOT_TYPE.GUID);
        row.guid_val = value.value;
        rows.push(row);
        break;
      }
      case 'timespec': {
        const row = emptyRow(owner, name, SLOT_TYPE.TIMESPEC);
        row.timespec_val = parseTimespecString(value.value);
        rows.push(row);
        break;
      }
      case 'gdate': {
        const row = emptyRow(owner, name, SLOT_TYPE.GDATE);
        row.gdate_val = value.value ? new Date(`${value.value}T00:00:00.000Z`) : null;
        rows.push(row);
        break;
      }
      case 'frame': {
        const frameGuid = generateGuid();
        const row = emptyRow(owner, name, SLOT_TYPE.FRAME);
        row.guid_val = frameGuid;
        rows.push(row);
        walk(frameGuid, `${name}/`, value.slots);
        break;
      }
      case 'list': {
        const listGuid = generateGuid();
        const row = emptyRow(owner, name, SLOT_TYPE.LIST);
        row.guid_val = listGuid;
        rows.push(row);
        for (const item of value.values) {
          pushValueRows(listGuid, `${name}/`, item);
        }
        break;
      }
    }
  };
  walk(objGuid, '', slots);
  return rows;
}

/* ============================================================
 * DB rows → typed
 * ============================================================ */

/** Loaded row shape (Prisma slots row; extra columns like `id` are fine). */
export interface LoadedSlotRow {
  obj_guid: string;
  name: string;
  slot_type: number;
  int64_val: bigint | null;
  string_val: string | null;
  double_val: number | null;
  timespec_val: Date | null;
  guid_val: string | null;
  numeric_val_num: bigint | null;
  numeric_val_denom: bigint | null;
  gdate_val: Date | null;
}

/** Index loaded slot rows by obj_guid for tree reconstruction. */
export function indexDbSlotRows(rows: LoadedSlotRow[]): Map<string, LoadedSlotRow[]> {
  const index = new Map<string, LoadedSlotRow[]>();
  for (const row of rows) {
    const list = index.get(row.obj_guid);
    if (list) list.push(row);
    else index.set(row.obj_guid, [row]);
  }
  return index;
}

/**
 * Reconstruct the typed slot tree for one object from indexed rows.
 * Children are sorted by key, matching the upstream writer's sorted
 * frame iteration. Unknown slot_type values are recorded in `skipped`.
 */
export function dbRowsToSlots(
  index: Map<string, LoadedSlotRow[]>,
  objGuid: string,
  skipped?: string[],
): GnuCashSlot[] {
  return treeFor(index, objGuid, '', new Set([objGuid]), skipped);
}

function treeFor(
  index: Map<string, LoadedSlotRow[]>,
  objGuid: string,
  parentPath: string,
  visited: Set<string>,
  skipped?: string[],
): GnuCashSlot[] {
  const own = index.get(objGuid) ?? [];
  const sorted = [...own].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const result: GnuCashSlot[] = [];
  for (const row of sorted) {
    const key = row.name.startsWith(parentPath)
      ? row.name.slice(parentPath.length)
      : row.name.split('/').pop() ?? row.name;
    const value = valueFromRow(index, row, visited, skipped);
    if (value) result.push({ key, value });
  }
  return result;
}

function valueFromRow(
  index: Map<string, LoadedSlotRow[]>,
  row: LoadedSlotRow,
  visited: Set<string>,
  skipped?: string[],
): SlotValue | null {
  switch (row.slot_type) {
    case SLOT_TYPE.INT64:
      return { type: 'integer', value: (row.int64_val ?? 0n).toString() };
    case SLOT_TYPE.DOUBLE:
      return { type: 'double', value: row.double_val ?? 0 };
    case SLOT_TYPE.NUMERIC:
      return {
        type: 'numeric',
        value: `${row.numeric_val_num ?? 0n}/${row.numeric_val_denom ?? 1n}`,
      };
    case SLOT_TYPE.STRING:
      return { type: 'string', value: row.string_val ?? '' };
    case SLOT_TYPE.GUID:
      return { type: 'guid', value: row.guid_val ?? '' };
    case SLOT_TYPE.TIMESPEC:
      return {
        type: 'timespec',
        value: row.timespec_val ? formatTimespec(row.timespec_val) : '',
      };
    case SLOT_TYPE.GDATE:
      return {
        type: 'gdate',
        value: row.gdate_val ? row.gdate_val.toISOString().slice(0, 10) : '',
      };
    case SLOT_TYPE.FRAME: {
      if (!row.guid_val || visited.has(row.guid_val)) {
        return { type: 'frame', slots: [] };
      }
      visited.add(row.guid_val);
      return {
        type: 'frame',
        slots: treeFor(index, row.guid_val, `${row.name}/`, visited, skipped),
      };
    }
    case SLOT_TYPE.LIST: {
      if (!row.guid_val || visited.has(row.guid_val)) {
        return { type: 'list', values: [] };
      }
      visited.add(row.guid_val);
      const children = [...(index.get(row.guid_val) ?? [])];
      const values: SlotValue[] = [];
      for (const child of children) {
        const value = valueFromRow(index, child, visited, skipped);
        if (value) values.push(value);
      }
      return { type: 'list', values };
    }
    default:
      skipped?.push(
        `Slot "${row.name}" with unsupported slot_type ${row.slot_type} skipped (obj ${row.obj_guid})`,
      );
      return null;
  }
}

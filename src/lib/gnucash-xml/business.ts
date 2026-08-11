/**
 * XML codecs for the GnuCash business object families (schema inventory
 * §2.11–§2.21): billterms, taxtables (+entries), customers, vendors,
 * employees, jobs, invoices, entries, orders, plus the shared address and
 * owner sub-element encodings.
 *
 * Wire conventions (upstream gnc-*-xml-v2.cpp writers):
 * - version="2.0.0" on every family element and on address/owner
 *   sub-elements; gnc:GncTaxTableEntry has no version attribute.
 * - Booleans here are 0/1 INTEGERS (int_to_dom_tree) — never y/n or
 *   TRUE/FALSE (those belong to sx:* and act:* respectively).
 * - maybe_add_* rules: empty strings, zero ints, and zero numerics are
 *   omitted; unset timespecs (INT64_MAX) are omitted.
 * - owner:type carries the QOF id string (gncCustomer/gncJob/gncVendor/
 *   gncEmployee); the native DB stores the int enum 2/3/4/5.
 */

import { parseSlotsContainer, buildSlotsContainer } from './slots';
import type {
  GnuCashAddress,
  GnuCashOwner,
  GnuCashBillTerm,
  GnuCashTaxTable,
  GnuCashTaxTableEntry,
  GnuCashCustomer,
  GnuCashVendor,
  GnuCashEmployee,
  GnuCashJob,
  GnuCashInvoice,
  GnuCashEntry,
  GnuCashOrder,
} from './types';

/* ============================================================
 * Enum mappings (upstream engine <-> native SQL columns)
 * ============================================================ */

/** owner:type QOF id string -> native owner_type int (gncOwner.h enum). */
export const OWNER_TYPE_INT_BY_STRING: Record<string, number> = {
  gncCustomer: 2,
  gncJob: 3,
  gncVendor: 4,
  gncEmployee: 5,
};

/** Native owner_type int -> owner:type QOF id string. */
export const OWNER_TYPE_STRING_BY_INT: Record<number, string> = {
  2: 'gncCustomer',
  3: 'gncJob',
  4: 'gncVendor',
  5: 'gncEmployee',
};

/** Native billterms.type strings (GncBillTermType enum names, AS_STRING). */
export const TERM_TYPE_DAYS = 'GNC_TERM_TYPE_DAYS';
export const TERM_TYPE_PROXIMO = 'GNC_TERM_TYPE_PROXIMO';

/** taxincluded string -> native customers.tax_included int (gncTaxTable.h). */
export const TAXINCLUDED_INT_BY_STRING: Record<string, number> = {
  YES: 1,
  NO: 2,
  USEGLOBAL: 3,
};

/** Native customers.tax_included int -> taxincluded string. */
export const TAXINCLUDED_STRING_BY_INT: Record<number, string> = {
  1: 'YES',
  2: 'NO',
  3: 'USEGLOBAL',
};

/** tte:type string -> native taxtable_entries.type int (GncAmountType). */
export const AMT_TYPE_INT_BY_STRING: Record<string, number> = {
  VALUE: 1,
  PERCENT: 2,
};

/** Native taxtable_entries.type int -> tte:type string. */
export const AMT_TYPE_STRING_BY_INT: Record<number, string> = {
  1: 'VALUE',
  2: 'PERCENT',
};

/** entry:b-pay string -> native entries.b_paytype int (GncEntryPaymentType). */
export const PAYMENT_INT_BY_STRING: Record<string, number> = {
  CASH: 1,
  CARD: 2,
};

/** Native entries.b_paytype int -> entry:b-pay string. */
export const PAYMENT_STRING_BY_INT: Record<number, string> = {
  1: 'CASH',
  2: 'CARD',
};

/* ============================================================
 * Shared fast-xml-parser helpers (mirrors parser.ts privates)
 * ============================================================ */

function ensureArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value;
  return [value];
}

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

/** Extract "<tag><ts:date>…</ts:date></tag>" as its timestamp string. */
function parseTimestamp(tsObj: unknown): string {
  if (!tsObj) return '';
  if (typeof tsObj === 'string') return tsObj;
  if (typeof tsObj === 'object' && tsObj !== null) {
    const obj = tsObj as Record<string, unknown>;
    return String(obj['ts:date'] || obj['date'] || '');
  }
  return '';
}

function parseCommodityRef(cmdtyObj: unknown): { space: string; id: string } | undefined {
  if (!cmdtyObj || typeof cmdtyObj !== 'object') return undefined;
  const obj = cmdtyObj as Record<string, unknown>;
  const space = String(obj['cmdty:space'] || obj['space'] || '');
  const id = String(obj['cmdty:id'] || obj['id'] || '');
  if (!space && !id) return undefined;
  return { space, id };
}

/** Parse an integer element, returning the default when absent/invalid. */
function parseIntElement(raw: unknown, defaultValue: number): number {
  const parsed = parseInt(extractText(raw), 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

/** Business 0/1 integer boolean ("1" -> true, anything else -> false). */
function parseIntBool(raw: unknown, defaultValue: boolean): boolean {
  const text = extractText(raw);
  if (text !== '0' && text !== '1') return defaultValue;
  return text === '1';
}

/** Optional string element — undefined when absent or empty. */
function optionalText(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const text = extractText(raw);
  return text === '' ? undefined : text;
}

/** Optional guid element — undefined when absent or empty. */
function optionalGuid(raw: unknown): string | undefined {
  return optionalText(raw);
}

/** Optional numeric element (fraction string) — undefined when absent. */
function optionalNumeric(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const text = extractText(raw);
  return text === '' ? undefined : text;
}

/* ============================================================
 * Address + owner sub-elements
 * ============================================================ */

function parseAddress(
  raw: unknown,
  skipped: string[],
  context: string,
): GnuCashAddress {
  if (!raw || typeof raw !== 'object') return {};
  const obj = raw as Record<string, unknown>;
  const address: GnuCashAddress = {
    ...(optionalText(obj['addr:name']) ? { name: extractText(obj['addr:name']) } : {}),
    ...(optionalText(obj['addr:addr1']) ? { addr1: extractText(obj['addr:addr1']) } : {}),
    ...(optionalText(obj['addr:addr2']) ? { addr2: extractText(obj['addr:addr2']) } : {}),
    ...(optionalText(obj['addr:addr3']) ? { addr3: extractText(obj['addr:addr3']) } : {}),
    ...(optionalText(obj['addr:addr4']) ? { addr4: extractText(obj['addr:addr4']) } : {}),
    ...(optionalText(obj['addr:phone']) ? { phone: extractText(obj['addr:phone']) } : {}),
    ...(optionalText(obj['addr:fax']) ? { fax: extractText(obj['addr:fax']) } : {}),
    ...(optionalText(obj['addr:email']) ? { email: extractText(obj['addr:email']) } : {}),
  };
  // addr:slots has no native column (the SQL backend drops it too); keep it
  // on the wire type so a parse→build round-trip preserves it, but the
  // importer records it as skipped.
  const slots = parseSlotsContainer(obj['addr:slots'], skipped, `${context} address`);
  if (slots.length > 0) address.slots = slots;
  return address;
}

function buildAddress(address: GnuCashAddress | undefined): Record<string, unknown> {
  // The upstream writer ALWAYS emits the address node (only its children
  // are maybe_add), so an empty address still yields <tag version="2.0.0"/>.
  const a = address ?? {};
  return {
    '@_version': '2.0.0',
    ...(a.name ? { 'addr:name': a.name } : {}),
    ...(a.addr1 ? { 'addr:addr1': a.addr1 } : {}),
    ...(a.addr2 ? { 'addr:addr2': a.addr2 } : {}),
    ...(a.addr3 ? { 'addr:addr3': a.addr3 } : {}),
    ...(a.addr4 ? { 'addr:addr4': a.addr4 } : {}),
    ...(a.phone ? { 'addr:phone': a.phone } : {}),
    ...(a.fax ? { 'addr:fax': a.fax } : {}),
    ...(a.email ? { 'addr:email': a.email } : {}),
    ...(() => {
      const slots = buildSlotsContainer(a.slots);
      return slots ? { 'addr:slots': slots } : {};
    })(),
  };
}

function parseOwner(raw: unknown): GnuCashOwner | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const type = extractText(obj['owner:type']);
  const id = extractText(obj['owner:id']);
  if (!type || !id) return undefined;
  return { type, id };
}

function buildOwner(owner: GnuCashOwner): Record<string, unknown> {
  return {
    '@_version': '2.0.0',
    'owner:type': owner.type,
    'owner:id': { '@_type': 'guid', '#text': owner.id },
  };
}

/* ============================================================
 * XML -> typed (parsers)
 * ============================================================ */

export interface ParsedBusinessObjects {
  billterms: GnuCashBillTerm[];
  taxtables: GnuCashTaxTable[];
  customers: GnuCashCustomer[];
  vendors: GnuCashVendor[];
  employees: GnuCashEmployee[];
  jobs: GnuCashJob[];
  invoices: GnuCashInvoice[];
  entries: GnuCashEntry[];
  orders: GnuCashOrder[];
}

/** Parse all nine business families out of a gnc:book element. */
export function parseBusinessObjects(
  bookElement: Record<string, unknown>,
  skipped: string[],
): ParsedBusinessObjects {
  return {
    billterms: ensureArray(bookElement['gnc:GncBillTerm'] as unknown)
      .map((raw) => parseBillTerm(raw, skipped))
      .filter((t): t is GnuCashBillTerm => t !== null),
    taxtables: ensureArray(bookElement['gnc:GncTaxTable'] as unknown)
      .map((raw) => parseTaxTable(raw, skipped))
      .filter((t): t is GnuCashTaxTable => t !== null),
    customers: ensureArray(bookElement['gnc:GncCustomer'] as unknown)
      .map((raw) => parseCustomer(raw, skipped))
      .filter((c): c is GnuCashCustomer => c !== null),
    vendors: ensureArray(bookElement['gnc:GncVendor'] as unknown)
      .map((raw) => parseVendor(raw, skipped))
      .filter((v): v is GnuCashVendor => v !== null),
    employees: ensureArray(bookElement['gnc:GncEmployee'] as unknown)
      .map((raw) => parseEmployee(raw, skipped))
      .filter((e): e is GnuCashEmployee => e !== null),
    jobs: ensureArray(bookElement['gnc:GncJob'] as unknown)
      .map((raw) => parseJob(raw, skipped))
      .filter((j): j is GnuCashJob => j !== null),
    invoices: ensureArray(bookElement['gnc:GncInvoice'] as unknown)
      .map((raw) => parseInvoice(raw, skipped))
      .filter((i): i is GnuCashInvoice => i !== null),
    entries: ensureArray(bookElement['gnc:GncEntry'] as unknown)
      .map((raw) => parseEntry(raw, skipped))
      .filter((e): e is GnuCashEntry => e !== null),
    orders: ensureArray(bookElement['gnc:GncOrder'] as unknown)
      .map((raw) => parseOrder(raw, skipped))
      .filter((o): o is GnuCashOrder => o !== null),
  };
}

function parseBillTerm(raw: unknown, skipped: string[]): GnuCashBillTerm | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const guid = extractText(obj['billterm:guid']);
  if (!guid) {
    skipped.push('gnc:GncBillTerm without billterm:guid skipped');
    return null;
  }
  const slots = parseSlotsContainer(obj['billterm:slots'], skipped, `billterm ${guid}`);
  const daysObj = obj['billterm:days'] as Record<string, unknown> | undefined;
  const proxObj = obj['billterm:proximo'] as Record<string, unknown> | undefined;
  const term: GnuCashBillTerm = {
    guid,
    name: extractText(obj['billterm:name']),
    description: extractText(obj['billterm:desc']),
    refcount: parseIntElement(obj['billterm:refcount'], 0),
    invisible: parseIntBool(obj['billterm:invisible'], false),
    ...(optionalGuid(obj['billterm:child']) ? { childId: extractText(obj['billterm:child']) } : {}),
    ...(optionalGuid(obj['billterm:parent'])
      ? { parentId: extractText(obj['billterm:parent']) }
      : {}),
    ...(slots.length > 0 ? { slots } : {}),
  };
  if (daysObj !== undefined) {
    term.days = {
      ...(daysObj && daysObj['bt-days:due-days'] !== undefined
        ? { dueDays: parseIntElement(daysObj['bt-days:due-days'], 0) }
        : {}),
      ...(daysObj && daysObj['bt-days:disc-days'] !== undefined
        ? { discountDays: parseIntElement(daysObj['bt-days:disc-days'], 0) }
        : {}),
      ...(daysObj && optionalNumeric(daysObj['bt-days:discount'])
        ? { discount: extractText(daysObj['bt-days:discount']) }
        : {}),
    };
  } else if (proxObj !== undefined) {
    term.proximo = {
      ...(proxObj && proxObj['bt-prox:due-day'] !== undefined
        ? { dueDay: parseIntElement(proxObj['bt-prox:due-day'], 0) }
        : {}),
      ...(proxObj && proxObj['bt-prox:disc-day'] !== undefined
        ? { discountDay: parseIntElement(proxObj['bt-prox:disc-day'], 0) }
        : {}),
      ...(proxObj && optionalNumeric(proxObj['bt-prox:discount'])
        ? { discount: extractText(proxObj['bt-prox:discount']) }
        : {}),
      ...(proxObj && proxObj['bt-prox:cutoff-day'] !== undefined
        ? { cutoffDay: parseIntElement(proxObj['bt-prox:cutoff-day'], 0) }
        : {}),
    };
  } else {
    // No variant at all — treat as an empty days term so the import can
    // still record it (upstream would reject; be tolerant on read).
    term.days = {};
    skipped.push(`Bill term ${guid} has neither billterm:days nor billterm:proximo — imported as days`);
  }
  return term;
}

function parseTaxTable(raw: unknown, skipped: string[]): GnuCashTaxTable | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const guid = extractText(obj['taxtable:guid']);
  if (!guid) {
    skipped.push('gnc:GncTaxTable without taxtable:guid skipped');
    return null;
  }
  const entriesContainer = obj['taxtable:entries'] as Record<string, unknown> | undefined;
  const entries: GnuCashTaxTableEntry[] = entriesContainer
    ? ensureArray(entriesContainer['gnc:GncTaxTableEntry'] as unknown).map((rawEntry) => {
        const entryObj = (rawEntry ?? {}) as Record<string, unknown>;
        return {
          ...(optionalGuid(entryObj['tte:acct'])
            ? { accountId: extractText(entryObj['tte:acct']) }
            : {}),
          amount: extractText(entryObj['tte:amount']) || '0/1',
          type: extractText(entryObj['tte:type']) || 'VALUE',
        };
      })
    : [];
  const slots = parseSlotsContainer(obj['taxtable:slots'], skipped, `taxtable ${guid}`);
  return {
    guid,
    name: extractText(obj['taxtable:name']),
    refcount: parseIntElement(obj['taxtable:refcount'], 0),
    invisible: parseIntBool(obj['taxtable:invisible'], false),
    ...(optionalGuid(obj['taxtable:child']) ? { childId: extractText(obj['taxtable:child']) } : {}),
    ...(optionalGuid(obj['taxtable:parent'])
      ? { parentId: extractText(obj['taxtable:parent']) }
      : {}),
    entries,
    ...(slots.length > 0 ? { slots } : {}),
  };
}

function parseCustomer(raw: unknown, skipped: string[]): GnuCashCustomer | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const guid = extractText(obj['cust:guid']);
  if (!guid) {
    skipped.push('gnc:GncCustomer without cust:guid skipped');
    return null;
  }
  const slots = parseSlotsContainer(obj['cust:slots'], skipped, `customer ${guid}`);
  return {
    guid,
    name: extractText(obj['cust:name']),
    id: extractText(obj['cust:id']),
    addr: parseAddress(obj['cust:addr'], skipped, `customer ${guid}`),
    shipaddr: parseAddress(obj['cust:shipaddr'], skipped, `customer ${guid} ship`),
    ...(optionalText(obj['cust:notes']) ? { notes: extractText(obj['cust:notes']) } : {}),
    ...(optionalGuid(obj['cust:terms']) ? { termsId: extractText(obj['cust:terms']) } : {}),
    taxIncluded: extractText(obj['cust:taxincluded']) || 'USEGLOBAL',
    active: parseIntBool(obj['cust:active'], true),
    discount: extractText(obj['cust:discount']) || '0/1',
    credit: extractText(obj['cust:credit']) || '0/1',
    // Legacy files may carry cust:commodity instead of cust:currency.
    currency:
      parseCommodityRef(obj['cust:currency']) ??
      parseCommodityRef(obj['cust:commodity']) ?? { space: '', id: '' },
    useTaxTable: parseIntBool(obj['cust:use-tt'], false),
    ...(optionalGuid(obj['cust:taxtable'])
      ? { taxTableId: extractText(obj['cust:taxtable']) }
      : {}),
    ...(slots.length > 0 ? { slots } : {}),
  };
}

function parseVendor(raw: unknown, skipped: string[]): GnuCashVendor | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const guid = extractText(obj['vendor:guid']);
  if (!guid) {
    skipped.push('gnc:GncVendor without vendor:guid skipped');
    return null;
  }
  const slots = parseSlotsContainer(obj['vendor:slots'], skipped, `vendor ${guid}`);
  return {
    guid,
    name: extractText(obj['vendor:name']),
    id: extractText(obj['vendor:id']),
    addr: parseAddress(obj['vendor:addr'], skipped, `vendor ${guid}`),
    ...(optionalText(obj['vendor:notes']) ? { notes: extractText(obj['vendor:notes']) } : {}),
    ...(optionalGuid(obj['vendor:terms']) ? { termsId: extractText(obj['vendor:terms']) } : {}),
    taxIncluded: extractText(obj['vendor:taxincluded']) || 'USEGLOBAL',
    active: parseIntBool(obj['vendor:active'], true),
    currency:
      parseCommodityRef(obj['vendor:currency']) ??
      parseCommodityRef(obj['vendor:commodity']) ?? { space: '', id: '' },
    useTaxTable: parseIntBool(obj['vendor:use-tt'], false),
    ...(optionalGuid(obj['vendor:taxtable'])
      ? { taxTableId: extractText(obj['vendor:taxtable']) }
      : {}),
    ...(slots.length > 0 ? { slots } : {}),
  };
}

function parseEmployee(raw: unknown, skipped: string[]): GnuCashEmployee | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const guid = extractText(obj['employee:guid']);
  if (!guid) {
    skipped.push('gnc:GncEmployee without employee:guid skipped');
    return null;
  }
  const slots = parseSlotsContainer(obj['employee:slots'], skipped, `employee ${guid}`);
  return {
    guid,
    username: extractText(obj['employee:username']),
    id: extractText(obj['employee:id']),
    addr: parseAddress(obj['employee:addr'], skipped, `employee ${guid}`),
    ...(optionalText(obj['employee:language'])
      ? { language: extractText(obj['employee:language']) }
      : {}),
    ...(optionalText(obj['employee:acl']) ? { acl: extractText(obj['employee:acl']) } : {}),
    active: parseIntBool(obj['employee:active'], true),
    workday: extractText(obj['employee:workday']) || '0/1',
    rate: extractText(obj['employee:rate']) || '0/1',
    currency:
      parseCommodityRef(obj['employee:currency']) ??
      parseCommodityRef(obj['employee:commodity']) ?? { space: '', id: '' },
    ...(optionalGuid(obj['employee:ccard'])
      ? { ccardId: extractText(obj['employee:ccard']) }
      : {}),
    ...(slots.length > 0 ? { slots } : {}),
  };
}

function parseJob(raw: unknown, skipped: string[]): GnuCashJob | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const guid = extractText(obj['job:guid']);
  if (!guid) {
    skipped.push('gnc:GncJob without job:guid skipped');
    return null;
  }
  const slots = parseSlotsContainer(obj['job:slots'], skipped, `job ${guid}`);
  const owner = parseOwner(obj['job:owner']);
  return {
    guid,
    id: extractText(obj['job:id']),
    name: extractText(obj['job:name']),
    ...(optionalText(obj['job:reference'])
      ? { reference: extractText(obj['job:reference']) }
      : {}),
    ...(owner ? { owner } : {}),
    active: parseIntBool(obj['job:active'], true),
    ...(slots.length > 0 ? { slots } : {}),
  };
}

function parseInvoice(raw: unknown, skipped: string[]): GnuCashInvoice | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const guid = extractText(obj['invoice:guid']);
  if (!guid) {
    skipped.push('gnc:GncInvoice without invoice:guid skipped');
    return null;
  }
  const slots = parseSlotsContainer(obj['invoice:slots'], skipped, `invoice ${guid}`);
  const owner = parseOwner(obj['invoice:owner']);
  const billTo = parseOwner(obj['invoice:billto']);
  const posted = parseTimestamp(obj['invoice:posted']);
  return {
    guid,
    id: extractText(obj['invoice:id']),
    ...(owner ? { owner } : {}),
    opened: parseTimestamp(obj['invoice:opened']),
    ...(posted ? { posted } : {}),
    ...(optionalGuid(obj['invoice:terms']) ? { termsId: extractText(obj['invoice:terms']) } : {}),
    ...(optionalText(obj['invoice:billing_id'])
      ? { billingId: extractText(obj['invoice:billing_id']) }
      : {}),
    ...(optionalText(obj['invoice:notes']) ? { notes: extractText(obj['invoice:notes']) } : {}),
    active: parseIntBool(obj['invoice:active'], true),
    ...(optionalGuid(obj['invoice:posttxn'])
      ? { postTxnId: extractText(obj['invoice:posttxn']) }
      : {}),
    ...(optionalGuid(obj['invoice:postlot'])
      ? { postLotId: extractText(obj['invoice:postlot']) }
      : {}),
    ...(optionalGuid(obj['invoice:postacc'])
      ? { postAccId: extractText(obj['invoice:postacc']) }
      : {}),
    currency:
      parseCommodityRef(obj['invoice:currency']) ??
      parseCommodityRef(obj['invoice:commodity']) ?? { space: '', id: '' },
    ...(billTo ? { billTo } : {}),
    ...(optionalNumeric(obj['invoice:charge-amt'])
      ? { chargeAmt: extractText(obj['invoice:charge-amt']) }
      : {}),
    ...(slots.length > 0 ? { slots } : {}),
  };
}

function parseEntry(raw: unknown, skipped: string[]): GnuCashEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const guid = extractText(obj['entry:guid']);
  if (!guid) {
    skipped.push('gnc:GncEntry without entry:guid skipped');
    return null;
  }
  const slots = parseSlotsContainer(obj['entry:slots'], skipped, `entry ${guid}`);
  const entered = parseTimestamp(obj['entry:entered']);
  const billTo = parseOwner(obj['entry:billto']);
  return {
    guid,
    date: parseTimestamp(obj['entry:date']),
    ...(entered ? { entered } : {}),
    ...(optionalText(obj['entry:description'])
      ? { description: extractText(obj['entry:description']) }
      : {}),
    ...(optionalText(obj['entry:action']) ? { action: extractText(obj['entry:action']) } : {}),
    ...(optionalText(obj['entry:notes']) ? { notes: extractText(obj['entry:notes']) } : {}),
    ...(optionalNumeric(obj['entry:qty']) ? { quantity: extractText(obj['entry:qty']) } : {}),
    // Customer-invoice side.
    ...(optionalGuid(obj['entry:i-acct']) ? { iAcctId: extractText(obj['entry:i-acct']) } : {}),
    ...(optionalNumeric(obj['entry:i-price']) ? { iPrice: extractText(obj['entry:i-price']) } : {}),
    ...(optionalNumeric(obj['entry:i-discount'])
      ? { iDiscount: extractText(obj['entry:i-discount']) }
      : {}),
    ...(optionalGuid(obj['entry:invoice'])
      ? { invoiceId: extractText(obj['entry:invoice']) }
      : {}),
    ...(optionalText(obj['entry:i-disc-type'])
      ? { iDiscType: extractText(obj['entry:i-disc-type']) }
      : {}),
    ...(optionalText(obj['entry:i-disc-how'])
      ? { iDiscHow: extractText(obj['entry:i-disc-how']) }
      : {}),
    ...(obj['entry:i-taxable'] !== undefined
      ? { iTaxable: parseIntBool(obj['entry:i-taxable'], false) }
      : {}),
    ...(obj['entry:i-taxincluded'] !== undefined
      ? { iTaxIncluded: parseIntBool(obj['entry:i-taxincluded'], false) }
      : {}),
    ...(optionalGuid(obj['entry:i-taxtable'])
      ? { iTaxTableId: extractText(obj['entry:i-taxtable']) }
      : {}),
    // Vendor-bill side.
    ...(optionalGuid(obj['entry:b-acct']) ? { bAcctId: extractText(obj['entry:b-acct']) } : {}),
    ...(optionalNumeric(obj['entry:b-price']) ? { bPrice: extractText(obj['entry:b-price']) } : {}),
    ...(optionalGuid(obj['entry:bill']) ? { billId: extractText(obj['entry:bill']) } : {}),
    ...(obj['entry:billable'] !== undefined
      ? { billable: parseIntBool(obj['entry:billable'], false) }
      : {}),
    ...(billTo ? { billTo } : {}),
    ...(obj['entry:b-taxable'] !== undefined
      ? { bTaxable: parseIntBool(obj['entry:b-taxable'], false) }
      : {}),
    ...(obj['entry:b-taxincluded'] !== undefined
      ? { bTaxIncluded: parseIntBool(obj['entry:b-taxincluded'], false) }
      : {}),
    ...(optionalText(obj['entry:b-pay']) ? { bPayment: extractText(obj['entry:b-pay']) } : {}),
    ...(optionalGuid(obj['entry:b-taxtable'])
      ? { bTaxTableId: extractText(obj['entry:b-taxtable']) }
      : {}),
    ...(optionalGuid(obj['entry:order']) ? { orderId: extractText(obj['entry:order']) } : {}),
    ...(slots.length > 0 ? { slots } : {}),
  };
}

function parseOrder(raw: unknown, skipped: string[]): GnuCashOrder | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const guid = extractText(obj['order:guid']);
  if (!guid) {
    skipped.push('gnc:GncOrder without order:guid skipped');
    return null;
  }
  const slots = parseSlotsContainer(obj['order:slots'], skipped, `order ${guid}`);
  const owner = parseOwner(obj['order:owner']);
  const closed = parseTimestamp(obj['order:closed']);
  return {
    guid,
    id: extractText(obj['order:id']),
    ...(owner ? { owner } : {}),
    opened: parseTimestamp(obj['order:opened']),
    ...(closed ? { closed } : {}),
    ...(optionalText(obj['order:notes']) ? { notes: extractText(obj['order:notes']) } : {}),
    ...(optionalText(obj['order:reference'])
      ? { reference: extractText(obj['order:reference']) }
      : {}),
    active: parseIntBool(obj['order:active'], true),
    ...(slots.length > 0 ? { slots } : {}),
  };
}

/* ============================================================
 * Typed -> XML (builders)
 * ============================================================ */

/** guid child element helper. */
function guidEl(guid: string): Record<string, unknown> {
  return { '@_type': 'guid', '#text': guid };
}

/** timespec child element helper. */
function tsEl(value: string): Record<string, unknown> {
  return { 'ts:date': value };
}

/** 0/1 int boolean encoding used by all business flags. */
function intBool(value: boolean): string {
  return value ? '1' : '0';
}

/** True when a fraction string is a non-zero numeric (maybe_add_numeric). */
function numericNonZero(value: string | undefined): value is string {
  if (!value) return false;
  const num = value.split('/')[0]?.trim();
  return num !== undefined && num !== '' && num !== '0' && num !== '-0';
}

export function buildBillTerm(term: GnuCashBillTerm): Record<string, unknown> {
  const result: Record<string, unknown> = {
    '@_version': '2.0.0',
    'billterm:guid': guidEl(term.guid),
    'billterm:name': term.name,
    'billterm:desc': term.description,
    'billterm:refcount': String(term.refcount),
    'billterm:invisible': intBool(term.invisible),
  };
  // Upstream writer order: slots BEFORE child/parent/variant.
  const slots = buildSlotsContainer(term.slots);
  if (slots) result['billterm:slots'] = slots;
  if (term.childId) result['billterm:child'] = guidEl(term.childId);
  if (term.parentId) result['billterm:parent'] = guidEl(term.parentId);
  if (term.proximo) {
    const p = term.proximo;
    result['billterm:proximo'] = {
      ...(p.dueDay ? { 'bt-prox:due-day': String(p.dueDay) } : {}),
      ...(p.discountDay ? { 'bt-prox:disc-day': String(p.discountDay) } : {}),
      ...(numericNonZero(p.discount) ? { 'bt-prox:discount': p.discount } : {}),
      ...(p.cutoffDay ? { 'bt-prox:cutoff-day': String(p.cutoffDay) } : {}),
    };
  } else {
    const d = term.days ?? {};
    result['billterm:days'] = {
      ...(d.dueDays ? { 'bt-days:due-days': String(d.dueDays) } : {}),
      ...(d.discountDays ? { 'bt-days:disc-days': String(d.discountDays) } : {}),
      ...(numericNonZero(d.discount) ? { 'bt-days:discount': d.discount } : {}),
    };
  }
  return result;
}

export function buildTaxTable(table: GnuCashTaxTable): Record<string, unknown> {
  const result: Record<string, unknown> = {
    '@_version': '2.0.0',
    'taxtable:guid': guidEl(table.guid),
    'taxtable:name': table.name,
    'taxtable:refcount': String(table.refcount),
    'taxtable:invisible': intBool(table.invisible),
  };
  if (table.childId) result['taxtable:child'] = guidEl(table.childId);
  if (table.parentId) result['taxtable:parent'] = guidEl(table.parentId);
  // taxtable:entries is always emitted, even when empty; the entry element
  // itself carries no version attribute.
  result['taxtable:entries'] = {
    ...(table.entries.length > 0
      ? {
          'gnc:GncTaxTableEntry': table.entries.map((entry) => ({
            ...(entry.accountId ? { 'tte:acct': guidEl(entry.accountId) } : {}),
            'tte:amount': entry.amount,
            'tte:type': entry.type,
          })),
        }
      : {}),
  };
  const slots = buildSlotsContainer(table.slots);
  if (slots) result['taxtable:slots'] = slots;
  return result;
}

export function buildCustomer(customer: GnuCashCustomer): Record<string, unknown> {
  const result: Record<string, unknown> = {
    '@_version': '2.0.0',
    'cust:guid': guidEl(customer.guid),
    'cust:name': customer.name,
    'cust:id': customer.id,
    'cust:addr': buildAddress(customer.addr),
    'cust:shipaddr': buildAddress(customer.shipaddr),
    ...(customer.notes ? { 'cust:notes': customer.notes } : {}),
    ...(customer.termsId ? { 'cust:terms': guidEl(customer.termsId) } : {}),
    'cust:taxincluded': customer.taxIncluded,
    'cust:active': intBool(customer.active),
    // discount/credit are ALWAYS emitted (plain gnc_numeric_to_dom_tree,
    // not maybe_add_numeric).
    'cust:discount': customer.discount,
    'cust:credit': customer.credit,
    'cust:currency': {
      'cmdty:space': customer.currency.space,
      'cmdty:id': customer.currency.id,
    },
    'cust:use-tt': intBool(customer.useTaxTable),
    ...(customer.taxTableId ? { 'cust:taxtable': guidEl(customer.taxTableId) } : {}),
  };
  const slots = buildSlotsContainer(customer.slots);
  if (slots) result['cust:slots'] = slots;
  return result;
}

export function buildVendor(vendor: GnuCashVendor): Record<string, unknown> {
  const result: Record<string, unknown> = {
    '@_version': '2.0.0',
    'vendor:guid': guidEl(vendor.guid),
    'vendor:name': vendor.name,
    'vendor:id': vendor.id,
    'vendor:addr': buildAddress(vendor.addr),
    ...(vendor.notes ? { 'vendor:notes': vendor.notes } : {}),
    ...(vendor.termsId ? { 'vendor:terms': guidEl(vendor.termsId) } : {}),
    'vendor:taxincluded': vendor.taxIncluded,
    'vendor:active': intBool(vendor.active),
    'vendor:currency': {
      'cmdty:space': vendor.currency.space,
      'cmdty:id': vendor.currency.id,
    },
    'vendor:use-tt': intBool(vendor.useTaxTable),
    ...(vendor.taxTableId ? { 'vendor:taxtable': guidEl(vendor.taxTableId) } : {}),
  };
  const slots = buildSlotsContainer(vendor.slots);
  if (slots) result['vendor:slots'] = slots;
  return result;
}

export function buildEmployee(employee: GnuCashEmployee): Record<string, unknown> {
  const result: Record<string, unknown> = {
    '@_version': '2.0.0',
    'employee:guid': guidEl(employee.guid),
    'employee:username': employee.username,
    'employee:id': employee.id,
    'employee:addr': buildAddress(employee.addr),
    ...(employee.language ? { 'employee:language': employee.language } : {}),
    ...(employee.acl ? { 'employee:acl': employee.acl } : {}),
    'employee:active': intBool(employee.active),
    // workday/rate are always emitted (plain gnc_numeric_to_dom_tree).
    'employee:workday': employee.workday,
    'employee:rate': employee.rate,
    'employee:currency': {
      'cmdty:space': employee.currency.space,
      'cmdty:id': employee.currency.id,
    },
    ...(employee.ccardId ? { 'employee:ccard': guidEl(employee.ccardId) } : {}),
  };
  const slots = buildSlotsContainer(employee.slots);
  if (slots) result['employee:slots'] = slots;
  return result;
}

export function buildJob(job: GnuCashJob): Record<string, unknown> {
  const result: Record<string, unknown> = {
    '@_version': '2.0.0',
    'job:guid': guidEl(job.guid),
    'job:id': job.id,
    'job:name': job.name,
    ...(job.reference ? { 'job:reference': job.reference } : {}),
    ...(job.owner ? { 'job:owner': buildOwner(job.owner) } : {}),
    'job:active': intBool(job.active),
  };
  const slots = buildSlotsContainer(job.slots);
  if (slots) result['job:slots'] = slots;
  return result;
}

export function buildInvoice(invoice: GnuCashInvoice): Record<string, unknown> {
  const result: Record<string, unknown> = {
    '@_version': '2.0.0',
    'invoice:guid': guidEl(invoice.guid),
    'invoice:id': invoice.id,
    ...(invoice.owner ? { 'invoice:owner': buildOwner(invoice.owner) } : {}),
    'invoice:opened': tsEl(invoice.opened),
    ...(invoice.posted ? { 'invoice:posted': tsEl(invoice.posted) } : {}),
    ...(invoice.termsId ? { 'invoice:terms': guidEl(invoice.termsId) } : {}),
    ...(invoice.billingId ? { 'invoice:billing_id': invoice.billingId } : {}),
    ...(invoice.notes ? { 'invoice:notes': invoice.notes } : {}),
    'invoice:active': intBool(invoice.active),
    ...(invoice.postTxnId ? { 'invoice:posttxn': guidEl(invoice.postTxnId) } : {}),
    ...(invoice.postLotId ? { 'invoice:postlot': guidEl(invoice.postLotId) } : {}),
    ...(invoice.postAccId ? { 'invoice:postacc': guidEl(invoice.postAccId) } : {}),
    'invoice:currency': {
      'cmdty:space': invoice.currency.space,
      'cmdty:id': invoice.currency.id,
    },
    ...(invoice.billTo ? { 'invoice:billto': buildOwner(invoice.billTo) } : {}),
    ...(numericNonZero(invoice.chargeAmt)
      ? { 'invoice:charge-amt': invoice.chargeAmt }
      : {}),
  };
  const slots = buildSlotsContainer(invoice.slots);
  if (slots) result['invoice:slots'] = slots;
  return result;
}

export function buildEntry(entry: GnuCashEntry): Record<string, unknown> {
  const result: Record<string, unknown> = {
    '@_version': '2.0.0',
    'entry:guid': guidEl(entry.guid),
    'entry:date': tsEl(entry.date),
    ...(entry.entered ? { 'entry:entered': tsEl(entry.entered) } : {}),
    ...(entry.description ? { 'entry:description': entry.description } : {}),
    ...(entry.action ? { 'entry:action': entry.action } : {}),
    ...(entry.notes ? { 'entry:notes': entry.notes } : {}),
    ...(numericNonZero(entry.quantity) ? { 'entry:qty': entry.quantity } : {}),
    // Customer-invoice side. Element order matches the upstream writer:
    // i-acct, i-price, i-discount, then the invoice block (invoice,
    // i-disc-type, i-disc-how, i-taxable, i-taxincluded), then i-taxtable.
    ...(entry.iAcctId ? { 'entry:i-acct': guidEl(entry.iAcctId) } : {}),
    ...(numericNonZero(entry.iPrice) ? { 'entry:i-price': entry.iPrice } : {}),
    ...(numericNonZero(entry.iDiscount) ? { 'entry:i-discount': entry.iDiscount } : {}),
    ...(entry.invoiceId
      ? {
          'entry:invoice': guidEl(entry.invoiceId),
          'entry:i-disc-type': entry.iDiscType ?? 'VALUE',
          'entry:i-disc-how': entry.iDiscHow ?? 'PRETAX',
          'entry:i-taxable': intBool(entry.iTaxable ?? false),
          'entry:i-taxincluded': intBool(entry.iTaxIncluded ?? false),
        }
      : {}),
    ...(entry.iTaxTableId ? { 'entry:i-taxtable': guidEl(entry.iTaxTableId) } : {}),
    // Vendor-bill side: b-acct, b-price, then the bill block (bill,
    // billable, billto, b-taxable, b-taxincluded, b-pay), then b-taxtable.
    ...(entry.bAcctId ? { 'entry:b-acct': guidEl(entry.bAcctId) } : {}),
    ...(numericNonZero(entry.bPrice) ? { 'entry:b-price': entry.bPrice } : {}),
    ...(entry.billId
      ? {
          'entry:bill': guidEl(entry.billId),
          'entry:billable': intBool(entry.billable ?? false),
          ...(entry.billTo ? { 'entry:billto': buildOwner(entry.billTo) } : {}),
          'entry:b-taxable': intBool(entry.bTaxable ?? false),
          'entry:b-taxincluded': intBool(entry.bTaxIncluded ?? false),
          ...(entry.bPayment ? { 'entry:b-pay': entry.bPayment } : {}),
        }
      : {}),
    ...(entry.bTaxTableId ? { 'entry:b-taxtable': guidEl(entry.bTaxTableId) } : {}),
    ...(entry.orderId ? { 'entry:order': guidEl(entry.orderId) } : {}),
  };
  const slots = buildSlotsContainer(entry.slots);
  if (slots) result['entry:slots'] = slots;
  return result;
}

export function buildOrder(order: GnuCashOrder): Record<string, unknown> {
  const result: Record<string, unknown> = {
    '@_version': '2.0.0',
    'order:guid': guidEl(order.guid),
    'order:id': order.id,
    ...(order.owner ? { 'order:owner': buildOwner(order.owner) } : {}),
    'order:opened': tsEl(order.opened),
    ...(order.closed ? { 'order:closed': tsEl(order.closed) } : {}),
    ...(order.notes ? { 'order:notes': order.notes } : {}),
    ...(order.reference ? { 'order:reference': order.reference } : {}),
    'order:active': intBool(order.active),
  };
  const slots = buildSlotsContainer(order.slots);
  if (slots) result['order:slots'] = slots;
  return result;
}

/** Sort a family by guid for deterministic emission (qof_object_foreach_sorted). */
export function sortByGuid<T extends { guid: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => (a.guid < b.guid ? -1 : a.guid > b.guid ? 1 : 0));
}

/** addr:slots exists on the wire but has no native column — collect skips. */
export function noteAddressSlotSkips(
  context: string,
  skipped: string[],
  ...addresses: Array<GnuCashAddress | undefined>
): void {
  for (const address of addresses) {
    if (address?.slots?.length) {
      skipped.push(
        `${context}: addr:slots skipped (no native column; the GnuCash SQL backend drops these too)`,
      );
    }
  }
}

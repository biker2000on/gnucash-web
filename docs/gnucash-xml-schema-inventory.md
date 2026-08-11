# GnuCash XML (gnc-v2) Schema Inventory

Derived from the upstream GnuCash C/C++ source at
`C:\Users\biker\projects\gnucash\libgnucash\backend\xml\` (writer functions
`*_dom_tree_create` / `*_to_dom_tree` and the parser handler tables in each
`gnc-*-xml-v2.cpp`), plus the generic encoders in `sixtp-dom-generators.cpp`
and decoders in `sixtp-dom-parsers.cpp`. Compared against this repo's
implementation in `src/lib/gnucash-xml/` (`types.ts`, `parser.ts`,
`importer.ts`, `exporter.ts`, `builder.ts`).

Conventions used below:

- **guid** — element with attribute `type="guid"` and 32 lowercase hex chars
  as text (`guid_to_dom_tree`). The parser also accepts `type="new"`
  (`dom_tree_to_guid`).
- **string** — plain text content (`text_to_dom_tree`); libxml2 entity
  escaping applies.
- **numeric** — `gnc_numeric` rendered as `num/denom` text
  (`gnc_numeric_to_dom_tree`).
- **timespec** — element containing a single `<ts:date>` child,
  `YYYY-MM-DD HH:MM:SS +0000` (`time64_to_dom_tree`).
- **gdate** — element containing a single `<gdate>` child, `YYYY-MM-DD`
  (`gdate_to_dom_tree`).
- **int / guint** — decimal integer text (`int_to_dom_tree`,
  `guint_to_dom_tree`).
- **boolean** — text `TRUE` / `FALSE` (`boolean_to_dom_tree`); parsed
  case-insensitively.
- **cmdty ref** — element with children `<cmdty:space>` and `<cmdty:id>`
  (`commodity_ref_to_dom_tree`).
- **slots** — a KVP frame serialization (see the KVP section).
- *(req)* — the parser's `dom_tree_handler` table marks the tag required; a
  file missing it fails to parse that object.

---

## 1. File skeleton

Source: `io-gncxml-v2.cpp` (`write_v2_header`, `gnc_book_write_to_xml_filehandle_v2`,
`write_book`, `write_counts`).

```
<?xml version="1.0" encoding="utf-8" ?>
<gnc-v2
     xmlns:gnc="http://www.gnucash.org/XML/gnc"
     ... one xmlns per namespace ...>
<gnc:count-data cd:type="book">1</gnc:count-data>
<gnc:book version="2.0.0">
  <book:id type="guid">…</book:id>
  [<book:slots> … </book:slots>]          (only when the book KVP frame is non-empty)
  <gnc:count-data cd:type="commodity">N</gnc:count-data>
  <gnc:count-data cd:type="account">N</gnc:count-data>       (N = 1 + descendants; ROOT included)
  <gnc:count-data cd:type="transaction">N</gnc:count-data>
  <gnc:count-data cd:type="schedxaction">N</gnc:count-data>
  <gnc:count-data cd:type="budget">N</gnc:count-data>
  <gnc:count-data cd:type="price">N</gnc:count-data>
  ... business counts (see below) ...
  ... commodities, pricedb, accounts, transactions,
      template-transactions, schedxactions, budgets,
      business objects ...
</gnc:book>
</gnc-v2>
```

Details:

- **Namespace declarations** (`write_v2_header` + per-plugin `*_ns`
  callbacks): each is written on its own line as
  `xmlns:<p>="http://www.gnucash.org/XML/<p>"`. Core set, in order:
  `gnc act book cd cmdty price slot split sx trn ts fs bgt recurrence lot`.
  Business plugins append: `billterm bt-days bt-prox cust employee entry
  invoice job order owner taxtable tte vendor addr` (registration order).
- **gnc:count-data**: text content is the count; the type lives in the
  attribute literally named `cd:type` — the upstream source itself flags
  this as invalid XML ("BADXML": the prefix is never declared on the
  attribute). Any re-emitter must reproduce it byte-for-byte. Counts are
  emitted **only when non-zero** (`write_counts`: `if (amount != 0)`).
  Full list of `cd:type` values the writer can emit:
  - top level (outside `gnc:book`): `book` (always `1`)
  - inside `gnc:book`: `commodity`, `account`, `transaction`,
    `schedxaction`, `budget`, `price`
  - business registry (type_name of each `GncXmlDataType_t`):
    `gnc:GncCustomer`, `gnc:GncVendor`, `gnc:GncEmployee`, `gnc:GncJob`,
    `gnc:GncInvoice`, `gnc:GncEntry`, `gnc:GncOrder`, `gnc:GncBillTerm`,
    `gnc:GncTaxTable` (the `gnc:Address` and `gnc:Owner` registrations have
    no `get_count`/`write`, so they never appear as counts or as top-level
    elements).
- **Version attributes per element family** (exact writer strings):
  | element | version |
  |---|---|
  | `gnc:book` | `2.0.0` |
  | `gnc:commodity` | `2.0.0` |
  | `gnc:pricedb` | `1` |
  | `gnc:account` | `2.0.0` |
  | `gnc:transaction` | `2.0.0` |
  | `gnc:lot` | `2.0.0` |
  | `gnc:schedxaction` | `2.0.0` (legacy `1.0.0` = freqspec era, read-only) |
  | `gnc:recurrence` / `bgt:recurrence` | `1.0.0` |
  | `gnc:budget` | `2.0.0` |
  | `gnc:GncCustomer/Vendor/Employee/Job/Invoice/Entry/Order/BillTerm/TaxTable` | `2.0.0` |
  | address sub-element (`cust:addr` etc.) | `2.0.0` |
  | owner sub-element (`invoice:owner` etc.) | `2.0.0` |
  | `gnc:GncTaxTableEntry` | (no version attribute) |
  | `gnc:template-transactions` | (no version attribute) |
- **Emission order** inside `gnc:book` (`write_book`): commodities (sorted
  by namespace, then mnemonic), pricedb, full account tree (root first,
  then `gnc_account_get_descendants` order), transactions (account-tree
  traversal, stable order), `gnc:template-transactions` (only if the
  template root has descendants), schedxactions, budgets, then each
  registered business writer (`qof_object_foreach_sorted`).
- File ends `</gnc-v2>\n\n` (trailing blank line).
- The parser also accepts the **pre-book layout** (commodity/account/
  transaction/etc. directly under `gnc-v2`, no `gnc:book`).
- Files may be **gzip-compressed** (magic bytes `\x1f\x8b`); GnuCash
  decompresses itself rather than relying on libxml2.

---

## 2. Element families

### 2.1 Commodity — `gnc:commodity` (`gnc-commodity-xml-v2.cpp`)

Writer skips the element entirely for ISO-4217 currencies that have no
quote flag and no slots (`if (currency && !quote_flag && !slotsnode) return NULL`).

| element | type | emission |
|---|---|---|
| `cmdty:space` | string | always (namespace, e.g. `CURRENCY`, `NASDAQ`, `template`) |
| `cmdty:id` | string | always (mnemonic) |
| `cmdty:name` | string | non-currency only, if fullname set |
| `cmdty:xcode` | string | non-currency only, if cusip non-empty |
| `cmdty:fraction` | int | non-currency only |
| `cmdty:get_quotes` | empty element | only when quote flag set |
| `cmdty:quote_source` | string | inside quote-flag block, if source set (internal name, e.g. `currency`, `yahoo_json`) |
| `cmdty:quote_tz` | string | inside quote-flag block, if tz set |
| `cmdty:slots` | slots | if KVP frame non-empty (e.g. `user_symbol`) |

Parse: space/id are whitespace-stripped; a commodity with no namespace,
no mnemonic, or fraction 0 is rejected. `valid_commodity` requires all
three, so a re-emitter must always write space/id and (for
non-currencies) fraction.

### 2.2 Price DB — `gnc:pricedb` / `price` (`gnc-pricedb-xml-v2.cpp`)

`<gnc:pricedb version="1">` wraps unnamespaced `<price>` children; the
element is omitted entirely when the DB is empty.

| element | type | emission |
|---|---|---|
| `price:id` | guid | always |
| `price:commodity` | cmdty ref | always (writer aborts the price if missing) |
| `price:currency` | cmdty ref | always |
| `price:time` | timespec | always |
| `price:source` | string | if non-empty |
| `price:type` | string | if non-empty |
| `price:value` | numeric | always |

Enum-ish strings (free-form on read, from `gnc-pricedb.cpp source_names` on
write): `user:price-editor`, `Finance::Quote`, `user:price`,
`user:xfer-dialog`, `user:split-register`, `user:split-import`,
`user:stock-split`, `user:stock-transaction`, `user:invoice-post`; legacy
`old-file-import` and arbitrary `user:*` accepted. `price:type` values:
`bid`, `ask`, `last`, `nav`, `transaction`, `unknown`.

### 2.3 Account — `gnc:account` (`gnc-account-xml-v2.cpp`)

| element | type | emission |
|---|---|---|
| `act:name` | string | always *(req)* |
| `act:id` | guid | always *(req)* |
| `act:type` | string | always *(req)* — `NONE BANK CASH CREDIT ASSET LIABILITY STOCK MUTUAL CURRENCY INCOME EXPENSE EQUITY RECEIVABLE PAYABLE ROOT TRADING CHECKING SAVINGS MONEYMRKT CREDITLINE` |
| `act:commodity` | cmdty ref | when the account has a commodity |
| `act:commodity-scu` | int | when the account has a commodity |
| `act:non-standard-scu` | empty element | only when the non-std SCU flag is set |
| `act:code` | string | only when non-empty |
| `act:description` | string | only when non-empty |
| `act:slots` | slots | when KVP frame non-empty (see below) |
| `act:parent` | guid | when a parent exists; modern saves (`allow_incompat = TRUE`, `io-utils.cpp`) write it even for children of ROOT, and write the ROOT account itself |
| `act:lots` | container of `gnc:lot` | only when the account has lots **and not in "export accounts" mode**; lots sorted by guid |
| `act:hidden`, `act:placeholder` | boolean | **parser-only** — the writer has these commented out for 2.2 compat; real files carry hidden/placeholder in `act:slots` as string `"true"` |
| `act:currency`, `act:currency-scu`, `act:security`, `act:security-scu` | — | deprecated gnucash-1.6-era tags, read-only, not preserved |

Well-known `act:slots` keys: `hidden`, `placeholder` (string `"true"`),
`notes` (string), `color`, `tax-related` (integer), `code`,
`last-num`, `reconcile-info/…` (frame: `last-date` integer,
`last-interval/months|days`, `include-children` integer),
`online_id`, `import-map`/`import-map-bayes` (nested frames),
`equity-type`, `payer-name-source`, `tax-US/…`.

### 2.4 Transaction — `gnc:transaction` (`gnc-transaction-xml-v2.cpp`)

| element | type | emission |
|---|---|---|
| `trn:id` | guid | always *(req)* |
| `trn:currency` | cmdty ref | always |
| `trn:num` | string | only when non-empty |
| `trn:date-posted` | timespec | always *(req)* |
| `trn:date-entered` | timespec | always *(req)* |
| `trn:description` | string | whenever non-NULL (empty string still emitted) |
| `trn:slots` | slots | when KVP frame non-empty |
| `trn:splits` | container of `trn:split` | always *(req)* |

Well-known `trn:slots` keys: `date-posted` (gdate — the date-only
authoritative posted date written by modern GnuCash), `notes` (string),
`trans-txn-type` (string, business posting type: `I`/`P` invoice/payment),
`assoc_uri` (string, document links), `from-sched-xaction` (guid of the
SX that generated the transaction), `gncInvoice/invoice-guid` (frame+guid
on posted invoice transactions), `void-*` family (`void-reason`,
`void-time`, `void-former-notes`, per-split `void-former-amount/value`),
`trans-date-due` (timespec, business), `trans-read-only` (string).

#### Split — `trn:split`

| element | type | emission |
|---|---|---|
| `split:id` | guid | always *(req)* |
| `split:memo` | string | only when non-empty |
| `split:action` | string | only when non-empty |
| `split:reconciled-state` | 1-char string | always *(req)* — `n` (new), `c` (cleared), `y` (reconciled), `f` (frozen), `v` (void) |
| `split:reconcile-date` | timespec | only when non-zero |
| `split:value` | numeric | always *(req)* — transaction-currency amount |
| `split:quantity` | numeric | always *(req)* — account-commodity amount |
| `split:account` | guid | always *(req)* |
| `split:lot` | guid | only when the split belongs to a lot |
| `split:slots` | slots | when KVP frame non-empty |

Well-known `split:slots` keys (`Split.cpp`, `kvp_doc.txt`):
`sched-xaction` (frame — template-split formulas, see §3),
`gains-source` / `gains-split` (guid — capital-gains linkage between the
selling split and the gains-recording split; the lot scrub engine in this
repo maintains the DB equivalent), `split-type` (string, `stock-split`),
`void-former-amount` / `void-former-value` (numeric), `online_id`.

### 2.5 Lot — `gnc:lot` (`gnc-lot-xml-v2.cpp`)

Lots appear **only inside `act:lots`** (never top-level in a book file).

| element | type | emission |
|---|---|---|
| `lot:id` | guid | always *(req)* |
| `lot:slots` | slots | when KVP frame non-empty |

Everything else about a lot lives in KVP (`gnc-lot.cpp`):
`title` (string), `notes` (string), and for invoice-posted lots
`gncInvoice/invoice-guid` (frame containing a guid). Lot membership
itself is expressed from the split side via `split:lot`, and closure
state is derived (a lot is closed when its splits' quantities sum to
zero) — there is no `is_closed` element in XML.

### 2.6 Scheduled transaction — `gnc:schedxaction` (`gnc-schedxaction-xml-v2.cpp`)

Modern writer always emits version `2.0.0` (`allow_2_2_incompat = TRUE`).
Version `1.0.0` files use `sx:freqspec` (namespace `fs`,
`gnc-freqspec-xml-v2.cpp`) which is parse-only legacy; on load freqspecs
are converted to recurrences.

| element | type | emission |
|---|---|---|
| `sx:id` | guid | always *(req)* |
| `sx:name` | string | always *(req)* |
| `sx:enabled` | `y`/`n` string | always in v2 files (optional in parser) |
| `sx:autoCreate` | `y`/`n` string | always *(req)* |
| `sx:autoCreateNotify` | `y`/`n` string | always *(req)* |
| `sx:advanceCreateDays` | int | always *(req)* |
| `sx:advanceRemindDays` | int | always *(req)* |
| `sx:instanceCount` | int | always (optional in parser) |
| `sx:start` | gdate | always *(req)* |
| `sx:last` | gdate | only when a last-occur date is valid |
| `sx:num-occur` | int | only when the SX has an occurrence-count definition |
| `sx:rem-occur` | int | paired with `sx:num-occur` |
| `sx:end` | gdate | only when (no occur-def and) an end date exists |
| `sx:templ-acct` | guid | always (template account under `gnc:template-transactions`) |
| `sx:schedule` | container of `gnc:recurrence` | always in v2 files |
| `sx:deferredInstance` | compound, repeatable | one per deferred instance: optional `sx:last` (gdate), `sx:rem-occur` (int), `sx:instanceCount` (int) |
| `sx:slots` | slots | when KVP frame non-empty |
| `sx:freqspec` | legacy compound | v1 files only, read-only |

Note the mutually exclusive trio: either (`sx:num-occur` + `sx:rem-occur`)
or `sx:end`, or neither (no end).

### 2.7 Recurrence — `gnc:recurrence` / `bgt:recurrence` (`gnc-recurrence-xml-v2.cpp`)

Version `1.0.0` on the element.

| element | type | emission |
|---|---|---|
| `recurrence:mult` | guint | always *(req)* |
| `recurrence:period_type` | string | always *(req)* |
| `recurrence:start` | gdate | always *(req)* |
| `recurrence:weekend_adj` | string | **only when not `none`** (2.2-compat) |

Period type strings (`Recurrence.cpp period_type_strings`, order = enum):
`once`, `day`, `week`, `month`, `end of month`, `nth weekday`,
`last weekday`, `year`. Weekend adjust strings: `none`, `back`, `forward`.

### 2.8 Budget — `gnc:budget` (`gnc-budget-xml-v2.cpp`)

| element | type | emission |
|---|---|---|
| `bgt:id` | guid | always *(req)* |
| `bgt:name` | string | always |
| `bgt:description` | string | always (may be empty) |
| `bgt:num-periods` | guint | always *(req)* |
| `bgt:recurrence` | recurrence (version `1.0.0`) | always *(req)* |
| `bgt:slots` | slots | when KVP frame non-empty |

Budget amounts are stored **entirely in `bgt:slots`**: one outer slot per
account (`slot:key` = account guid, `slot:value type="frame"`), whose
inner slots are keyed by period number (`slot:key` = `0`,`1`,…) with
`slot:value type="numeric"` holding the amount. A sibling per-period
`note` frame may appear under a nested `notes` frame slot in newer
GnuCash versions.

### 2.9 Book — `gnc:book` (`gnc-book-xml-v2.cpp`)

| element | type | emission |
|---|---|---|
| `book:id` | guid | always *(req)* |
| `book:slots` | slots | only when the book frame is non-empty |

Well-known `book:slots` keys: `options` (frame — Book Options: Business
company info, Accounts, Budgeting default budget guid, Tax options…),
`features` (frame of feature flags, e.g. `ISO-8601 formatted date strings
in SQLite3 databases.`, `Register sort and filter settings stored in
.gcm file`, `Use a dedicated opening balance account identified by an
equity-type slot`), `counters` (frame — `gncCustomer`, `gncInvoice`,
`gncOrder`, `gncJob`, `gncVendor`, `gncEmployee`, `gncBill` … integer
counters), `counter_formats` (frame of strings), `remove-color-not-set-slots`
(string `true`).

### 2.10 KVP slots — `<slot>` (`sixtp-dom-generators.cpp` / `sixtp-dom-parsers.cpp`)

Serialization of a KVP frame under any `*:slots` element:

```
<slot>
  <slot:key>some-key</slot:key>
  <slot:value type="TYPE">…</slot:value>
</slot>
```

`type` attribute values (parser table `val_converters`; writer
`add_kvp_value_node`):

| type | content encoding |
|---|---|
| `integer` | int64 decimal text |
| `double` | `%24.18g` formatted text (whitespace-stripped) |
| `numeric` | `num/denom` |
| `string` | plain text (may be empty) |
| `guid` | 32-hex text |
| `timespec` | child `<ts:date>YYYY-MM-DD HH:MM:SS +0000</ts:date>` — the attribute stays `timespec` for compatibility even though the engine type is now time64 |
| `gdate` | child `<gdate>YYYY-MM-DD</gdate>` |
| `list` | nested `<slot:value type="…">` children (values only, no keys) |
| `frame` | nested `<slot>` children (full key/value pairs — this is how hierarchical keys like `options/Business/Company Name` are stored) |
| `binary` | **legacy only** — hex string, 2 chars/byte, no whitespace. `string_to_binary` still exists but the v2 parser's converter table has no `binary` entry and the writer never emits it; treat as read-skip |

Frames nest arbitrarily deep. Keys are opaque strings; slashes in engine
paths become nested frames on disk. Writer emits slots in frame iteration
order (`for_each_slot_temp` — sorted by key in current GnuCash).

DB mapping note: the native `slots` table flattens this with
`obj_guid`, `name` (full path using `/` separators), `slot_type` (int
enum: 1=int64, 2=double, 3=numeric, 4=string, 5=guid, 6=timespec,
9=frame, 10=gdate; frames get their own row and children carry
`parent-path/child` names), and per-type value columns
(`int64_val`, `string_val`, `double_val`, `timespec_val`, `guid_val`,
`numeric_val_num/denom`, `gdate_val`).

### 2.11 Address — `cust:addr` / `cust:shipaddr` / `vendor:addr` / `employee:addr` (`gnc-address-xml-v2.cpp`)

Sub-element (tag supplied by the caller), version `2.0.0`. All fields
optional, emitted only when non-empty:
`addr:name`, `addr:addr1`, `addr:addr2`, `addr:addr3`, `addr:addr4`,
`addr:phone`, `addr:fax`, `addr:email` (all string), `addr:slots` (slots).

DB mapping: flattened into `addr_name`, `addr_addr1..4`, `addr_phone`,
`addr_fax`, `addr_email` columns on the owning table.

### 2.12 Owner — `owner:type` + `owner:id` (`gnc-owner-xml-v2.cpp`)

Sub-element (tag supplied by caller: `job:owner`, `invoice:owner`,
`invoice:billto`, `order:owner`, `entry:billto`), version `2.0.0`.

| element | type | notes |
|---|---|---|
| `owner:type` | string *(req)* | one of the QOF ids: `gncCustomer`, `gncJob`, `gncVendor`, `gncEmployee` |
| `owner:id` | guid *(req)* | guid of the referenced entity (forward refs allowed — parser creates a stub) |

DB mapping: `owner_type` (int: 2=customer, 3=job, 4=vendor, 5=employee in
the SQL backend) + `owner_guid` column pairs.

### 2.13 Customer — `gnc:GncCustomer` (`gnc-customer-xml-v2.cpp`)

| element | type | emission |
|---|---|---|
| `cust:guid` | guid | always *(req)* |
| `cust:name` | string | always *(req)* |
| `cust:id` | string | always *(req)* (the human-facing number, e.g. `000001`) |
| `cust:addr` | address | always *(req)* |
| `cust:shipaddr` | address | always *(req)* |
| `cust:notes` | string | only when non-empty |
| `cust:terms` | guid | only when a billterm is set |
| `cust:taxincluded` | string | always *(req)* — `YES` / `NO` / `USEGLOBAL` |
| `cust:active` | int (0/1) | always *(req)* |
| `cust:discount` | numeric | always *(req)* |
| `cust:credit` | numeric | always *(req)* |
| `cust:currency` | cmdty ref | always (parser also accepts legacy `cust:commodity`) |
| `cust:use-tt` | int (0/1) | always |
| `cust:taxtable` | guid | only when a taxtable is set |
| `cust:slots` | slots | when frame non-empty |

Writer-side filter: customers with `refcount == 0` that aren't referenced
are skipped (`customer_should_be_saved`).

### 2.14 Vendor — `gnc:GncVendor` (`gnc-vendor-xml-v2.cpp`)

Same shape as customer minus shipaddr/discount/credit:
`vendor:guid` *(req)*, `vendor:name` *(req)*, `vendor:id` *(req)*,
`vendor:addr` *(req)*, `vendor:notes` (opt), `vendor:terms` (guid, opt),
`vendor:taxincluded` *(req)*, `vendor:active` *(req)*,
`vendor:currency` (legacy alias `vendor:commodity`), `vendor:use-tt`,
`vendor:taxtable` (guid, opt), `vendor:slots`.

### 2.15 Employee — `gnc:GncEmployee` (`gnc-employee-xml-v2.cpp`)

`employee:guid` *(req)*, `employee:username` *(req)*, `employee:id`
*(req)*, `employee:addr` *(req)*, `employee:language` (opt, non-empty),
`employee:acl` (opt, non-empty), `employee:active` *(req)* (int),
`employee:workday` *(req)* (numeric), `employee:rate` *(req)* (numeric),
`employee:currency` (cmdty ref; legacy `employee:commodity`),
`employee:ccard` (guid of credit-card account, opt), `employee:slots`.

### 2.16 Job — `gnc:GncJob` (`gnc-job-xml-v2.cpp`)

`job:guid` *(req)*, `job:id` *(req)*, `job:name` *(req)*,
`job:reference` (opt, non-empty), `job:owner` *(req)* (owner: customer or
vendor), `job:active` *(req)* (int), `job:slots`.

### 2.17 Invoice — `gnc:GncInvoice` (`gnc-invoice-xml-v2.cpp`)

Covers invoices, bills, credit notes and expense vouchers (distinguished
by owner type; credit-note flag lives in slots in 2.6+: key
`credit-note`, integer).

| element | type | emission |
|---|---|---|
| `invoice:guid` | guid | always *(req)* |
| `invoice:id` | string | always *(req)* |
| `invoice:owner` | owner | always *(req)* |
| `invoice:opened` | timespec | always *(req)* |
| `invoice:posted` | timespec | only when posted (INT64_MAX = unset → omitted) |
| `invoice:terms` | guid | only when set |
| `invoice:billing_id` | string | only when non-empty |
| `invoice:notes` | string | only when non-empty |
| `invoice:active` | int (0/1) | always *(req)* |
| `invoice:posttxn` | guid | only when posted (ref to `gnc:transaction`) |
| `invoice:postlot` | guid | only when posted (ref to the AR/AP lot) |
| `invoice:postacc` | guid | only when posted (AR/AP account) |
| `invoice:currency` | cmdty ref | always (legacy alias `invoice:commodity`) |
| `invoice:billto` | owner | only when a bill-to owner is set |
| `invoice:charge-amt` | numeric | only when non-zero |
| `invoice:slots` | slots | when frame non-empty (`credit-note`, doclink) |

### 2.18 Entry — `gnc:GncEntry` (`gnc-entry-xml-v2.cpp`)

Line items for invoices/bills/orders.

| element | type | emission |
|---|---|---|
| `entry:guid` | guid | always *(req)* |
| `entry:date` | timespec | always *(req)* |
| `entry:entered` | timespec | always |
| `entry:description` | string | non-empty only |
| `entry:action` | string | non-empty only (`Hours`, `Material`, `Project` …) |
| `entry:notes` | string | non-empty only |
| `entry:qty` | numeric | non-zero only |
| **customer-invoice side** | | |
| `entry:i-acct` | guid | when income account set |
| `entry:i-price` | numeric | non-zero only |
| `entry:i-discount` | numeric | non-zero only |
| `entry:invoice` | guid | when attached to an invoice |
| `entry:i-disc-type` | string | inside invoice block — `VALUE` / `PERCENT` |
| `entry:i-disc-how` | string | inside invoice block — `PRETAX` / `SAMETIME` / `POSTTAX` |
| `entry:i-taxable` | int (0/1) | inside invoice block |
| `entry:i-taxincluded` | int (0/1) | inside invoice block |
| `entry:i-taxtable` | guid | when set |
| **vendor-bill side** | | |
| `entry:b-acct` | guid | when expense account set |
| `entry:b-price` | numeric | non-zero only |
| `entry:bill` | guid | when attached to a bill |
| `entry:billable` | int (0/1) | inside bill block |
| `entry:billto` | owner | inside bill block, when set |
| `entry:b-taxable` | int (0/1) | inside bill block |
| `entry:b-taxincluded` | int (0/1) | inside bill block |
| `entry:b-pay` | string | inside bill block — `CASH` / `CARD` (employee vouchers) |
| `entry:b-taxtable` | guid | when set |
| **other** | | |
| `entry:order` | guid | when attached to an order |
| `entry:slots` | slots | when frame non-empty |

### 2.19 Order — `gnc:GncOrder` (`gnc-order-xml-v2.cpp`)

`order:guid` *(req)*, `order:id` *(req)*, `order:owner` *(req)*,
`order:opened` *(req)* (timespec), `order:closed` (timespec, only when
set), `order:notes` (opt), `order:reference` (opt), `order:active`
*(req)* (int), `order:slots`.

### 2.20 Bill term — `gnc:GncBillTerm` (`gnc-bill-term-xml-v2.cpp`)

| element | type | emission |
|---|---|---|
| `billterm:guid` | guid | always *(req)* |
| `billterm:name` | string | always *(req)* |
| `billterm:desc` | string | always *(req)* |
| `billterm:refcount` | int | always *(req)* |
| `billterm:invisible` | int (0/1) | always *(req)* |
| `billterm:slots` | slots | when frame non-empty |
| `billterm:child` | guid | when a child clone exists (posted-doc copies) |
| `billterm:parent` | guid | when this is a child clone |
| `billterm:days` | compound | when type = DAYS: `bt-days:due-days` (int, opt), `bt-days:disc-days` (int, opt), `bt-days:discount` (numeric, opt — `maybe_add_int`/`maybe_add_numeric` skip zeros) |
| `billterm:proximo` | compound | when type = PROXIMO: `bt-prox:due-day`, `bt-prox:disc-day` (int, opt), `bt-prox:discount` (numeric, opt), `bt-prox:cutoff-day` (int, opt) |

Exactly one of `billterm:days` / `billterm:proximo` appears; it doubles as
the type discriminator (DB `billterms.type` int).

### 2.21 Tax table — `gnc:GncTaxTable` + `gnc:GncTaxTableEntry` (`gnc-tax-table-xml-v2.cpp`)

Table: `taxtable:guid` *(req)*, `taxtable:name` *(req)*,
`taxtable:refcount` *(req)* (int), `taxtable:invisible` *(req)* (int
0/1), `taxtable:child` (guid, opt), `taxtable:parent` (guid, opt),
`taxtable:entries` *(req)* — container of `gnc:GncTaxTableEntry` —
and `taxtable:slots` (opt).

Entry (no version attribute): `tte:acct` (guid, optional in writer but
required in practice), `tte:amount` (numeric) *(req)*, `tte:type`
(string `VALUE` / `PERCENT`) *(req)*.

---

## 3. Template transactions

Source: `io-gncxml-v2.cpp write_template_transaction_data`,
`gnc-schedxaction-xml-v2.cpp` (tt handlers), `Split.cpp` (KVP keys),
`kvp_doc.txt`.

```
<gnc:template-transactions>
  <gnc:account version="2.0.0"> … template ROOT … </gnc:account>
  <gnc:account version="2.0.0"> … one per SX (name = SX guid string) … </gnc:account>
  <gnc:transaction version="2.0.0"> … template transactions … </gnc:transaction>
</gnc:template-transactions>
```

- Emitted only when the template root has descendants. Content is the
  ordinary account/transaction serialization — template accounts use the
  `template` namespace commodity (`cmdty:space` = `template`,
  `cmdty:id` = `template`, fraction 1).
- Each SX's `sx:templ-acct` guid points at one of these accounts; the
  template transactions live "in" that account via their splits.
- Template splits carry zero value/quantity; the real payload is in
  `split:slots` under one frame slot:
  - `slot:key` = `sched-xaction`, `slot:value type="frame"` containing:
    - `account` — guid — the target (xfrm) account for this split
    - `credit-formula` — string — formula for the credit side (may be empty)
    - `debit-formula` — string — formula for the debit side (one of the two is empty)
    - `credit-numeric` — numeric — parsed numeric value of the credit formula (present since 2.6; absent in older files)
    - `debit-numeric` — numeric — ditto for debit
    - (`shares` — numeric — appears for stock templates)
- Transactions created *from* an SX carry `from-sched-xaction` (guid) in
  `trn:slots`.

DB mapping: the same structure exists in the native SQL schema — template
accounts and transactions are ordinary `accounts` / `transactions` /
`splits` rows under `books.root_template_guid`, and the sched-xaction
frame becomes `slots` rows named `sched-xaction/account`,
`sched-xaction/credit-formula`, etc.

---

## 4. Coverage table

DB column names refer to the native GnuCash PostgreSQL schema, which this
app uses via Prisma (`prisma/schema.prisma` — models exist for every
native table listed below, including `slots`, `lots`, `schedxactions`,
`recurrences`, and all business tables).

Status refers to `src/lib/gnucash-xml/` (parser + importer for reads,
exporter + builder for writes).

| XML element(s) | DB representation | Current status | Recommended disposition |
|---|---|---|---|
| `gnc-v2` header + namespaces | — | **partial** — builder emits core 15 namespaces; missing all business ns (`cust`, `vendor`, `employee`, `job`, `invoice`, `entry`, `order`, `owner`, `billterm`, `bt-days`, `bt-prox`, `taxtable`, `tte`, `addr`) | implement — add the business namespaces once business objects are emitted; harmless to always declare |
| `gnc:count-data` | — (derived) | **partial** — parses `cd:type`; builder writes book/account/transaction/commodity/budget but not `schedxaction`, `price`, or business counts, and does not skip-if-zero | implement — counts must match emitted objects and be omitted when zero, or GnuCash shows a mismatch warning |
| `gnc:book` / `book:id` | `books.guid` | supported | — |
| `book:slots` (options, counters, features) | `slots` rows (`obj_guid` = book guid) | **unsupported** — dropped on import, never exported | implement via generic slot passthrough — losing `counters` breaks invoice/customer numbering after round-trip; losing `features` may make GnuCash re-prompt |
| `gnc:commodity` | `commodities` | supported (name, xcode, fraction, quote fields); `cmdty:slots` dropped; `get_quotes` flag parse is buggy (parseInt of empty element → NaN) | implement — fix quote-flag parse; slot passthrough for `user_symbol` |
| `gnc:pricedb` / `price` | `prices` | supported | — |
| `gnc:account` core fields | `accounts` | supported (name/id/type/commodity/scu/code/description/parent) | — |
| `act:non-standard-scu` | `accounts.non_std_scu` | **unsupported** (hardcoded 0 on import; never emitted) | implement — one flag, column already exists |
| `act:slots` | `slots` rows | **partial** — only `hidden`, `placeholder`, `notes` extracted (mapped to columns); every other key (color, tax-related, reconcile-info, online_id, import maps) dropped; export re-synthesizes only those three | implement generic slot passthrough; keep the three column mirrors |
| `act:lots` / `gnc:lot` / `lot:slots` | `lots` (+ `slots` for title/notes/invoice link) | **partial/lossy** — importer never parses `gnc:lot` elements; it only *infers* bare lot rows from `split:lot` refs (`is_closed` always 0, title/notes lost). Exporter loses lots entirely (see split:lot below) | implement — the app itself writes lot links + notes (lot-scrub engine); this is user-created data |
| `gnc:transaction` core | `transactions` | supported | — |
| `trn:slots` | `slots` rows | **unsupported** — dropped; includes `date-posted` gdate (authoritative date), `notes`, `from-sched-xaction`, invoice links, void data | implement passthrough; at minimum honor `date-posted` gdate on import and re-emit it on export |
| `trn:split` core | `splits` | supported | — |
| `split:lot` | `splits.lot_guid` | **partial** — imported correctly; **export is broken**: `exporter.ts` sets `lot_guid` on the split object but `types.ts`/`builder.ts` read `lotId`, so `split:lot` is silently never emitted | implement — rename the field (`exporter.ts` line ~197) so exports keep lot membership |
| `split:slots` (gains-source/gains-split, sched-xaction frame) | `slots` rows | **unsupported** — dropped both directions | implement passthrough — the scrub engine's gains links round-trip through these keys in GnuCash desktop |
| `gnc:schedxaction` (all `sx:*`) | `schedxactions` + `recurrences` (`obj_guid` = sx guid) | **unsupported** — not parsed, not exported | implement — table exists, app has full SX feature set; losing SXs on import/export is a visible regression |
| `gnc:template-transactions` | accounts/transactions/splits under `books.root_template_guid` + `sched-xaction/*` slot rows | **unsupported** (also: importer sets `root_template_guid` = root account guid instead of a distinct template root) | implement together with schedxactions — SXs are useless without their templates |
| `gnc:recurrence` (inside sx/budget) | `recurrences` | **partial** — budget recurrence parsed (mult, period_type, start) but `recurrence:weekend_adj` ignored (hardcoded `none` on import) and never emitted on export | implement — read/write weekend_adj when ≠ none |
| `gnc:budget` + amount slots | `budgets`, `budget_amounts`, `recurrences` | supported (amounts via frame slots both directions) | — (note: non-amount `bgt:slots` such as per-period notes are dropped — record-as-skipped) |
| Book-level KVP everywhere (`*:slots` generally) | `slots` | **unsupported** except the special cases above | implement one generic KVP<->slots codec (types: integer, double, numeric, string, guid, timespec, gdate, list, frame) and reuse it for every family |
| `gnc:GncCustomer` | `customers` (+ ownership shadow table) | **unsupported** in XML layer (DB + app features exist) | implement — app has AR/AP business features; import should populate them |
| `gnc:GncVendor` | `vendors` | **unsupported** | implement (same) |
| `gnc:GncEmployee` | `employees` | **unsupported** | implement or record-as-skipped with count (app has no employee UI yet) |
| `gnc:GncJob` | `jobs` | **unsupported** | implement alongside customer/vendor |
| `gnc:GncInvoice` (incl. posttxn/postlot/postacc refs) | `invoices` | **unsupported** | implement — posted invoices reference transactions and lots, so import order matters (after txns/lots) |
| `gnc:GncEntry` (all i-*/b-* fields) | `entries` | **unsupported** | implement with invoices |
| `gnc:GncOrder` | `orders` | **unsupported** | record-as-skipped (orders are near-dead in GnuCash UI); passthrough acceptable |
| `gnc:GncBillTerm` (days/proximo) | `billterms` | **unsupported** | implement — referenced by customers/vendors/invoices |
| `gnc:GncTaxTable` + `gnc:GncTaxTableEntry` | `taxtables`, `taxtable_entries` | **unsupported** | implement — referenced by customers/vendors/entries |
| owner sub-elements (`owner:type`/`owner:id`) | `owner_type`+`owner_guid` column pairs | **unsupported** | implement with business objects (string→int type mapping needed) |
| address sub-elements (`addr:*`) | `addr_*` columns | **unsupported** | implement with business objects |
| `sx:freqspec` (v1 legacy, `fs:` ns) | — (converted to recurrences upstream) | **unsupported** | record-as-skipped — legacy pre-2.2 files only; upstream converts on load, we can refuse gracefully |
| `act:currency`/`act:security` legacy tags | — | **unsupported** | record-as-skipped (1.6-era files) |

Additional importer deviations worth noting (not schema gaps, but
round-trip hazards):

- Import discards the XML ROOT account and re-creates its own (`Root
  Account`), remapping children — original root guid and its slots are
  lost, and `root_template_guid` is set to the *root account* guid rather
  than a separate template root.
- Commodity guids are regenerated (matched by namespace:mnemonic), which
  is correct for the shared-commodity model but means exported files
  never carry the original commodity slot data.
- Export builds `gnc:pricedb` with `@_version: '1'` and prices as a plain
  array — matches upstream.

---

## 5. Encoding notes

- **XML declaration**: exactly `<?xml version="1.0" encoding="utf-8" ?>`
  (lower-case utf-8, space before `?>`). All content must be valid UTF-8
  (`checked_char_cast` aborts the element otherwise).
- **timespec**: `GncDateTime::format_iso8601()` → `YYYY-MM-DD HH:MM:SS`
  with a literal ` +0000` appended ("to mollify GnuCash for Android") —
  times are always serialized in UTC. On parse, any RFC-822-style zone
  offset is honored (`gnc_iso8601_to_time64_gmt`); old files may contain
  e.g. `Mon, 05 Jun 2000 23:16:19 -0500` and a `<ts:ns>` sibling
  (ignored). Exactly one `ts:date` child is permitted. An invalid or
  INT64_MAX time64 means the writer omits the element (`maybe_add_time64`,
  `order:closed`, `invoice:posted`).
- **gdate**: `%Y-%m-%d` inside a `<gdate>` child; parsed with
  `sscanf("%d-%d-%d")`, so zero-padding is conventional not required.
- **gnc:numeric**: `num/denom` as two signed 64-bit decimals joined by
  `/`. Denominators are arbitrary positive ints (GCD-reduced fractions
  occur — never assume powers of ten; see CLAUDE.md note). Parse failure
  → treated as 0/1 (`dom_tree_to_gnc_numeric` returns zero on check
  failure).
- **guid**: 32 lowercase hex characters, no dashes; carried on elements
  with `type="guid"` (accept `type="new"` when reading old files).
- **booleans**: three different conventions coexist — `TRUE`/`FALSE`
  elements (act:hidden/placeholder), `y`/`n` single chars (all `sx:*`
  flags), and `0`/`1` integers (all business `*:active`, `*:use-tt`,
  taxable/taxincluded flags). Do not normalize across them.
- **string escaping**: standard libxml2 (`&amp; &lt; &gt;`; `&quot;` in
  attributes; raw UTF-8 elsewhere). Empty-string children: `<foo/>` or
  `<foo></foo>` both parse to `""` (`dom_tree_to_text` returns "" for a
  childless node).
- **doubles**: `%24.18g`, then whitespace-stripped.
- **Omitted-when-default fields** a naive re-emitter gets wrong:
  count-data entries for zero counts; `recurrence:weekend_adj` when
  `none`; `trn:num`, `split:memo`, `split:action`, `act:code`,
  `act:description` when empty; `split:reconcile-date` when 0;
  ISO-currency commodities without quotes/slots (not written at all);
  `cmdty:name`/`xcode`/`fraction` for currencies; every business
  `maybe_add_*` field (zero numerics and empty strings are skipped);
  `bt-days`/`bt-prox` zero ints; `sx:last`/`sx:end`/`sx:num-occur`
  conditionality; `invoice:posted`/`posttxn`/`postlot`/`postacc` only
  when posted; `act:lots` omitted in "export accounts" mode.
- **Layout quirks**: the writer dumps each top-level element with
  `xmlElemDump` followed by `\n` — elements are *not* uniformly indented
  the way pricedb children are (pricedb children get 2-space indent via a
  custom output buffer). Round-trip diffs should be whitespace-tolerant.
  File ends with `</gnc-v2>` and a trailing blank line.
- **cd:type BADXML**: the `cd:type` attribute uses an undeclared prefix on
  purpose (upstream comment). Emit it literally; do not "fix" it to
  `type` — GnuCash's parser looks up the literal attribute name
  `cd:type`.
- **gzip**: `.gnucash` files are usually gzipped (per user preference);
  detect via magic bytes `\x1f\x8b`, not extension. (The repo's parser
  already does this; the builder offers `compressGnuCashXml`.)
- **Ordering constraints on read**: upstream tolerates any order via the
  handler tables, but on *write* parents must precede children
  (accounts), commodities precede everything referencing them, lots are
  defined under accounts before transactions reference them via
  `split:lot`, billterms/taxtables precede customers (upstream actually
  writes business objects last and resolves forward refs with
  find-or-create stubs — an importer must support forward references for
  `*:terms`, `*:taxtable`, owner refs, and `entry:invoice`).

---

## 6. Implementation priorities (by user-data-loss risk)

1. **KVP slots passthrough + lots** (highest): a generic `<slot>` codec
   feeding the native `slots` table, plus real `act:lots`/`gnc:lot`
   parsing and emission. The app *itself* creates this data (lot links,
   lot titles/notes, gains-source/gains-split via the lot-scrub engine,
   account notes/color, transaction notes, `date-posted` gdate). Today an
   XML round-trip destroys it — and the exporter's `lot_guid`-vs-`lotId`
   field mismatch (exporter.ts ~line 197) means even the split→lot links
   are dropped on export. Fix the field mismatch first; it is a
   one-line bug.
2. **Scheduled transactions + template transactions**: `schedxactions`
   and `recurrences` tables exist and the app has a full SX feature
   surface (execute/skip/create). Importing a desktop book currently
   silently loses every SX; exporting loses the schedules the user built
   in the app. Requires template-account/transaction handling and the
   `sched-xaction` split-slot frame (depends on item 1's slot codec).
3. **Business objects**: billterms and taxtables first (leaf
   dependencies), then customers/vendors/jobs, then invoices/entries
   (which additionally reference posted transactions and lots). All
   native tables exist and the app's AR/AP roadmap is approved. Employee
   and order can trail.
4. **Book slots** (`options`, `counters`, `features`): needed for
   faithful round-trip (invoice numbering counters live here); simple
   once the slot codec exists.
5. **Passthrough / record-as-skipped candidates** (lowest): `sx:freqspec`
   v1 legacy files, `act:currency`/`act:security` 1.6-era tags,
   `gnc:GncOrder`, per-period budget note slots, `binary` KVP type.
   Surface these in `ImportSummary.skipped` with counts rather than
   modeling them.

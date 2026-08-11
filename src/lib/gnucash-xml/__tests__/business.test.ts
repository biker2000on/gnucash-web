import { describe, it, expect } from 'vitest';
import { parseGnuCashXml } from '../parser';
import { buildGnuCashXml } from '../builder';

/**
 * Business fixture (wave 3): a billterm (days variant), a taxtable with two
 * entries, a customer (shipaddr, terms + taxtable refs, credit/discount), a
 * vendor, an employee, a job owned by the customer, a POSTED invoice
 * (owner=job) referencing a real transaction/lot/account, a vendor bill,
 * two entries (one invoice-side with i-* fields incl. discount, one
 * bill-side with b-* fields incl. b-pay), and an order.
 *
 * Business objects reference each other forwards and backwards — upstream
 * writes them last and allows refs in any direction.
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
     xmlns:lot="http://www.gnucash.org/XML/lot"
     xmlns:billterm="http://www.gnucash.org/XML/billterm"
     xmlns:bt-days="http://www.gnucash.org/XML/bt-days"
     xmlns:bt-prox="http://www.gnucash.org/XML/bt-prox"
     xmlns:cust="http://www.gnucash.org/XML/cust"
     xmlns:employee="http://www.gnucash.org/XML/employee"
     xmlns:entry="http://www.gnucash.org/XML/entry"
     xmlns:invoice="http://www.gnucash.org/XML/invoice"
     xmlns:job="http://www.gnucash.org/XML/job"
     xmlns:order="http://www.gnucash.org/XML/order"
     xmlns:owner="http://www.gnucash.org/XML/owner"
     xmlns:taxtable="http://www.gnucash.org/XML/taxtable"
     xmlns:tte="http://www.gnucash.org/XML/tte"
     xmlns:vendor="http://www.gnucash.org/XML/vendor"
     xmlns:addr="http://www.gnucash.org/XML/addr">
<gnc:count-data cd:type="book">1</gnc:count-data>
<gnc:book version="2.0.0">
<book:id type="guid">b00k0000000000000000000000000002</book:id>
<gnc:count-data cd:type="commodity">1</gnc:count-data>
<gnc:count-data cd:type="account">5</gnc:count-data>
<gnc:count-data cd:type="transaction">1</gnc:count-data>
<gnc:count-data cd:type="gnc:GncBillTerm">1</gnc:count-data>
<gnc:count-data cd:type="gnc:GncCustomer">1</gnc:count-data>
<gnc:count-data cd:type="gnc:GncEmployee">1</gnc:count-data>
<gnc:count-data cd:type="gnc:GncEntry">2</gnc:count-data>
<gnc:count-data cd:type="gnc:GncInvoice">2</gnc:count-data>
<gnc:count-data cd:type="gnc:GncJob">1</gnc:count-data>
<gnc:count-data cd:type="gnc:GncOrder">1</gnc:count-data>
<gnc:count-data cd:type="gnc:GncTaxTable">1</gnc:count-data>
<gnc:count-data cd:type="gnc:GncVendor">1</gnc:count-data>
<gnc:commodity version="2.0.0">
  <cmdty:space>CURRENCY</cmdty:space>
  <cmdty:id>USD</cmdty:id>
</gnc:commodity>
<gnc:account version="2.0.0">
  <act:name>Root Account</act:name>
  <act:id type="guid">r00t0000000000000000000000000002</act:id>
  <act:type>ROOT</act:type>
</gnc:account>
<gnc:account version="2.0.0">
  <act:name>Accounts Receivable</act:name>
  <act:id type="guid">acc10000000000000000000000000001</act:id>
  <act:type>RECEIVABLE</act:type>
  <act:commodity><cmdty:space>CURRENCY</cmdty:space><cmdty:id>USD</cmdty:id></act:commodity>
  <act:commodity-scu>100</act:commodity-scu>
  <act:parent type="guid">r00t0000000000000000000000000002</act:parent>
  <act:lots>
    <gnc:lot version="2.0.0">
      <lot:id type="guid">l0t00000000000000000000000000001</lot:id>
      <lot:slots>
        <slot>
          <slot:key>title</slot:key>
          <slot:value type="string">Invoice 000001</slot:value>
        </slot>
      </lot:slots>
    </gnc:lot>
  </act:lots>
</gnc:account>
<gnc:account version="2.0.0">
  <act:name>Consulting Income</act:name>
  <act:id type="guid">acc10000000000000000000000000002</act:id>
  <act:type>INCOME</act:type>
  <act:commodity><cmdty:space>CURRENCY</cmdty:space><cmdty:id>USD</cmdty:id></act:commodity>
  <act:commodity-scu>100</act:commodity-scu>
  <act:parent type="guid">r00t0000000000000000000000000002</act:parent>
</gnc:account>
<gnc:account version="2.0.0">
  <act:name>Supplies Expense</act:name>
  <act:id type="guid">acc10000000000000000000000000003</act:id>
  <act:type>EXPENSE</act:type>
  <act:commodity><cmdty:space>CURRENCY</cmdty:space><cmdty:id>USD</cmdty:id></act:commodity>
  <act:commodity-scu>100</act:commodity-scu>
  <act:parent type="guid">r00t0000000000000000000000000002</act:parent>
</gnc:account>
<gnc:account version="2.0.0">
  <act:name>Sales Tax Liability</act:name>
  <act:id type="guid">acc10000000000000000000000000004</act:id>
  <act:type>LIABILITY</act:type>
  <act:commodity><cmdty:space>CURRENCY</cmdty:space><cmdty:id>USD</cmdty:id></act:commodity>
  <act:commodity-scu>100</act:commodity-scu>
  <act:parent type="guid">r00t0000000000000000000000000002</act:parent>
</gnc:account>
<gnc:transaction version="2.0.0">
  <trn:id type="guid">t2n00000000000000000000000000001</trn:id>
  <trn:currency><cmdty:space>CURRENCY</cmdty:space><cmdty:id>USD</cmdty:id></trn:currency>
  <trn:date-posted><ts:date>2024-03-01 10:59:00 +0000</ts:date></trn:date-posted>
  <trn:date-entered><ts:date>2024-03-01 10:59:00 +0000</ts:date></trn:date-entered>
  <trn:description>Invoice 000001 posted</trn:description>
  <trn:splits>
    <trn:split>
      <split:id type="guid">sp100000000000000000000000000001</split:id>
      <split:reconciled-state>n</split:reconciled-state>
      <split:value>50000/100</split:value>
      <split:quantity>50000/100</split:quantity>
      <split:account type="guid">acc10000000000000000000000000001</split:account>
      <split:lot type="guid">l0t00000000000000000000000000001</split:lot>
    </trn:split>
    <trn:split>
      <split:id type="guid">sp100000000000000000000000000002</split:id>
      <split:reconciled-state>n</split:reconciled-state>
      <split:value>-50000/100</split:value>
      <split:quantity>-50000/100</split:quantity>
      <split:account type="guid">acc10000000000000000000000000002</split:account>
    </trn:split>
  </trn:splits>
</gnc:transaction>
<gnc:GncBillTerm version="2.0.0">
  <billterm:guid type="guid">bt100000000000000000000000000001</billterm:guid>
  <billterm:name>Net 30</billterm:name>
  <billterm:desc>Payable within 30 days</billterm:desc>
  <billterm:refcount>2</billterm:refcount>
  <billterm:invisible>0</billterm:invisible>
  <billterm:days>
    <bt-days:due-days>30</bt-days:due-days>
    <bt-days:disc-days>10</bt-days:disc-days>
    <bt-days:discount>200/100</bt-days:discount>
  </billterm:days>
</gnc:GncBillTerm>
<gnc:GncCustomer version="2.0.0">
  <cust:guid type="guid">cu100000000000000000000000000001</cust:guid>
  <cust:name>Acme Anvils</cust:name>
  <cust:id>000001</cust:id>
  <cust:addr version="2.0.0">
    <addr:name>Wile E. Coyote</addr:name>
    <addr:addr1>1 Desert Rd</addr:addr1>
    <addr:phone>555-0100</addr:phone>
    <addr:email>wile@acme.example</addr:email>
  </cust:addr>
  <cust:shipaddr version="2.0.0">
    <addr:name>Acme Receiving</addr:name>
    <addr:addr1>2 Canyon Way</addr:addr1>
  </cust:shipaddr>
  <cust:notes>Prefers email invoices</cust:notes>
  <cust:terms type="guid">bt100000000000000000000000000001</cust:terms>
  <cust:taxincluded>NO</cust:taxincluded>
  <cust:active>1</cust:active>
  <cust:discount>500/10000</cust:discount>
  <cust:credit>100000/100</cust:credit>
  <cust:currency><cmdty:space>CURRENCY</cmdty:space><cmdty:id>USD</cmdty:id></cust:currency>
  <cust:use-tt>1</cust:use-tt>
  <cust:taxtable type="guid">tt100000000000000000000000000001</cust:taxtable>
</gnc:GncCustomer>
<gnc:GncEmployee version="2.0.0">
  <employee:guid type="guid">em100000000000000000000000000001</employee:guid>
  <employee:username>rrunner</employee:username>
  <employee:id>000001</employee:id>
  <employee:addr version="2.0.0">
    <addr:name>Road Runner</addr:name>
    <addr:addr1>3 Mesa Blvd</addr:addr1>
  </employee:addr>
  <employee:language>en</employee:language>
  <employee:active>1</employee:active>
  <employee:workday>8/1</employee:workday>
  <employee:rate>2500/100</employee:rate>
  <employee:currency><cmdty:space>CURRENCY</cmdty:space><cmdty:id>USD</cmdty:id></employee:currency>
  <employee:ccard type="guid">acc10000000000000000000000000003</employee:ccard>
</gnc:GncEmployee>
<gnc:GncEntry version="2.0.0">
  <entry:guid type="guid">en100000000000000000000000000001</entry:guid>
  <entry:date><ts:date>2024-03-01 10:59:00 +0000</ts:date></entry:date>
  <entry:entered><ts:date>2024-03-01 11:00:00 +0000</ts:date></entry:entered>
  <entry:description>Consulting hours</entry:description>
  <entry:action>Hours</entry:action>
  <entry:qty>5/1</entry:qty>
  <entry:i-acct type="guid">acc10000000000000000000000000002</entry:i-acct>
  <entry:i-price>10000/100</entry:i-price>
  <entry:i-discount>500/100</entry:i-discount>
  <entry:invoice type="guid">iv100000000000000000000000000001</entry:invoice>
  <entry:i-disc-type>VALUE</entry:i-disc-type>
  <entry:i-disc-how>PRETAX</entry:i-disc-how>
  <entry:i-taxable>1</entry:i-taxable>
  <entry:i-taxincluded>0</entry:i-taxincluded>
  <entry:i-taxtable type="guid">tt100000000000000000000000000001</entry:i-taxtable>
</gnc:GncEntry>
<gnc:GncEntry version="2.0.0">
  <entry:guid type="guid">en100000000000000000000000000002</entry:guid>
  <entry:date><ts:date>2024-03-05 10:59:00 +0000</ts:date></entry:date>
  <entry:entered><ts:date>2024-03-05 11:00:00 +0000</ts:date></entry:entered>
  <entry:description>Anvil supplies</entry:description>
  <entry:qty>3/1</entry:qty>
  <entry:b-acct type="guid">acc10000000000000000000000000003</entry:b-acct>
  <entry:b-price>2000/100</entry:b-price>
  <entry:bill type="guid">iv100000000000000000000000000002</entry:bill>
  <entry:billable>1</entry:billable>
  <entry:billto version="2.0.0">
    <owner:type>gncCustomer</owner:type>
    <owner:id type="guid">cu100000000000000000000000000001</owner:id>
  </entry:billto>
  <entry:b-taxable>0</entry:b-taxable>
  <entry:b-taxincluded>0</entry:b-taxincluded>
  <entry:b-pay>CARD</entry:b-pay>
</gnc:GncEntry>
<gnc:GncInvoice version="2.0.0">
  <invoice:guid type="guid">iv100000000000000000000000000001</invoice:guid>
  <invoice:id>000001</invoice:id>
  <invoice:owner version="2.0.0">
    <owner:type>gncJob</owner:type>
    <owner:id type="guid">jb100000000000000000000000000001</owner:id>
  </invoice:owner>
  <invoice:opened><ts:date>2024-02-20 09:00:00 +0000</ts:date></invoice:opened>
  <invoice:posted><ts:date>2024-03-01 10:59:00 +0000</ts:date></invoice:posted>
  <invoice:terms type="guid">bt100000000000000000000000000001</invoice:terms>
  <invoice:billing_id>PO-778</invoice:billing_id>
  <invoice:notes>March consulting</invoice:notes>
  <invoice:active>1</invoice:active>
  <invoice:posttxn type="guid">t2n00000000000000000000000000001</invoice:posttxn>
  <invoice:postlot type="guid">l0t00000000000000000000000000001</invoice:postlot>
  <invoice:postacc type="guid">acc10000000000000000000000000001</invoice:postacc>
  <invoice:currency><cmdty:space>CURRENCY</cmdty:space><cmdty:id>USD</cmdty:id></invoice:currency>
  <invoice:billto version="2.0.0">
    <owner:type>gncCustomer</owner:type>
    <owner:id type="guid">cu100000000000000000000000000001</owner:id>
  </invoice:billto>
  <invoice:charge-amt>5000/100</invoice:charge-amt>
</gnc:GncInvoice>
<gnc:GncInvoice version="2.0.0">
  <invoice:guid type="guid">iv100000000000000000000000000002</invoice:guid>
  <invoice:id>B-0001</invoice:id>
  <invoice:owner version="2.0.0">
    <owner:type>gncVendor</owner:type>
    <owner:id type="guid">vn100000000000000000000000000001</owner:id>
  </invoice:owner>
  <invoice:opened><ts:date>2024-03-05 09:00:00 +0000</ts:date></invoice:opened>
  <invoice:active>1</invoice:active>
  <invoice:currency><cmdty:space>CURRENCY</cmdty:space><cmdty:id>USD</cmdty:id></invoice:currency>
</gnc:GncInvoice>
<gnc:GncJob version="2.0.0">
  <job:guid type="guid">jb100000000000000000000000000001</job:guid>
  <job:id>000001</job:id>
  <job:name>Roadrunner Trap</job:name>
  <job:reference>RT-2024</job:reference>
  <job:owner version="2.0.0">
    <owner:type>gncCustomer</owner:type>
    <owner:id type="guid">cu100000000000000000000000000001</owner:id>
  </job:owner>
  <job:active>1</job:active>
</gnc:GncJob>
<gnc:GncOrder version="2.0.0">
  <order:guid type="guid">or100000000000000000000000000001</order:guid>
  <order:id>000001</order:id>
  <order:owner version="2.0.0">
    <owner:type>gncCustomer</owner:type>
    <owner:id type="guid">cu100000000000000000000000000001</owner:id>
  </order:owner>
  <order:opened><ts:date>2024-02-19 09:00:00 +0000</ts:date></order:opened>
  <order:notes>Standing anvil order</order:notes>
  <order:reference>ORD-9</order:reference>
  <order:active>1</order:active>
</gnc:GncOrder>
<gnc:GncTaxTable version="2.0.0">
  <taxtable:guid type="guid">tt100000000000000000000000000001</taxtable:guid>
  <taxtable:name>NC Sales Tax</taxtable:name>
  <taxtable:refcount>2</taxtable:refcount>
  <taxtable:invisible>0</taxtable:invisible>
  <taxtable:entries>
    <gnc:GncTaxTableEntry>
      <tte:acct type="guid">acc10000000000000000000000000004</tte:acct>
      <tte:amount>47500/10000</tte:amount>
      <tte:type>PERCENT</tte:type>
    </gnc:GncTaxTableEntry>
    <gnc:GncTaxTableEntry>
      <tte:acct type="guid">acc10000000000000000000000000004</tte:acct>
      <tte:amount>150/100</tte:amount>
      <tte:type>VALUE</tte:type>
    </gnc:GncTaxTableEntry>
  </taxtable:entries>
</gnc:GncTaxTable>
<gnc:GncVendor version="2.0.0">
  <vendor:guid type="guid">vn100000000000000000000000000001</vendor:guid>
  <vendor:name>Iron Works Ltd</vendor:name>
  <vendor:id>000001</vendor:id>
  <vendor:addr version="2.0.0">
    <addr:name>Iron Works</addr:name>
    <addr:addr1>9 Forge St</addr:addr1>
  </vendor:addr>
  <vendor:terms type="guid">bt100000000000000000000000000001</vendor:terms>
  <vendor:taxincluded>USEGLOBAL</vendor:taxincluded>
  <vendor:active>1</vendor:active>
  <vendor:currency><cmdty:space>CURRENCY</cmdty:space><cmdty:id>USD</cmdty:id></vendor:currency>
  <vendor:use-tt>0</vendor:use-tt>
</gnc:GncVendor>
</gnc:book>
</gnc-v2>
`;

describe('business XML parsing', () => {
  const data = parseGnuCashXml(Buffer.from(FIXTURE));

  it('parses the billterm days variant with refcount and discount', () => {
    expect(data.billterms).toEqual([
      {
        guid: 'bt100000000000000000000000000001',
        name: 'Net 30',
        description: 'Payable within 30 days',
        refcount: 2,
        invisible: false,
        days: { dueDays: 30, discountDays: 10, discount: '200/100' },
      },
    ]);
  });

  it('parses the taxtable with both entries (percent + value)', () => {
    expect(data.taxtables).toEqual([
      {
        guid: 'tt100000000000000000000000000001',
        name: 'NC Sales Tax',
        refcount: 2,
        invisible: false,
        entries: [
          {
            accountId: 'acc10000000000000000000000000004',
            amount: '47500/10000',
            type: 'PERCENT',
          },
          {
            accountId: 'acc10000000000000000000000000004',
            amount: '150/100',
            type: 'VALUE',
          },
        ],
      },
    ]);
  });

  it('parses the customer with both addresses, refs, and numerics', () => {
    expect(data.customers).toEqual([
      {
        guid: 'cu100000000000000000000000000001',
        name: 'Acme Anvils',
        id: '000001',
        addr: {
          name: 'Wile E. Coyote',
          addr1: '1 Desert Rd',
          phone: '555-0100',
          email: 'wile@acme.example',
        },
        shipaddr: { name: 'Acme Receiving', addr1: '2 Canyon Way' },
        notes: 'Prefers email invoices',
        termsId: 'bt100000000000000000000000000001',
        taxIncluded: 'NO',
        active: true,
        discount: '500/10000',
        credit: '100000/100',
        currency: { space: 'CURRENCY', id: 'USD' },
        useTaxTable: true,
        taxTableId: 'tt100000000000000000000000000001',
      },
    ]);
  });

  it('parses the vendor, employee (ccard, workday/rate), and job (owner)', () => {
    expect(data.vendors![0]).toMatchObject({
      guid: 'vn100000000000000000000000000001',
      termsId: 'bt100000000000000000000000000001',
      taxIncluded: 'USEGLOBAL',
      useTaxTable: false,
    });
    expect(data.employees![0]).toMatchObject({
      username: 'rrunner',
      language: 'en',
      workday: '8/1',
      rate: '2500/100',
      ccardId: 'acc10000000000000000000000000003',
    });
    expect(data.jobs![0]).toMatchObject({
      name: 'Roadrunner Trap',
      reference: 'RT-2024',
      owner: { type: 'gncCustomer', id: 'cu100000000000000000000000000001' },
      active: true,
    });
  });

  it('parses the posted invoice with post refs, billto, and charge-amt', () => {
    expect(data.invoices![0]).toEqual({
      guid: 'iv100000000000000000000000000001',
      id: '000001',
      owner: { type: 'gncJob', id: 'jb100000000000000000000000000001' },
      opened: '2024-02-20 09:00:00 +0000',
      posted: '2024-03-01 10:59:00 +0000',
      termsId: 'bt100000000000000000000000000001',
      billingId: 'PO-778',
      notes: 'March consulting',
      active: true,
      postTxnId: 't2n00000000000000000000000000001',
      postLotId: 'l0t00000000000000000000000000001',
      postAccId: 'acc10000000000000000000000000001',
      currency: { space: 'CURRENCY', id: 'USD' },
      billTo: { type: 'gncCustomer', id: 'cu100000000000000000000000000001' },
      chargeAmt: '5000/100',
    });
  });

  it('parses both entry sides (i-* incl. discount; b-* incl. b-pay and billto)', () => {
    expect(data.entries![0]).toEqual({
      guid: 'en100000000000000000000000000001',
      date: '2024-03-01 10:59:00 +0000',
      entered: '2024-03-01 11:00:00 +0000',
      description: 'Consulting hours',
      action: 'Hours',
      quantity: '5/1',
      iAcctId: 'acc10000000000000000000000000002',
      iPrice: '10000/100',
      iDiscount: '500/100',
      invoiceId: 'iv100000000000000000000000000001',
      iDiscType: 'VALUE',
      iDiscHow: 'PRETAX',
      iTaxable: true,
      iTaxIncluded: false,
      iTaxTableId: 'tt100000000000000000000000000001',
    });
    expect(data.entries![1]).toEqual({
      guid: 'en100000000000000000000000000002',
      date: '2024-03-05 10:59:00 +0000',
      entered: '2024-03-05 11:00:00 +0000',
      description: 'Anvil supplies',
      quantity: '3/1',
      bAcctId: 'acc10000000000000000000000000003',
      bPrice: '2000/100',
      billId: 'iv100000000000000000000000000002',
      billable: true,
      billTo: { type: 'gncCustomer', id: 'cu100000000000000000000000000001' },
      bTaxable: false,
      bTaxIncluded: false,
      bPayment: 'CARD',
    });
  });

  it('parses the order without a closed date', () => {
    expect(data.orders).toEqual([
      {
        guid: 'or100000000000000000000000000001',
        id: '000001',
        owner: { type: 'gncCustomer', id: 'cu100000000000000000000000000001' },
        opened: '2024-02-19 09:00:00 +0000',
        notes: 'Standing anvil order',
        reference: 'ORD-9',
        active: true,
      },
    ]);
  });

  it('collects business count-data by literal class name', () => {
    expect(data.countData['gnc:GncCustomer']).toBe(1);
    expect(data.countData['gnc:GncEntry']).toBe(2);
    expect(data.countData['gnc:GncInvoice']).toBe(2);
  });
});

describe('business XML round-trip', () => {
  it('parse -> build -> reparse loses nothing', () => {
    const parsed = parseGnuCashXml(Buffer.from(FIXTURE));
    const rebuilt = buildGnuCashXml(parsed);
    const reparsed = parseGnuCashXml(Buffer.from(rebuilt));

    expect(reparsed.billterms).toEqual(parsed.billterms);
    expect(reparsed.taxtables).toEqual(parsed.taxtables);
    expect(reparsed.customers).toEqual(parsed.customers);
    expect(reparsed.vendors).toEqual(parsed.vendors);
    expect(reparsed.employees).toEqual(parsed.employees);
    expect(reparsed.jobs).toEqual(parsed.jobs);
    expect(reparsed.invoices).toEqual(parsed.invoices);
    expect(reparsed.entries).toEqual(parsed.entries);
    expect(reparsed.orders).toEqual(parsed.orders);
    // The rest of the book survives alongside the business objects.
    expect(reparsed.accounts).toEqual(parsed.accounts);
    expect(reparsed.transactions).toEqual(parsed.transactions);
  });

  it('emits business namespaces, versions, counts, and 0/1 booleans', () => {
    const parsed = parseGnuCashXml(Buffer.from(FIXTURE));
    const xml = buildGnuCashXml(parsed);

    // Business namespace declarations (always present).
    for (const ns of [
      'billterm', 'bt-days', 'bt-prox', 'cust', 'employee', 'entry',
      'invoice', 'job', 'order', 'owner', 'taxtable', 'tte', 'vendor', 'addr',
    ]) {
      expect(xml).toContain(`xmlns:${ns}="http://www.gnucash.org/XML/${ns}"`);
    }

    // count-data uses the literal class names and skips zero counts.
    expect(xml).toContain('cd:type="gnc:GncCustomer"');
    expect(xml).toContain('cd:type="gnc:GncBillTerm"');
    expect(xml).not.toContain('cd:type="schedxaction"');

    // 0/1 integer booleans, never y/n or TRUE/FALSE.
    expect(xml).toMatch(/<cust:active>1<\/cust:active>/);
    expect(xml).toMatch(/<vendor:use-tt>0<\/vendor:use-tt>/);
    expect(xml).toMatch(/<billterm:invisible>0<\/billterm:invisible>/);

    // Version attributes on family elements and sub-encodings.
    expect(xml).toMatch(/<gnc:GncCustomer version="2.0.0">/);
    expect(xml).toMatch(/<cust:addr version="2.0.0">/);
    expect(xml).toMatch(/<invoice:owner version="2.0.0">/);
    // Tax table entries carry NO version attribute.
    expect(xml).toMatch(/<gnc:GncTaxTableEntry>/);
  });

  it('applies maybe_add omission rules (zero numerics, empty strings, unset dates)', () => {
    const parsed = parseGnuCashXml(Buffer.from(FIXTURE));
    // Zero out the billterm discount and drop optional fields.
    parsed.billterms![0].days = { dueDays: 30, discountDays: 0, discount: '0/100' };
    parsed.customers![0].notes = undefined;
    parsed.orders![0].closed = undefined;

    const xml = buildGnuCashXml(parsed);
    expect(xml).not.toContain('bt-days:disc-days');
    expect(xml).not.toContain('bt-days:discount');
    expect(xml).toContain('bt-days:due-days');
    expect(xml).not.toContain('cust:notes');
    expect(xml).not.toContain('order:closed');
    // An unposted invoice never emits posted/posttxn/postlot/postacc.
    // (Search from the invoice element itself — the bill ENTRY references
    // the same guid earlier in the document via entry:bill.)
    const billSection = xml.slice(
      xml.indexOf('<invoice:guid type="guid">iv100000000000000000000000000002'),
    );
    const billElement = billSection.slice(0, billSection.indexOf('</gnc:GncInvoice>'));
    expect(billElement).not.toContain('invoice:posted');
    expect(billElement).not.toContain('invoice:posttxn');
  });
});

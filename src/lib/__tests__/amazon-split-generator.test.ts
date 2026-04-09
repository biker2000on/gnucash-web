import { describe, it, expect } from 'vitest';
import { generateSplits, SplitGeneratorInput } from '../amazon-split-generator';

/** Helper: assert all splits sum to exactly zero */
function expectSumsToZero(splits: ReturnType<typeof generateSplits>) {
  const total = splits.reduce((sum, s) => sum + s.value_num, 0);
  expect(total).toBe(0);
}

const CC_GUID = 'cc'.repeat(16);
const TAX_GUID = 'tx'.repeat(16);
const SHIP_GUID = 'sh'.repeat(16);
const ACCT_A = 'aa'.repeat(16);
const ACCT_B = 'bb'.repeat(16);
const ACCT_C = 'cc'.padEnd(32, '0');
const ACCT_D = 'dd'.repeat(16);
const ACCT_E = 'ee'.repeat(16);

describe('generateSplits', () => {
  it('tax mode "separate": 2 items + tax → 4 splits, sum = 0', () => {
    const input: SplitGeneratorInput = {
      items: [
        { name: 'Widget', price: 10.00, quantity: 1, tax: 0.80, accountGuid: ACCT_A },
        { name: 'Gadget', price: 20.00, quantity: 1, tax: 1.60, accountGuid: ACCT_B },
      ],
      shippingAmount: 0,
      creditCardAccountGuid: CC_GUID,
      creditCardAmount: 32.40,
      currencyDenom: 100,
      taxMode: 'separate',
      shippingMode: 'rolled_in',
      taxAccountGuid: TAX_GUID,
    };

    const splits = generateSplits(input);
    expect(splits).toHaveLength(4); // 2 items + 1 tax + 1 CC
    expectSumsToZero(splits);

    // Item splits are negative
    expect(splits[0].value_num).toBe(-1000);
    expect(splits[1].value_num).toBe(-2000);
    // Tax split
    expect(splits[2].value_num).toBe(-240);
    expect(splits[2].memo).toBe('Sales Tax');
    // CC split positive
    expect(splits[3].value_num).toBe(3240);
  });

  it('tax mode "rolled_in": 2 items → 3 splits, sum = 0', () => {
    const input: SplitGeneratorInput = {
      items: [
        { name: 'Widget', price: 10.00, quantity: 1, tax: 0.80, accountGuid: ACCT_A },
        { name: 'Gadget', price: 20.00, quantity: 1, tax: 1.60, accountGuid: ACCT_B },
      ],
      shippingAmount: 0,
      creditCardAccountGuid: CC_GUID,
      creditCardAmount: 32.40,
      currencyDenom: 100,
      taxMode: 'rolled_in',
      shippingMode: 'rolled_in',
    };

    const splits = generateSplits(input);
    expect(splits).toHaveLength(3); // 2 items + CC
    expectSumsToZero(splits);

    // First item: 10.00 + (10/30)*2.40 = 10.80
    expect(splits[0].value_num).toBe(-1080);
    // Second item absorbs rounding remainder: should be -1620 + rounding
    // total expense = 32.40, first = 10.80, so second = 32.40 - 10.80 = 21.60
    expect(splits[1].value_num).toBe(-2160);
  });

  it('shipping mode "separate": adds shipping split', () => {
    const input: SplitGeneratorInput = {
      items: [
        { name: 'Widget', price: 25.00, quantity: 1, tax: 0, accountGuid: ACCT_A },
      ],
      shippingAmount: 5.99,
      creditCardAccountGuid: CC_GUID,
      creditCardAmount: 30.99,
      currencyDenom: 100,
      taxMode: 'separate',
      shippingMode: 'separate',
      shippingAccountGuid: SHIP_GUID,
    };

    const splits = generateSplits(input);
    expect(splits).toHaveLength(3); // 1 item + 1 shipping + CC
    expectSumsToZero(splits);

    const shippingSplit = splits.find(s => s.memo === 'Shipping');
    expect(shippingSplit).toBeDefined();
    expect(shippingSplit!.value_num).toBe(-599);
  });

  it('shipping mode "rolled_in": distributes shipping to items', () => {
    const input: SplitGeneratorInput = {
      items: [
        { name: 'Widget', price: 10.00, quantity: 1, tax: 0, accountGuid: ACCT_A },
        { name: 'Gadget', price: 20.00, quantity: 1, tax: 0, accountGuid: ACCT_B },
      ],
      shippingAmount: 6.00,
      creditCardAccountGuid: CC_GUID,
      creditCardAmount: 36.00,
      currencyDenom: 100,
      taxMode: 'separate',
      shippingMode: 'rolled_in',
    };

    const splits = generateSplits(input);
    expect(splits).toHaveLength(3); // 2 items + CC (no separate shipping split)
    expectSumsToZero(splits);

    // First item: 10 + (10/30)*6 = 12.00
    expect(splits[0].value_num).toBe(-1200);
    // Second absorbs remainder: 36 - 12 = 24.00
    expect(splits[1].value_num).toBe(-2400);
  });

  it('both tax and shipping separate: 2 items + tax + shipping + CC = 5 splits', () => {
    const input: SplitGeneratorInput = {
      items: [
        { name: 'Widget', price: 15.00, quantity: 1, tax: 1.20, accountGuid: ACCT_A },
        { name: 'Gadget', price: 25.00, quantity: 1, tax: 2.00, accountGuid: ACCT_B },
      ],
      shippingAmount: 4.99,
      creditCardAccountGuid: CC_GUID,
      creditCardAmount: 48.19,
      currencyDenom: 100,
      taxMode: 'separate',
      shippingMode: 'separate',
      taxAccountGuid: TAX_GUID,
      shippingAccountGuid: SHIP_GUID,
    };

    const splits = generateSplits(input);
    expect(splits).toHaveLength(5);
    expectSumsToZero(splits);
  });

  it('both rolled in: 2 items + CC = 3 splits', () => {
    const input: SplitGeneratorInput = {
      items: [
        { name: 'Widget', price: 15.00, quantity: 1, tax: 1.20, accountGuid: ACCT_A },
        { name: 'Gadget', price: 25.00, quantity: 1, tax: 2.00, accountGuid: ACCT_B },
      ],
      shippingAmount: 4.99,
      creditCardAccountGuid: CC_GUID,
      creditCardAmount: 48.19,
      currencyDenom: 100,
      taxMode: 'rolled_in',
      shippingMode: 'rolled_in',
    };

    const splits = generateSplits(input);
    expect(splits).toHaveLength(3);
    expectSumsToZero(splits);
  });

  it('CRITICAL: rounding absorber — 3 items with proportional tax sums to exactly 0', () => {
    // 3 items where proportional distribution causes rounding issues
    // Total items = 33.33, tax distributed proportionally will have remainders
    const input: SplitGeneratorInput = {
      items: [
        { name: 'Item A', price: 11.11, quantity: 1, tax: 0.89, accountGuid: ACCT_A },
        { name: 'Item B', price: 11.11, quantity: 1, tax: 0.89, accountGuid: ACCT_B },
        { name: 'Item C', price: 11.11, quantity: 1, tax: 0.89, accountGuid: ACCT_C },
      ],
      shippingAmount: 0,
      creditCardAccountGuid: CC_GUID,
      creditCardAmount: 36.00,
      currencyDenom: 100,
      taxMode: 'rolled_in',
      shippingMode: 'rolled_in',
    };

    const splits = generateSplits(input);
    expect(splits).toHaveLength(4); // 3 items + CC
    expectSumsToZero(splits);

    // Verify the CC split matches the total
    const ccSplit = splits.find(s => s.account_guid === CC_GUID);
    expect(ccSplit!.value_num).toBe(3600);
  });

  it('single item order: 1 item + tax separate → 3 splits', () => {
    const input: SplitGeneratorInput = {
      items: [
        { name: 'Solo Item', price: 29.99, quantity: 1, tax: 2.40, accountGuid: ACCT_A },
      ],
      shippingAmount: 0,
      creditCardAccountGuid: CC_GUID,
      creditCardAmount: 32.39,
      currencyDenom: 100,
      taxMode: 'separate',
      shippingMode: 'rolled_in',
      taxAccountGuid: TAX_GUID,
    };

    const splits = generateSplits(input);
    expect(splits).toHaveLength(3); // 1 item + tax + CC
    expectSumsToZero(splits);
  });

  it('memo field contains item name for each split', () => {
    const input: SplitGeneratorInput = {
      items: [
        { name: 'USB Cable', price: 9.99, quantity: 1, tax: 0.80, accountGuid: ACCT_A },
        { name: 'Phone Case', price: 14.99, quantity: 1, tax: 1.20, accountGuid: ACCT_B },
      ],
      shippingAmount: 0,
      creditCardAccountGuid: CC_GUID,
      creditCardAmount: 26.98,
      currencyDenom: 100,
      taxMode: 'separate',
      shippingMode: 'rolled_in',
      taxAccountGuid: TAX_GUID,
    };

    const splits = generateSplits(input);
    expect(splits[0].memo).toBe('USB Cable');
    expect(splits[1].memo).toBe('Phone Case');
    // Tax split memo
    expect(splits[2].memo).toBe('Sales Tax');
    // CC split has empty memo
    expect(splits[3].memo).toBe('');
  });

  it('large order: 5 items with various prices → all splits sum to 0', () => {
    const input: SplitGeneratorInput = {
      items: [
        { name: 'Item 1', price: 5.49, quantity: 2, tax: 0.88, accountGuid: ACCT_A },
        { name: 'Item 2', price: 12.99, quantity: 1, tax: 1.04, accountGuid: ACCT_B },
        { name: 'Item 3', price: 3.33, quantity: 3, tax: 0.80, accountGuid: ACCT_C },
        { name: 'Item 4', price: 47.50, quantity: 1, tax: 3.80, accountGuid: ACCT_D },
        { name: 'Item 5', price: 8.75, quantity: 1, tax: 0.70, accountGuid: ACCT_E },
      ],
      shippingAmount: 7.99,
      creditCardAccountGuid: CC_GUID,
      creditCardAmount: 102.21,
      currencyDenom: 100,
      taxMode: 'rolled_in',
      shippingMode: 'rolled_in',
    };

    const splits = generateSplits(input);
    expect(splits).toHaveLength(6); // 5 items + CC
    expectSumsToZero(splits);
  });

  it('zero tax: no tax split generated when tax is 0', () => {
    const input: SplitGeneratorInput = {
      items: [
        { name: 'Tax-Free Item', price: 19.99, quantity: 1, tax: 0, accountGuid: ACCT_A },
        { name: 'Another Free', price: 5.00, quantity: 1, tax: 0, accountGuid: ACCT_B },
      ],
      shippingAmount: 0,
      creditCardAccountGuid: CC_GUID,
      creditCardAmount: 24.99,
      currencyDenom: 100,
      taxMode: 'separate',
      shippingMode: 'rolled_in',
      taxAccountGuid: TAX_GUID,
    };

    const splits = generateSplits(input);
    // No tax split because total tax is 0
    expect(splits).toHaveLength(3); // 2 items + CC
    expect(splits.find(s => s.memo === 'Sales Tax')).toBeUndefined();
    expectSumsToZero(splits);
  });
});

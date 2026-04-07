/**
 * Amazon Split Generator
 *
 * Generates replacement splits for a matched Amazon order. When an Amazon order
 * is matched to a credit card transaction, the original opaque split gets replaced
 * with item-level splits for proper expense categorization.
 */

export interface SplitGeneratorInput {
  items: Array<{
    name: string;
    price: number;      // item price before tax
    quantity: number;
    tax: number;         // tax for this item
    accountGuid: string; // expense account chosen by user
  }>;
  shippingAmount: number;
  creditCardAccountGuid: string;
  creditCardAmount: number;  // the original CC charge amount (positive)
  currencyDenom: number;     // usually 100 for USD
  taxMode: 'separate' | 'rolled_in';
  shippingMode: 'separate' | 'rolled_in';
  taxAccountGuid?: string;      // required when taxMode = 'separate'
  shippingAccountGuid?: string; // required when shippingMode = 'separate'
}

export interface GeneratedSplit {
  account_guid: string;
  value_num: number;
  value_denom: number;
  memo: string;
}

/**
 * Returns array of split objects ready for TransactionService.update().
 *
 * Sign convention:
 * - Expense splits have NEGATIVE value_num (debit)
 * - Credit card split has POSITIVE value_num (credit)
 * - All splits sum to exactly zero
 */
export function generateSplits(input: SplitGeneratorInput): GeneratedSplit[] {
  const {
    items,
    shippingAmount,
    creditCardAccountGuid,
    creditCardAmount,
    currencyDenom,
    taxMode,
    shippingMode,
    taxAccountGuid,
    shippingAccountGuid,
  } = input;

  const denom = currencyDenom;
  const splits: GeneratedSplit[] = [];

  const totalTax = items.reduce((sum, item) => sum + item.tax, 0);
  const totalItemsPrice = items.reduce((sum, item) => sum + item.price * item.quantity, 0);

  // Build item splits
  const itemValues: number[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    let itemTotal = item.price * item.quantity;

    // Roll in tax proportionally if needed
    if (taxMode === 'rolled_in' && totalTax > 0 && totalItemsPrice > 0) {
      const proportion = (item.price * item.quantity) / totalItemsPrice;
      itemTotal += proportion * totalTax;
    }

    // Roll in shipping proportionally if needed
    if (shippingMode === 'rolled_in' && shippingAmount > 0 && totalItemsPrice > 0) {
      const proportion = (item.price * item.quantity) / totalItemsPrice;
      itemTotal += proportion * shippingAmount;
    }

    // Round to integer cents
    itemValues.push(Math.round(itemTotal * denom));
  }

  // Credit card split value (positive)
  const ccValueNum = Math.round(creditCardAmount * denom);

  // Separate tax split value
  let taxValueNum = 0;
  if (taxMode === 'separate' && totalTax > 0) {
    taxValueNum = Math.round(totalTax * denom);
  }

  // Separate shipping split value
  let shippingValueNum = 0;
  if (shippingMode === 'separate' && shippingAmount > 0) {
    shippingValueNum = Math.round(shippingAmount * denom);
  }

  // Rounding absorber: adjust the last item split so everything sums to zero
  // Sum of all expense splits (negative) + CC split (positive) must = 0
  // CC split = +ccValueNum
  // Expense splits = -(sum of itemValues) - taxValueNum - shippingValueNum
  // So: ccValueNum - sum(itemValues) - taxValueNum - shippingValueNum = 0
  // Adjust last item: lastItem = ccValueNum - sum(otherItems) - taxValueNum - shippingValueNum
  const sumOtherItems = itemValues.slice(0, -1).reduce((sum, v) => sum + v, 0);
  itemValues[itemValues.length - 1] = ccValueNum - sumOtherItems - taxValueNum - shippingValueNum;

  // Add item splits (negative = debit to expense)
  for (let i = 0; i < items.length; i++) {
    splits.push({
      account_guid: items[i].accountGuid,
      value_num: -itemValues[i],
      value_denom: denom,
      memo: items[i].name,
    });
  }

  // Add separate tax split if applicable
  if (taxMode === 'separate' && totalTax > 0 && taxAccountGuid) {
    splits.push({
      account_guid: taxAccountGuid,
      value_num: -taxValueNum,
      value_denom: denom,
      memo: 'Sales Tax',
    });
  }

  // Add separate shipping split if applicable
  if (shippingMode === 'separate' && shippingAmount > 0 && shippingAccountGuid) {
    splits.push({
      account_guid: shippingAccountGuid,
      value_num: -shippingValueNum,
      value_denom: denom,
      memo: 'Shipping',
    });
  }

  // Credit card balancing split (positive = credit)
  splits.push({
    account_guid: creditCardAccountGuid,
    value_num: ccValueNum,
    value_denom: denom,
    memo: '',
  });

  return splits;
}

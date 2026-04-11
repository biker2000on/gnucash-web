import { describe, it, expect } from 'vitest';
import { parseGnuCashXml } from '../parser';

const BOOK_WITH_TYPED_SLOT_KEYS = `<?xml version="1.0" encoding="utf-8"?>
<gnc-v2>
  <gnc:book version="2.0.0" xmlns:gnc="x" xmlns:bgt="x" xmlns:slot="x">
    <book:id type="guid">00000000000000000000000000000000</book:id>
    <gnc:budget version="2.0.0">
      <bgt:id type="guid">budget-guid-000000000000000000000</bgt:id>
      <bgt:name>Monthly</bgt:name>
      <bgt:num-periods>12</bgt:num-periods>
      <bgt:slots>
        <slot>
          <slot:key type="guid">acct-groceries-0000000000000000</slot:key>
          <slot:value type="frame">
            <slot>
              <slot:key>0</slot:key>
              <slot:value type="numeric">500/1</slot:value>
            </slot>
            <slot>
              <slot:key>1</slot:key>
              <slot:value type="numeric">525/1</slot:value>
            </slot>
          </slot:value>
        </slot>
      </bgt:slots>
    </gnc:budget>
  </gnc:book>
</gnc-v2>`;

describe('parser — budget slot keys', () => {
  it('reads account guids even when slot:key carries a type attribute', () => {
    const data = parseGnuCashXml(Buffer.from(BOOK_WITH_TYPED_SLOT_KEYS));

    expect(data.budgets).toHaveLength(1);
    const budget = data.budgets[0];
    expect(budget.amounts).toHaveLength(2);

    for (const amount of budget.amounts) {
      expect(amount.accountId).toBe('acct-groceries-0000000000000000');
      expect(amount.accountId).not.toBe('[object Object]');
    }
    expect(budget.amounts.map((a) => a.periodNum).sort()).toEqual([0, 1]);
    expect(budget.amounts.map((a) => a.amount)).toEqual(['500/1', '525/1']);
  });
});

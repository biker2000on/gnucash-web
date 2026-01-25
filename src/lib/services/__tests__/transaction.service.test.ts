/**
 * Transaction Service Tests
 *
 * Tests for transaction service Zod schemas and validation logic
 */

import { describe, it, expect } from 'vitest';
import {
  SplitInputSchema,
  CreateTransactionSchema,
  UpdateTransactionSchema,
} from '../transaction.service';

describe('SplitInputSchema', () => {
  it('should validate a valid split', () => {
    const validSplit = {
      account_guid: 'a'.repeat(32),
      value_num: 10050,
      value_denom: 100,
    };
    const result = SplitInputSchema.parse(validSplit);
    expect(result.account_guid).toBe(validSplit.account_guid);
    expect(result.value_num).toBe(10050);
    expect(result.value_denom).toBe(100);
    expect(result.memo).toBe('');
    expect(result.reconcile_state).toBe('n');
  });

  it('should reject invalid GUID length', () => {
    const invalidSplit = {
      account_guid: 'short',
      value_num: 100,
      value_denom: 100,
    };
    expect(() => SplitInputSchema.parse(invalidSplit)).toThrow();
  });

  it('should reject zero denominator', () => {
    const invalidSplit = {
      account_guid: 'a'.repeat(32),
      value_num: 100,
      value_denom: 0,
    };
    expect(() => SplitInputSchema.parse(invalidSplit)).toThrow();
  });

  it('should reject negative denominator', () => {
    const invalidSplit = {
      account_guid: 'a'.repeat(32),
      value_num: 100,
      value_denom: -100,
    };
    expect(() => SplitInputSchema.parse(invalidSplit)).toThrow();
  });

  it('should accept optional quantity fields', () => {
    const split = {
      account_guid: 'a'.repeat(32),
      value_num: 100,
      value_denom: 100,
      quantity_num: 50,
      quantity_denom: 1,
    };
    const result = SplitInputSchema.parse(split);
    expect(result.quantity_num).toBe(50);
    expect(result.quantity_denom).toBe(1);
  });

  it('should validate reconcile state', () => {
    const split = {
      account_guid: 'a'.repeat(32),
      value_num: 100,
      value_denom: 100,
      reconcile_state: 'y',
    };
    const result = SplitInputSchema.parse(split);
    expect(result.reconcile_state).toBe('y');
  });

  it('should reject invalid reconcile state', () => {
    const split = {
      account_guid: 'a'.repeat(32),
      value_num: 100,
      value_denom: 100,
      reconcile_state: 'x',
    };
    expect(() => SplitInputSchema.parse(split)).toThrow();
  });
});

describe('CreateTransactionSchema', () => {
  const validTransaction = {
    currency_guid: 'c'.repeat(32),
    post_date: '2024-01-15',
    description: 'Test transaction',
    splits: [
      { account_guid: 'a'.repeat(32), value_num: 100, value_denom: 100 },
      { account_guid: 'b'.repeat(32), value_num: -100, value_denom: 100 },
    ],
  };

  it('should validate a valid transaction', () => {
    const result = CreateTransactionSchema.parse(validTransaction);
    expect(result.currency_guid).toBe(validTransaction.currency_guid);
    expect(result.description).toBe('Test transaction');
    expect(result.splits).toHaveLength(2);
    expect(result.post_date).toBeInstanceOf(Date);
  });

  it('should transform post_date string to Date', () => {
    const result = CreateTransactionSchema.parse(validTransaction);
    expect(result.post_date).toBeInstanceOf(Date);
    expect(result.post_date.toISOString()).toContain('2024-01-15');
  });

  it('should accept Date object for post_date', () => {
    const tx = { ...validTransaction, post_date: new Date('2024-06-01') };
    const result = CreateTransactionSchema.parse(tx);
    expect(result.post_date).toBeInstanceOf(Date);
  });

  it('should reject invalid currency GUID', () => {
    const tx = { ...validTransaction, currency_guid: 'short' };
    expect(() => CreateTransactionSchema.parse(tx)).toThrow();
  });

  it('should require at least 2 splits', () => {
    const tx = {
      ...validTransaction,
      splits: [{ account_guid: 'a'.repeat(32), value_num: 100, value_denom: 100 }],
    };
    expect(() => CreateTransactionSchema.parse(tx)).toThrow();
  });

  it('should accept empty description', () => {
    const tx = { ...validTransaction, description: undefined };
    const result = CreateTransactionSchema.parse(tx);
    expect(result.description).toBe('');
  });

  it('should accept optional num field', () => {
    const tx = { ...validTransaction, num: 'CHK-001' };
    const result = CreateTransactionSchema.parse(tx);
    expect(result.num).toBe('CHK-001');
  });

  it('should default num to empty string', () => {
    const result = CreateTransactionSchema.parse(validTransaction);
    expect(result.num).toBe('');
  });
});

describe('UpdateTransactionSchema', () => {
  const validUpdate = {
    guid: 't'.repeat(32),
    currency_guid: 'c'.repeat(32),
    post_date: '2024-01-15',
    description: 'Updated transaction',
    splits: [
      { account_guid: 'a'.repeat(32), value_num: 200, value_denom: 100 },
      { account_guid: 'b'.repeat(32), value_num: -200, value_denom: 100 },
    ],
  };

  it('should validate a valid update', () => {
    const result = UpdateTransactionSchema.parse(validUpdate);
    expect(result.guid).toBe(validUpdate.guid);
    expect(result.splits).toHaveLength(2);
  });

  it('should require guid field', () => {
    const update = { ...validUpdate, guid: undefined };
    expect(() => UpdateTransactionSchema.parse(update)).toThrow();
  });

  it('should reject invalid guid length', () => {
    const update = { ...validUpdate, guid: 'short' };
    expect(() => UpdateTransactionSchema.parse(update)).toThrow();
  });
});

describe('Double-entry validation', () => {
  it('should accept balanced splits', () => {
    const tx = {
      currency_guid: 'c'.repeat(32),
      post_date: '2024-01-15',
      description: 'Balanced transaction',
      splits: [
        { account_guid: 'a'.repeat(32), value_num: 5000, value_denom: 100 }, // +50.00
        { account_guid: 'b'.repeat(32), value_num: -3000, value_denom: 100 }, // -30.00
        { account_guid: 'c'.repeat(32), value_num: -2000, value_denom: 100 }, // -20.00
      ],
    };
    // Schema should parse (validation is done in service)
    const result = CreateTransactionSchema.parse(tx);
    expect(result.splits).toHaveLength(3);
  });

  it('should handle negative splits (credits)', () => {
    const tx = {
      currency_guid: 'c'.repeat(32),
      post_date: '2024-01-15',
      description: 'Income transaction',
      splits: [
        { account_guid: 'a'.repeat(32), value_num: 100000, value_denom: 100 }, // +1000.00 debit
        { account_guid: 'b'.repeat(32), value_num: -100000, value_denom: 100 }, // -1000.00 credit
      ],
    };
    const result = CreateTransactionSchema.parse(tx);
    expect(result.splits[0].value_num).toBe(100000);
    expect(result.splits[1].value_num).toBe(-100000);
  });
});

import { describe, it, expect } from 'vitest';
import {
  selectManualReconciliationMatch,
  type ReconciliationCandidate,
  selectTransferDedupMatch,
  type TransferDedupCandidate,
} from '../simplefin-sync.service';

describe('selectManualReconciliationMatch', () => {
  const baseSfTxn = {
    posted: new Date('2026-03-20T12:00:00Z').getTime() / 1000,
    amount: '-45.67',
    description: 'AMAZON PURCHASE',
  };

  it('should match exact amount + same day (high confidence)', () => {
    const candidates: ReconciliationCandidate[] = [{
      transaction_guid: 'a'.repeat(32),
      post_date: new Date('2026-03-20T10:00:00Z'),
      description: 'Amazon Purchase',
      has_meta: true,
    }];
    const result = selectManualReconciliationMatch(baseSfTxn, candidates);
    expect(result).not.toBeNull();
    expect(result!.transaction_guid).toBe('a'.repeat(32));
    expect(result!.confidence).toBe('high');
  });

  it('should match exact amount + 1 day offset (high confidence)', () => {
    const candidates: ReconciliationCandidate[] = [{
      transaction_guid: 'b'.repeat(32),
      post_date: new Date('2026-03-21T10:00:00Z'),
      description: 'Amazon Purchase',
      has_meta: true,
    }];
    const result = selectManualReconciliationMatch(baseSfTxn, candidates);
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe('high');
  });

  it('should match exact amount + 3 day offset (medium confidence)', () => {
    const candidates: ReconciliationCandidate[] = [{
      transaction_guid: 'c'.repeat(32),
      post_date: new Date('2026-03-23T10:00:00Z'),
      description: 'Amazon',
      has_meta: true,
    }];
    const result = selectManualReconciliationMatch(baseSfTxn, candidates);
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe('medium');
  });

  it('should return null for date > 3 days away', () => {
    const candidates: ReconciliationCandidate[] = [{
      transaction_guid: 'd'.repeat(32),
      post_date: new Date('2026-03-24T10:00:00Z'),
      description: 'Amazon Purchase',
      has_meta: true,
    }];
    const result = selectManualReconciliationMatch(baseSfTxn, candidates);
    expect(result).toBeNull();
  });

  it('should return null for empty candidates', () => {
    const result = selectManualReconciliationMatch(baseSfTxn, []);
    expect(result).toBeNull();
  });

  it('should prefer closest date when multiple candidates', () => {
    const candidates: ReconciliationCandidate[] = [
      {
        transaction_guid: 'e'.repeat(32),
        post_date: new Date('2026-03-22T10:00:00Z'),
        description: 'Amazon',
        has_meta: true,
      },
      {
        transaction_guid: 'f'.repeat(32),
        post_date: new Date('2026-03-20T14:00:00Z'),
        description: 'Amazon',
        has_meta: true,
      },
    ];
    const result = selectManualReconciliationMatch(baseSfTxn, candidates);
    expect(result).not.toBeNull();
    expect(result!.transaction_guid).toBe('f'.repeat(32));
  });

  it('should break date tie with longest common description prefix', () => {
    const candidates: ReconciliationCandidate[] = [
      {
        transaction_guid: 'g'.repeat(32),
        post_date: new Date('2026-03-20T10:00:00Z'),
        description: 'AMAZON',
        has_meta: true,
      },
      {
        transaction_guid: 'h'.repeat(32),
        post_date: new Date('2026-03-20T10:00:00Z'),
        description: 'AMAZON PURCHASE',
        has_meta: true,
      },
    ];
    const result = selectManualReconciliationMatch(baseSfTxn, candidates);
    expect(result).not.toBeNull();
    expect(result!.transaction_guid).toBe('h'.repeat(32));
  });
});

describe('selectTransferDedupMatch', () => {
  const baseSfTxn = {
    posted: new Date('2026-03-20T12:00:00Z').getTime() / 1000,
    amount: '500.00',
    description: 'Transfer from checking',
  };

  it('should match opposite amount within same day', () => {
    const candidates: TransferDedupCandidate[] = [{
      transaction_guid: 'a'.repeat(32),
      post_date: new Date('2026-03-20T10:00:00Z'),
      split_account_guid: 'b'.repeat(32),
      dest_split_guid: 'c'.repeat(32),
      dest_account_guid: 'd'.repeat(32),
    }];
    const result = selectTransferDedupMatch(baseSfTxn, candidates);
    expect(result).not.toBeNull();
    expect(result!.transaction_guid).toBe('a'.repeat(32));
  });

  it('should match within ±3 day window', () => {
    const candidates: TransferDedupCandidate[] = [{
      transaction_guid: 'a'.repeat(32),
      post_date: new Date('2026-03-23T10:00:00Z'),
      split_account_guid: 'b'.repeat(32),
      dest_split_guid: 'c'.repeat(32),
      dest_account_guid: 'd'.repeat(32),
    }];
    const result = selectTransferDedupMatch(baseSfTxn, candidates);
    expect(result).not.toBeNull();
  });

  it('should return null for date > 3 days away', () => {
    const candidates: TransferDedupCandidate[] = [{
      transaction_guid: 'a'.repeat(32),
      post_date: new Date('2026-03-24T10:00:00Z'),
      split_account_guid: 'b'.repeat(32),
      dest_split_guid: 'c'.repeat(32),
      dest_account_guid: 'd'.repeat(32),
    }];
    const result = selectTransferDedupMatch(baseSfTxn, candidates);
    expect(result).toBeNull();
  });

  it('should return null for empty candidates', () => {
    const result = selectTransferDedupMatch(baseSfTxn, []);
    expect(result).toBeNull();
  });

  it('should prefer closest date when multiple candidates', () => {
    const candidates: TransferDedupCandidate[] = [
      {
        transaction_guid: 'e'.repeat(32),
        post_date: new Date('2026-03-22T10:00:00Z'),
        split_account_guid: 'b'.repeat(32),
        dest_split_guid: 'c'.repeat(32),
        dest_account_guid: 'd'.repeat(32),
      },
      {
        transaction_guid: 'f'.repeat(32),
        post_date: new Date('2026-03-20T14:00:00Z'),
        split_account_guid: 'b'.repeat(32),
        dest_split_guid: 'c'.repeat(32),
        dest_account_guid: 'd'.repeat(32),
      },
    ];
    const result = selectTransferDedupMatch(baseSfTxn, candidates);
    expect(result).not.toBeNull();
    expect(result!.transaction_guid).toBe('f'.repeat(32));
  });
});

import { describe, expect, it, vi } from 'vitest';
import { safeActionSource } from '../sources';
import type { FinancialActionCandidate } from '../types';

describe('Financial Action source isolation', () => {
  it('returns healthy adapter actions unchanged', async () => {
    const action = { stableKey: 'healthy' } as FinancialActionCandidate;
    const work = vi.fn().mockResolvedValue([action]);

    await expect(safeActionSource('Healthy source', work)).resolves.toEqual([action]);
    expect(work).toHaveBeenCalledOnce();
  });

  it('turns an adapter failure into a visible critical Fix action', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const actions = await safeActionSource(
      'Statement reconciliation',
      async () => { throw new Error('database unavailable'); },
    );

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      stableKey: 'source-adapter-failure:statement-reconciliation',
      lane: 'fix',
      origin: 'failed_job',
      severity: 'critical',
      confidence: 1,
      metadata: {
        adapter: 'Statement reconciliation',
        refreshFailed: true,
      },
    });
    expect(actions[0].summary).not.toContain('database unavailable');
    expect(actions[0].trace.evidence[0]).toMatchObject({
      kind: 'job',
      source: 'system',
      verified: false,
    });
    warn.mockRestore();
  });
});

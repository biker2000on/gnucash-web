import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { defaultPlanner } from '@/lib/debt-investment-planner';
const mocks = vi.hoisted(() => ({ auth: vi.fn(), get: vi.fn(), decision: vi.fn() }));
vi.mock('@/lib/auth', () => ({ requireRole: mocks.auth }));
vi.mock('@/lib/services/tool-config.service', () => ({ ToolConfigService: { getById: mocks.get } }));
vi.mock('@/lib/planning/living-plan', () => ({ addPlanDecision: mocks.decision }));
import { POST } from './route';
const request = (body: unknown) => new NextRequest('http://localhost/api/tools/debt-vs-invest/adopt', { method: 'POST', body: JSON.stringify(body) });
const body = () => ({ scenarioId: 7, strategy: 'payoff', scenario: defaultPlanner() });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ user: { id: 3 }, bookGuid: 'book-a' });
  mocks.get.mockResolvedValue({ id: 7, name: 'Mortgage', tool_type: 'debt-vs-invest', config: defaultPlanner(), updated_at: new Date('2026-09-16') });
  mocks.decision.mockResolvedValue({ id: 'plan-a' });
});
describe('record saved debt strategy', () => {
  it('requires edit access before reading a scenario', async () => {
    mocks.auth.mockResolvedValue(NextResponse.json({ error: 'Forbidden' }, { status: 403 }));
    expect((await POST(request(body()))).status).toBe(403);
    expect(mocks.auth).toHaveBeenCalledWith('edit');
    expect(mocks.get).not.toHaveBeenCalled();
  });
  it('loads by user and active book, preserving assumptions and alternatives', async () => {
    expect((await POST(request(body()))).status).toBe(201);
    expect(mocks.get).toHaveBeenCalledWith(7, 3, 'book-a');
    const [user, book, decision] = mocks.decision.mock.calls[0];
    expect([user, book]).toEqual([3, 'book-a']);
    expect(decision.alternatives).toEqual(['Invest', 'Split']);
    expect(decision.assumptions).toContain(`Input snapshot: ${JSON.stringify(defaultPlanner())}`);
    expect(decision.expectedImpact).toContain('does not replace');
  });
  it('does not disclose scenarios in another book or owned by another user', async () => {
    mocks.get.mockResolvedValue(null);
    expect((await POST(request(body()))).status).toBe(404);
    expect(mocks.decision).not.toHaveBeenCalled();
  });
  it('rejects wrong tool type, invalid inputs, and unsaved changes', async () => {
    expect((await POST(request({ ...body(), strategy: 'unknown' }))).status).toBe(400);
    expect((await POST(request({ ...body(), scenario: { ...defaultPlanner(), years: 10 } }))).status).toBe(409);
    mocks.get.mockResolvedValue({ tool_type: 'fire', config: defaultPlanner() });
    expect((await POST(request(body()))).status).toBe(404);
    expect(mocks.decision).not.toHaveBeenCalled();
  });
  it('rejects unfunded plans even when saved', async () => {
    const scenario = defaultPlanner(); scenario.debts[0].rateChanges = [{ month: 1, rate: 5, payment: 5000 }];
    mocks.get.mockResolvedValue({ tool_type: 'debt-vs-invest', config: scenario });
    expect((await POST(request({ ...body(), scenario }))).status).toBe(400);
    expect(mocks.decision).not.toHaveBeenCalled();
  });
  it('explains the missing adopted-plan prerequisite', async () => {
    mocks.decision.mockRejectedValue(new Error('No adopted living plan'));
    const response = await POST(request(body()));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('Adopt a Living Plan');
  });
});

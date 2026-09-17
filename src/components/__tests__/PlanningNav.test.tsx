import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { usePlanningGroups } from '../PlanningNav';

const links = [
    { name: 'Pay Off Debt or Invest?', href: '/tools/debt-vs-invest' },
    { name: 'Scenario Sandbox', href: '/tools/scenario' },
    { name: 'FIRE Calculator', href: '/tools/fire-calculator' },
];
afterEach(() => { cleanup(); localStorage.clear(); });

it('remembers manual groups while reopening the current group on navigation and reload', () => {
    const { result, rerender, unmount } = renderHook(({ href }) => usePlanningGroups(href, links), { initialProps: { href: links[0].href } });
    expect(result.current.expanded.has('debt')).toBe(true);
    act(() => result.current.toggle('retirement'));
    act(() => result.current.toggle('debt'));
    expect(result.current.expanded.has('debt')).toBe(false);
    rerender({ href: links[1].href });
    expect(result.current.expanded.has('debt')).toBe(true);
    rerender({ href: links[0].href });
    expect(result.current.expanded.has('debt')).toBe(true);
    expect(result.current.expanded.has('retirement')).toBe(true);
    unmount();
    const reloaded = renderHook(() => usePlanningGroups(links[0].href, links));
    expect(reloaded.result.current.expanded.has('debt')).toBe(true);
    expect(reloaded.result.current.expanded.has('retirement')).toBe(true);
});

it('ignores malformed preferences', () => {
    localStorage.setItem('sidebar-planning-groups', 'invalid json');
    const { result } = renderHook(() => usePlanningGroups(null, links));
    expect(result.current.expanded.size).toBe(0);
});

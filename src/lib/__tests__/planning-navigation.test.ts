import { expect, it } from 'vitest';
import { FEATURES } from '../feature-registry';
import { groupPlanningLinks } from '../planning-navigation';

const links = FEATURES.filter(f => f.domain === 'planning' && f.nav).map(f => ({ name: f.navTitle ?? f.title, href: f.href }));
it('retains every Planning destination exactly once and keeps Living Plan direct', () => {
    const { direct, groups } = groupPlanningLinks(links);
    expect(groups).toHaveLength(7);
    expect(direct.map(link => link.name)).toEqual(['Living Plan']);
    const result = [...direct, ...groups.flatMap(group => group.links)].map(link => link.href);
    expect(result.sort()).toEqual(links.map(link => link.href).sort());
    expect(new Set(result).size).toBe(result.length);
});
it('does not restore filtered household links or display empty groups', () => {
    const permitted = FEATURES.filter(f => f.domain === 'planning' && f.nav && !f.personalOnly).map(f => ({ name: f.title, href: f.href }));
    const { direct, groups } = groupPlanningLinks(permitted);
    expect([...direct, ...groups.flatMap(group => group.links)]).toHaveLength(permitted.length);
    expect(groups.some(group => group.id === 'retirement')).toBe(false);
    expect(groups.every(group => group.links.length > 0)).toBe(true);
});
it('keeps future unmapped destinations reachable', () => {
    const future = { name: 'Future tool', href: '/tools/future' };
    expect(groupPlanningLinks([...links, future]).direct).toContainEqual(future);
});

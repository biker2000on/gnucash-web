'use client';

import Link from 'next/link';
import { useId, useState, useSyncExternalStore } from 'react';
import { groupPlanningLinks, PLANNING_GROUPS, type PlanningLink } from '@/lib/planning-navigation';

const STORAGE_KEY = 'sidebar-planning-groups';
const subscribe = () => () => undefined;
function readGroups() {
    try { return localStorage.getItem(STORAGE_KEY) ?? '[]'; } catch { return '[]'; }
}

export function usePlanningGroups(activeHref: string | null, links: PlanningLink[]) {
    const activeGroup = groupPlanningLinks(links).groups.find(group => group.links.some(link => link.href === activeHref))?.id;
    const stored = useSyncExternalStore(subscribe, readGroups, () => '[]');
    const [override, setOverride] = useState<{ href: string | null; group: string | undefined; ids: string[] } | null>(null);
    if (override && (override.href !== activeHref || override.group !== activeGroup)) {
        setOverride(null);
    }
    let saved: unknown;
    try { saved = JSON.parse(stored); } catch { saved = []; }
    const expanded = new Set<string>(override?.ids ?? (Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string' && PLANNING_GROUPS.some(group => group.id === id)) : []));
    // A user may collapse the current group until navigation changes the page.
    if (activeGroup && (override?.href !== activeHref || override?.group !== activeGroup)) expanded.add(activeGroup);

    function toggle(id: string) {
        const next = new Set(expanded);
        if (next.has(id)) next.delete(id); else next.add(id);
        setOverride({ href: activeHref, group: activeGroup, ids: [...next] });
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify([...next])); } catch { /* Navigation also works without storage. */ }
    }
    return { expanded, toggle };
}

export function PlanningNav({ links, activeHref, expanded, toggle, onNavigate, mobile = false }: {
    links: PlanningLink[];
    activeHref: string | null;
    expanded: Set<string>;
    toggle: (id: string) => void;
    onNavigate: () => void;
    mobile?: boolean;
}) {
    const prefix = useId();
    const { direct, groups } = groupPlanningLinks(links);
    function renderLink(link: PlanningLink) {
        const active = link.href === activeHref;
        return <Link key={link.href} href={link.href} onClick={onNavigate} aria-current={active ? 'page' : undefined}
            className={`block border-l-2 px-3 ${mobile ? 'py-3' : 'py-1.5'} text-sm rounded-md transition-colors duration-150 ${active ? 'border-primary bg-primary-light text-primary' : 'border-transparent text-foreground-secondary hover:text-foreground hover:bg-sidebar-hover'}`}>
            {link.name}
        </Link>;
    }
    return <div className="space-y-0.5">
        {direct.map(renderLink)}
        {groups.map(group => {
            const open = expanded.has(group.id);
            const active = group.links.some(link => link.href === activeHref);
            const id = `${prefix}-${group.id}`;
            return <div key={group.id}>
                <button type="button" aria-expanded={open} aria-controls={id} onClick={() => toggle(group.id)}
                    className={`flex w-full items-center gap-2 rounded-md px-3 ${mobile ? 'py-3' : 'py-2'} text-left text-sm transition-colors duration-150 hover:bg-sidebar-hover ${active ? 'text-primary' : 'text-foreground-secondary hover:text-foreground'}`}>
                    <svg aria-hidden="true" viewBox="0 0 16 16" className={`h-3 w-3 shrink-0 transition-transform duration-150 ${open ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" strokeWidth="1.5"><path d="m6 3 5 5-5 5" /></svg>
                    <span>{group.name}</span>
                </button>
                <div id={id} hidden={!open} className="ml-3 space-y-0.5">{group.links.map(renderLink)}</div>
            </div>;
        })}
    </div>;
}

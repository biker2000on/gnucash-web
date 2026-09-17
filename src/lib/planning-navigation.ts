import { FEATURES } from './feature-registry';

export const PLANNING_GROUPS = [
    { id: 'cash-flow', name: 'Cash Flow & Spending', features: ['tool-forecast', 'tool-paycheck', 'tool-subscriptions', 'tool-anomalies', 'personal-price-index'] },
    { id: 'debt', name: 'Debt & What-ifs', features: ['tool-debt', 'tool-debt-vs-invest', 'tool-scenario'] },
    { id: 'retirement', name: 'Retirement', features: ['tool-fire', 'tool-drawdown', 'retirement-income-sequencing'] },
    { id: 'family', name: 'Family & Goals', features: ['education-planner', 'trip-budgets', 'family-banking', 'charitable-giving'] },
    { id: 'home', name: 'Home & Vehicles', features: ['home-inventory', 'home-maintenance', 'utilities-solar', 'home-documents', 'vehicle-tco', 'mileage-log'] },
    { id: 'protection', name: 'Protection & Estate', features: ['home-protection', 'tool-renewals', 'estate-readiness', 'tool-emergency'] },
    { id: 'review', name: 'Review & Data', features: ['tool-digest', 'tool-time-machine', 'tool-data-health'] },
] as const;

export type PlanningLink = { name: string; href: string };

/** Group only links already allowed by the sidebar's book/permission filters. */
export function groupPlanningLinks(links: PlanningLink[]) {
    const byHref = new Map(links.map(link => [link.href, link]));
    const grouped = new Set<string>();
    const groups = PLANNING_GROUPS.map(group => ({
        id: group.id,
        name: group.name,
        links: group.features.flatMap(id => {
            const feature = FEATURES.find(f => f.id === id);
            const link = feature && byHref.get(feature.href);
            if (!link) return [];
            grouped.add(link.href);
            return [link];
        }),
    })).filter(group => group.links.length > 0);
    // Living Plan stays direct. New unmapped links remain reachable as well.
    return { direct: links.filter(link => !grouped.has(link.href)), groups };
}

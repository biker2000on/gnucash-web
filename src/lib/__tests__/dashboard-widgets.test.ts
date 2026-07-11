import { describe, it, expect } from 'vitest';
import {
    DEFAULT_LAYOUT,
    ALL_WIDGET_IDS,
    WIDGET_META,
    isCustomWidgetId,
    sanitizeLayout,
} from '@/lib/dashboard-layout';
import {
    WIDGET_REGISTRY,
    CATEGORY_ORDER,
    availableWidgets,
    getRegistryEntry,
    registryCoversAllWidgets,
    validateCustomWidgetDef,
    sanitizeCustomWidgetDefs,
    createCustomWidgetId,
    describeCustomWidget,
    isChartViz,
    resolveDashboardKeys,
    pickDashboardPref,
    LAYOUT_PREF_KEY,
    CUSTOM_WIDGETS_PREF_KEY,
    DEFAULT_SERIES_MONTHS,
    MAX_CUSTOM_WIDGET_ACCOUNTS,
    MAX_CUSTOM_WIDGETS,
    type CustomWidgetDef,
} from '@/lib/dashboard-widgets';

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

describe('widget registry', () => {
    it('covers every builtin widget id exactly once', () => {
        expect(registryCoversAllWidgets()).toBe(true);
        expect(WIDGET_REGISTRY.length).toBe(ALL_WIDGET_IDS.length);
        const ids = WIDGET_REGISTRY.map(e => e.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('uses only known categories', () => {
        for (const entry of WIDGET_REGISTRY) {
            expect(CATEGORY_ORDER).toContain(entry.category);
        }
    });

    it('mirrors WIDGET_META titles/descriptions', () => {
        for (const entry of WIDGET_REGISTRY) {
            expect(entry.title).toBe(WIDGET_META[entry.id].title);
            expect(entry.description).toBe(WIDGET_META[entry.id].description);
        }
    });

    it('hides business-only widgets on household books', () => {
        const household = availableWidgets({ isBusiness: false });
        expect(household.some(e => e.id === 'ar-ap')).toBe(false);
        expect(household.some(e => e.businessOnly)).toBe(false);
        // Everything else is still there.
        expect(household.length).toBe(
            WIDGET_REGISTRY.filter(e => !e.businessOnly).length
        );
    });

    it('shows business-only widgets on business books', () => {
        const business = availableWidgets({ isBusiness: true });
        expect(business.some(e => e.id === 'ar-ap')).toBe(true);
        expect(business.length).toBe(WIDGET_REGISTRY.length);
    });

    it('getRegistryEntry finds entries by id and misses unknowns', () => {
        expect(getRegistryEntry('goals')?.category).toBe('overview');
        expect(getRegistryEntry('nope')).toBeUndefined();
    });
});

/* ------------------------------------------------------------------ */
/* sanitizeLayout backward compatibility                               */
/* ------------------------------------------------------------------ */

describe('sanitizeLayout', () => {
    it('accepts a pre-composable saved layout unchanged (backward compat)', () => {
        const legacy = [
            { id: 'kpis', width: 'full' },
            { id: 'netWorth', width: 'full' },
            { id: 'sankey', width: 'full' },
            { id: 'incomePie', width: 'third' },
            { id: 'expensePie', width: 'third' },
            { id: 'taxPie', width: 'third' },
            { id: 'cashFlow', width: 'full' },
        ];
        expect(sanitizeLayout(legacy)).toEqual(legacy);
    });

    it('default layout is the pre-composable widget set', () => {
        expect(DEFAULT_LAYOUT.map(i => i.id)).toEqual([
            'kpis',
            'netWorth',
            'sankey',
            'incomePie',
            'expensePie',
            'taxPie',
            'cashFlow',
        ]);
    });

    it('accepts new builtin widget ids', () => {
        const layout = sanitizeLayout([
            { id: 'goals', width: 'third' },
            { id: 'data-health', width: 'half' },
        ]);
        expect(layout).toEqual([
            { id: 'goals', width: 'third' },
            { id: 'data-health', width: 'half' },
        ]);
    });

    it('keeps custom ids only when a matching definition exists', () => {
        const saved = [
            { id: 'kpis', width: 'full' },
            { id: 'custom:abc', width: 'third' },
            { id: 'custom:gone', width: 'third' },
        ];
        expect(sanitizeLayout(saved, ['custom:abc'])).toEqual([
            { id: 'kpis', width: 'full' },
            { id: 'custom:abc', width: 'third' },
        ]);
        // Without known custom ids, custom entries are dropped gracefully.
        expect(sanitizeLayout(saved)).toEqual([{ id: 'kpis', width: 'full' }]);
    });

    it('drops unknown ids, duplicates, and normalizes bad widths', () => {
        const layout = sanitizeLayout([
            { id: 'kpis', width: 'huge' },
            { id: 'kpis', width: 'full' },
            { id: 'mystery-widget', width: 'full' },
            'garbage',
            null,
        ]);
        expect(layout).toEqual([{ id: 'kpis', width: 'full' }]);
    });

    it('returns null for unusable values', () => {
        expect(sanitizeLayout(null)).toBeNull();
        expect(sanitizeLayout('nope')).toBeNull();
        expect(sanitizeLayout([])).toBeNull();
        expect(sanitizeLayout([{ id: 'unknown', width: 'full' }])).toBeNull();
    });
});

/* ------------------------------------------------------------------ */
/* Custom widget definitions                                           */
/* ------------------------------------------------------------------ */

function validDef(overrides: Partial<CustomWidgetDef> = {}): CustomWidgetDef {
    return {
        id: 'custom:11111111-2222-3333-4444-555555555555',
        name: 'Emergency fund',
        config: { mode: 'balance', accountGuids: ['a1', 'a2'], toneBySign: false },
        viz: 'stat',
        ...overrides,
    };
}

describe('validateCustomWidgetDef', () => {
    it('accepts a valid balance def', () => {
        const def = validateCustomWidgetDef(validDef());
        expect(def).not.toBeNull();
        expect(def!.config.mode).toBe('balance');
        expect(def!.config.accountGuids).toEqual(['a1', 'a2']);
        expect(def!.config.days).toBeUndefined();
    });

    it('defaults spend days to 90 and validates allowed values', () => {
        const spend = validateCustomWidgetDef(
            validDef({ config: { mode: 'spend', accountGuids: ['a1'] } })
        );
        expect(spend!.config.days).toBe(90);

        const spend30 = validateCustomWidgetDef(
            validDef({ config: { mode: 'spend', accountGuids: ['a1'], days: 30 } })
        );
        expect(spend30!.config.days).toBe(30);

        const spendBad = validateCustomWidgetDef(
            validDef({ config: { mode: 'spend', accountGuids: ['a1'], days: 45 as never } })
        );
        expect(spendBad!.config.days).toBe(90);
    });

    it('rejects bad ids, names, modes, and account lists', () => {
        expect(validateCustomWidgetDef(null)).toBeNull();
        expect(validateCustomWidgetDef({})).toBeNull();
        expect(validateCustomWidgetDef(validDef({ id: 'kpis' as never }))).toBeNull();
        expect(validateCustomWidgetDef(validDef({ id: 'custom:' as never }))).toBeNull();
        expect(validateCustomWidgetDef(validDef({ name: '   ' }))).toBeNull();
        expect(
            validateCustomWidgetDef(
                validDef({ config: { mode: 'chart' as never, accountGuids: ['a1'] } })
            )
        ).toBeNull();
        expect(
            validateCustomWidgetDef(validDef({ config: { mode: 'balance', accountGuids: [] } }))
        ).toBeNull();
        expect(
            validateCustomWidgetDef(
                validDef({ config: { mode: 'balance', accountGuids: [42 as never] } })
            )
        ).toBeNull();
    });

    it('dedupes and caps account guids', () => {
        const many = Array.from({ length: 50 }, (_, i) => `acct-${i}`);
        const def = validateCustomWidgetDef(
            validDef({ config: { mode: 'balance', accountGuids: ['a1', 'a1', ...many] } })
        );
        expect(def!.config.accountGuids.length).toBe(MAX_CUSTOM_WIDGET_ACCOUNTS);
        expect(new Set(def!.config.accountGuids).size).toBe(def!.config.accountGuids.length);
    });
});

/* ------------------------------------------------------------------ */
/* viz: chart-type custom widgets                                      */
/* ------------------------------------------------------------------ */

describe('validateCustomWidgetDef viz handling', () => {
    it('defaults missing viz to stat (v1 defs, backward compat)', () => {
        const noViz: Record<string, unknown> = { ...validDef() };
        delete noViz.viz;
        const def = validateCustomWidgetDef(noViz);
        expect(def!.viz).toBe('stat');
        expect(def!.config.months).toBeUndefined();
    });

    it('coerces unknown viz values to stat instead of dropping the def', () => {
        const def = validateCustomWidgetDef(validDef({ viz: 'pie' as never }));
        expect(def).not.toBeNull();
        expect(def!.viz).toBe('stat');
    });

    it('accepts spark and bar viz', () => {
        expect(validateCustomWidgetDef(validDef({ viz: 'spark' }))!.viz).toBe('spark');
        expect(validateCustomWidgetDef(validDef({ viz: 'bar' }))!.viz).toBe('bar');
        expect(isChartViz('spark')).toBe(true);
        expect(isChartViz('bar')).toBe(true);
        expect(isChartViz('stat')).toBe(false);
        expect(isChartViz(undefined)).toBe(false);
    });

    it('defaults chart months to 12 and validates allowed values', () => {
        const dflt = validateCustomWidgetDef(validDef({ viz: 'spark' }));
        expect(dflt!.config.months).toBe(DEFAULT_SERIES_MONTHS);

        const six = validateCustomWidgetDef(
            validDef({ viz: 'bar', config: { mode: 'balance', accountGuids: ['a1'], months: 6 } })
        );
        expect(six!.config.months).toBe(6);

        const bad = validateCustomWidgetDef(
            validDef({ viz: 'spark', config: { mode: 'balance', accountGuids: ['a1'], months: 7 as never } })
        );
        expect(bad!.config.months).toBe(12);
    });

    it('stat defs never carry months; chart defs never carry days', () => {
        const stat = validateCustomWidgetDef(
            validDef({ config: { mode: 'balance', accountGuids: ['a1'], months: 6 } })
        );
        expect(stat!.config.months).toBeUndefined();

        const chartSpend = validateCustomWidgetDef(
            validDef({ viz: 'bar', config: { mode: 'spend', accountGuids: ['a1'], days: 30 } })
        );
        expect(chartSpend!.config.days).toBeUndefined();
        expect(chartSpend!.config.months).toBe(DEFAULT_SERIES_MONTHS);
    });

    it('spend stat defs keep the days window', () => {
        const spendStat = validateCustomWidgetDef(
            validDef({ config: { mode: 'spend', accountGuids: ['a1'], days: 30 } })
        );
        expect(spendStat!.config.days).toBe(30);
    });

    it('sanitizeCustomWidgetDefs keeps chart defs alongside stat defs', () => {
        const defs = sanitizeCustomWidgetDefs([
            validDef(),
            validDef({ id: 'custom:spark-1' as CustomWidgetDef['id'], viz: 'spark' }),
            validDef({ id: 'custom:bar-1' as CustomWidgetDef['id'], viz: 'bar' }),
        ]);
        expect(defs.map(d => d.viz)).toEqual(['stat', 'spark', 'bar']);
    });

    it('describeCustomWidget summarizes chart configs', () => {
        expect(
            describeCustomWidget(
                validDef({ viz: 'spark', config: { mode: 'balance', accountGuids: ['a1'], months: 6 } })
            )
        ).toBe('Balance of 1 account, monthly, 6mo');
        expect(
            describeCustomWidget(
                validDef({ viz: 'bar', config: { mode: 'spend', accountGuids: ['a1', 'a2'], months: 24 } })
            )
        ).toBe('Monthly spend across 2 accounts, 24mo');
    });
});

/* ------------------------------------------------------------------ */
/* Per-book preference keys                                            */
/* ------------------------------------------------------------------ */

describe('resolveDashboardKeys', () => {
    it('builds per-book keys from a book guid', () => {
        const keys = resolveDashboardKeys('abc123');
        expect(keys.layoutKey).toBe('dashboard.layout.abc123');
        expect(keys.customWidgetsKey).toBe('dashboard.customWidgets.abc123');
        expect(keys.legacyLayoutKey).toBe(LAYOUT_PREF_KEY);
        expect(keys.legacyCustomWidgetsKey).toBe(CUSTOM_WIDGETS_PREF_KEY);
    });

    it('degrades to legacy global keys without a book guid', () => {
        for (const guid of [null, undefined, '', '   ']) {
            const keys = resolveDashboardKeys(guid);
            expect(keys.layoutKey).toBe(LAYOUT_PREF_KEY);
            expect(keys.customWidgetsKey).toBe(CUSTOM_WIDGETS_PREF_KEY);
        }
    });

    it('trims whitespace around the guid', () => {
        expect(resolveDashboardKeys(' abc ').layoutKey).toBe('dashboard.layout.abc');
    });
});

describe('pickDashboardPref', () => {
    const perBookKey = 'dashboard.layout.book1';
    const legacyKey = LAYOUT_PREF_KEY;

    it('prefers the per-book value when present', () => {
        const prefs = { [perBookKey]: ['per-book'], [legacyKey]: ['legacy'] };
        expect(pickDashboardPref(prefs, perBookKey, legacyKey)).toEqual(['per-book']);
    });

    it('falls back to the legacy value when the per-book key is absent', () => {
        const prefs = { [legacyKey]: ['legacy'] };
        expect(pickDashboardPref(prefs, perBookKey, legacyKey)).toEqual(['legacy']);
    });

    it('treats a null per-book value as absent', () => {
        const prefs = { [perBookKey]: null, [legacyKey]: ['legacy'] };
        expect(pickDashboardPref(prefs, perBookKey, legacyKey)).toEqual(['legacy']);
    });

    it('returns undefined when neither key has a value', () => {
        expect(pickDashboardPref({}, perBookKey, legacyKey)).toBeUndefined();
        expect(pickDashboardPref(null, perBookKey, legacyKey)).toBeUndefined();
        expect(pickDashboardPref(undefined, perBookKey, legacyKey)).toBeUndefined();
    });

    it('does not double-read when per-book and legacy keys are the same (no book guid)', () => {
        const prefs = { [legacyKey]: ['legacy'] };
        expect(pickDashboardPref(prefs, legacyKey, legacyKey)).toEqual(['legacy']);
        expect(pickDashboardPref({ [legacyKey]: null }, legacyKey, legacyKey)).toBeUndefined();
    });
});

describe('sanitizeCustomWidgetDefs', () => {
    it('returns [] for non-arrays', () => {
        expect(sanitizeCustomWidgetDefs(null)).toEqual([]);
        expect(sanitizeCustomWidgetDefs('x')).toEqual([]);
        expect(sanitizeCustomWidgetDefs({})).toEqual([]);
    });

    it('drops invalid entries and duplicate ids', () => {
        const good = validDef();
        const dup = validDef({ name: 'Duplicate id' });
        const bad = validDef({ name: '' });
        const defs = sanitizeCustomWidgetDefs([good, dup, bad, 'junk', null]);
        expect(defs.length).toBe(1);
        expect(defs[0].name).toBe('Emergency fund');
    });

    it('caps the number of definitions', () => {
        const many = Array.from({ length: MAX_CUSTOM_WIDGETS + 10 }, (_, i) =>
            validDef({ id: `custom:def-${i}` as CustomWidgetDef['id'] })
        );
        expect(sanitizeCustomWidgetDefs(many).length).toBe(MAX_CUSTOM_WIDGETS);
    });
});

describe('custom widget helpers', () => {
    it('createCustomWidgetId produces unique custom ids', () => {
        const a = createCustomWidgetId();
        const b = createCustomWidgetId();
        expect(isCustomWidgetId(a)).toBe(true);
        expect(isCustomWidgetId(b)).toBe(true);
        expect(a).not.toBe(b);
    });

    it('describeCustomWidget summarizes the config', () => {
        expect(describeCustomWidget(validDef())).toBe('Balance of 2 accounts');
        expect(
            describeCustomWidget(
                validDef({ config: { mode: 'spend', accountGuids: ['a1'], days: 365 } })
            )
        ).toBe('Spend across 1 account, last 365d');
    });
});

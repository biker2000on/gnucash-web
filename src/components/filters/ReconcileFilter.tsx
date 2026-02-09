'use client';

export const RECONCILE_STATES = [
    { value: 'n', label: 'Not Reconciled', shortLabel: 'N', color: 'neutral' },
    { value: 'c', label: 'Cleared', shortLabel: 'C', color: 'amber' },
    { value: 'y', label: 'Reconciled', shortLabel: 'R', color: 'emerald' },
] as const;

interface ReconcileFilterProps {
    selectedStates: string[];
    onChange: (states: string[]) => void;
}

export function ReconcileFilter({ selectedStates, onChange }: ReconcileFilterProps) {
    const toggleState = (state: string) => {
        if (selectedStates.includes(state)) {
            onChange(selectedStates.filter(s => s !== state));
        } else {
            onChange([...selectedStates, state]);
        }
    };

    const colorClasses: Record<string, { selected: string; unselected: string }> = {
        neutral: {
            selected: 'bg-surface/20 border-surface/50 text-foreground-secondary',
            unselected: 'bg-background-tertiary/50 border-border-hover text-foreground-muted hover:border-border-hover',
        },
        amber: {
            selected: 'bg-amber-500/20 border-amber-500/50 text-amber-400',
            unselected: 'bg-background-tertiary/50 border-border-hover text-foreground-muted hover:border-border-hover',
        },
        emerald: {
            selected: 'bg-emerald-500/20 border-emerald-500/50 text-emerald-400',
            unselected: 'bg-background-tertiary/50 border-border-hover text-foreground-muted hover:border-border-hover',
        },
    };

    return (
        <div>
            <label className="block text-xs text-foreground-muted uppercase tracking-wider mb-2">
                Reconciliation Status
            </label>
            <div className="flex gap-2">
                {RECONCILE_STATES.map(state => {
                    const isSelected = selectedStates.includes(state.value);
                    const colors = colorClasses[state.color];
                    return (
                        <button
                            key={state.value}
                            onClick={() => toggleState(state.value)}
                            className={`flex-1 px-3 py-2 text-sm rounded-lg border transition-all flex items-center justify-center gap-2 ${
                                isSelected ? colors.selected : colors.unselected
                            }`}
                            title={state.label}
                        >
                            <span className="font-mono font-bold">{state.shortLabel}</span>
                            <span className="text-xs hidden sm:inline">{state.label}</span>
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

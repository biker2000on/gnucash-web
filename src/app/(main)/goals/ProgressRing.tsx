'use client';

interface ProgressRingProps {
    /** 0..100 */
    pct: number;
    /** Ring color: CSS var-backed tailwind color token name. */
    tone: 'primary' | 'positive' | 'warning';
    size?: number;
    label?: string;
}

const strokeVar: Record<ProgressRingProps['tone'], string> = {
    primary: 'var(--primary)',
    positive: 'var(--positive)',
    warning: 'var(--warning)',
};

/**
 * Compact donut progress ring. Track + filled arc, centered percentage.
 * No gradients (per DESIGN.md) — solid tokened colors only.
 */
export function ProgressRing({ pct, tone, size = 72, label }: ProgressRingProps) {
    const clamped = Math.max(0, Math.min(100, pct));
    const stroke = 7;
    const r = (size - stroke) / 2;
    const circ = 2 * Math.PI * r;
    const offset = circ * (1 - clamped / 100);

    return (
        <div className="relative shrink-0" style={{ width: size, height: size }}>
            <svg width={size} height={size} className="-rotate-90">
                <circle
                    cx={size / 2}
                    cy={size / 2}
                    r={r}
                    fill="none"
                    stroke="var(--border)"
                    strokeWidth={stroke}
                />
                <circle
                    cx={size / 2}
                    cy={size / 2}
                    r={r}
                    fill="none"
                    stroke={strokeVar[tone]}
                    strokeWidth={stroke}
                    strokeDasharray={circ}
                    strokeDashoffset={offset}
                    strokeLinecap="round"
                    style={{ transition: 'stroke-dashoffset 300ms ease-out' }}
                />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
                <span className="font-mono text-sm font-semibold text-foreground tabular-nums">
                    {Math.round(clamped)}%
                </span>
                {label && <span className="text-[10px] text-foreground-muted">{label}</span>}
            </div>
        </div>
    );
}

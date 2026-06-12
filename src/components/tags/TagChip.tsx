'use client';

/**
 * Small colored tag chip (modeled on ledger/LotBadge).
 * Colors are stored by name in gnucash_web_tags.color and mapped to
 * tailwind tint/border classes here.
 */

export const TAG_COLOR_CLASSES: Record<string, string> = {
    blue: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
    emerald: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
    amber: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
    purple: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
    cyan: 'bg-cyan-500/20 text-cyan-400 border-cyan-500/30',
    rose: 'bg-rose-500/20 text-rose-400 border-rose-500/30',
    orange: 'bg-orange-500/20 text-orange-400 border-orange-500/30',
    teal: 'bg-teal-500/20 text-teal-400 border-teal-500/30',
    indigo: 'bg-indigo-500/20 text-indigo-400 border-indigo-500/30',
    pink: 'bg-pink-500/20 text-pink-400 border-pink-500/30',
    lime: 'bg-lime-500/20 text-lime-400 border-lime-500/30',
    sky: 'bg-sky-500/20 text-sky-400 border-sky-500/30',
};

const DEFAULT_COLOR_CLASS = 'bg-foreground-muted/10 text-foreground-secondary border-foreground-muted/20';

export function tagColorClass(color?: string | null): string {
    return (color && TAG_COLOR_CLASSES[color]) || DEFAULT_COLOR_CLASS;
}

interface TagChipProps {
    name: string;
    color?: string | null;
    size?: 'xs' | 'sm';
    onClick?: () => void;
    onRemove?: () => void;
    className?: string;
    title?: string;
}

export default function TagChip({ name, color, size = 'xs', onClick, onRemove, className = '', title }: TagChipProps) {
    const sizeClass = size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-1.5 py-0.5 text-[10px]';
    const interactive = onClick ? 'cursor-pointer hover:brightness-125 transition-all' : 'cursor-default';

    return (
        <span
            onClick={onClick ? (e) => { e.stopPropagation(); onClick(); } : undefined}
            title={title}
            className={`inline-flex items-center gap-1 rounded font-medium border whitespace-nowrap ${sizeClass} ${tagColorClass(color)} ${interactive} ${className}`}
        >
            <span aria-hidden="true" className="opacity-70">#</span>
            {name}
            {onRemove && (
                <button
                    type="button"
                    onClick={(e) => {
                        e.stopPropagation();
                        onRemove();
                    }}
                    aria-label={`Remove tag ${name}`}
                    className="ml-0.5 -mr-0.5 rounded hover:bg-white/10 leading-none"
                >
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                </button>
            )}
        </span>
    );
}

/**
 * Tagging utilities: tag-name normalization/validation, the shared color
 * palette, and #tag search-query parsing.
 *
 * Tag names are stored lowercase, without a leading '#', and must match
 * /^[a-z0-9_-]+$/ (max 100 chars).
 */

export interface Tag {
    id: number;
    name: string;
    color: string | null;
    description?: string | null;
    transaction_count?: number;
    account_count?: number;
}

/** Color names persisted in gnucash_web_tags.color (VARCHAR(20)). */
export const TAG_COLORS = [
    'blue',
    'emerald',
    'amber',
    'purple',
    'cyan',
    'rose',
    'orange',
    'teal',
    'indigo',
    'pink',
    'lime',
    'sky',
] as const;

export type TagColor = (typeof TAG_COLORS)[number];

const TAG_NAME_RE = /^[a-z0-9_-]{1,100}$/;

/**
 * Normalize a raw user-entered tag name: trim, strip leading '#' characters,
 * lowercase, and convert internal whitespace runs to single hyphens.
 * Does NOT guarantee validity — call isValidTagName on the result.
 */
export function normalizeTagName(raw: string): string {
    return raw
        .trim()
        .replace(/^#+/, '')
        .toLowerCase()
        .replace(/\s+/g, '-');
}

/** True when name is already a valid stored tag name ([a-z0-9_-]{1,100}). */
export function isValidTagName(name: string): boolean {
    return TAG_NAME_RE.test(name);
}

/**
 * Pick a color for a new tag: the least-used color in the palette
 * (ties broken by palette order), so colors cycle evenly.
 */
export function pickTagColor(usedColors: Array<string | null | undefined>): TagColor {
    const counts = new Map<string, number>(TAG_COLORS.map(c => [c, 0]));
    for (const color of usedColors) {
        if (color && counts.has(color)) {
            counts.set(color, (counts.get(color) ?? 0) + 1);
        }
    }
    let best: TagColor = TAG_COLORS[0];
    let bestCount = Number.POSITIVE_INFINITY;
    for (const color of TAG_COLORS) {
        const count = counts.get(color) ?? 0;
        if (count < bestCount) {
            best = color;
            bestCount = count;
        }
    }
    return best;
}

export interface ParsedSearchQuery {
    /** Free-text portion of the search with #tag tokens removed. */
    text: string;
    /** Lowercased, deduplicated tag names extracted from #tag tokens. */
    tags: string[];
}

/**
 * Parse a ledger search string into free text + #tag filters.
 *
 * Tokens matching /#([a-z0-9_-]+)/gi become tag filters (AND semantics);
 * everything else remains as the text search, with whitespace collapsed.
 *
 * Examples:
 *   parseSearchQuery('groceries #vacation')       -> { text: 'groceries', tags: ['vacation'] }
 *   parseSearchQuery('#a #B coffee #a')           -> { text: 'coffee', tags: ['a', 'b'] }
 *   parseSearchQuery('item #123 desc')            -> { text: 'item desc', tags: ['123'] }
 */
export function parseSearchQuery(search: string): ParsedSearchQuery {
    const tags: string[] = [];
    const seen = new Set<string>();

    const text = (search || '')
        .replace(/#([a-z0-9_-]+)/gi, (_match, name: string) => {
            const normalized = name.toLowerCase();
            if (!seen.has(normalized)) {
                seen.add(normalized);
                tags.push(normalized);
            }
            return ' ';
        })
        .replace(/\s+/g, ' ')
        .trim();

    return { text, tags };
}

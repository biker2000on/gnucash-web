/**
 * Format an account path for display. The materialized `fullname` GnuCash
 * returns always starts with the root account (e.g. "Root Account" or the
 * book name), which is not useful in a picker — strip whatever the first
 * colon-delimited segment is. If there is no separator, fall back to the
 * bare account name.
 */
export function formatAccountPath(fullname: string | undefined, name: string): string {
    const path = fullname || name;
    const idx = path.indexOf(':');
    if (idx >= 0) return path.slice(idx + 1);
    return path;
}

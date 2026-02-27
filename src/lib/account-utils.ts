/**
 * Format an account path for display, stripping "Root Account:" and book name prefixes.
 */
export function formatAccountPath(fullname: string | undefined, name: string, bookName?: string): string {
    let path = fullname || name;
    if (path.startsWith('Root Account:')) path = path.substring('Root Account:'.length);
    if (bookName && path.startsWith(bookName + ':')) path = path.substring(bookName.length + 1);
    return path;
}

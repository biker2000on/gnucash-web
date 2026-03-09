export function formatDisplayAccountPath(accountPath?: string | null, fallbackName?: string): string {
    if (!accountPath) {
        return fallbackName || '';
    }

    const segments = accountPath.split(':').filter(Boolean);

    if (segments[0] === 'Root Account') {
        segments.shift();
    } else if (segments[1] === 'Root Account') {
        segments.splice(0, 2);
    }

    return segments.join(':') || fallbackName || '';
}

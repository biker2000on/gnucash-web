/**
 * Deterministic reload decision for a service-worker controller change.
 *
 * `public/sw.js` calls `self.skipWaiting()` during install, so a newly
 * installed worker can activate before the page ever observes
 * `registration.waiting`. The page's "did I ask for this?" flag is therefore
 * unreliable: `controllerchange` fires, the flag is false, no reload happens,
 * and the tab keeps running the previous deploy's JS under a brand-new
 * controller. That is how a v2-era runtime survived the v3 rollout.
 *
 * The reliable signal is `navigator.serviceWorker.controller`: if the document
 * ALREADY had a controller before the change, the worker underneath it was
 * swapped and the page must reload to match. A document that had no controller
 * (first-ever registration) must NOT reload — nothing changed for it.
 */

/** sessionStorage key holding the timestamp of the last controller reload. */
export const CONTROLLER_RELOAD_GUARD_KEY = 'pwa-controller-reload-at';

/**
 * How long after a controller reload another one is suppressed. Long enough to
 * break a reload loop (a broken worker re-activating on every load), short
 * enough that a genuine second deploy later in the same session still reloads.
 */
export const CONTROLLER_RELOAD_GUARD_MS = 10_000;

export interface ControllerChangeReloadInput {
    /** Was `navigator.serviceWorker.controller` set before this change? */
    hadController: boolean;
    /** Did the page explicitly post SKIP_WAITING to a waiting worker? */
    reloadRequested: boolean;
    /** Has a controller reload already happened inside the guard window? */
    alreadyReloaded: boolean;
}

export function shouldReloadOnControllerChange({
    hadController,
    reloadRequested,
    alreadyReloaded,
}: ControllerChangeReloadInput): boolean {
    if (alreadyReloaded) {
        return false;
    }

    return hadController || reloadRequested;
}

/** True when a controller reload happened within the guard window. */
export function hasRecentControllerReload(
    now: number = Date.now(),
    storage: Pick<Storage, 'getItem'> | undefined = safeSessionStorage(),
): boolean {
    if (!storage) {
        return false;
    }

    const raw = storage.getItem(CONTROLLER_RELOAD_GUARD_KEY);
    if (!raw) {
        return false;
    }

    const at = Number(raw);
    if (!Number.isFinite(at)) {
        return false;
    }

    return now - at >= 0 && now - at < CONTROLLER_RELOAD_GUARD_MS;
}

export function markControllerReload(
    now: number = Date.now(),
    storage: Pick<Storage, 'setItem'> | undefined = safeSessionStorage(),
): void {
    try {
        storage?.setItem(CONTROLLER_RELOAD_GUARD_KEY, String(now));
    } catch {
        // Private-mode / quota failures must never block the reload itself.
    }
}

function safeSessionStorage(): Storage | undefined {
    if (typeof window === 'undefined') {
        return undefined;
    }

    try {
        return window.sessionStorage;
    } catch {
        return undefined;
    }
}

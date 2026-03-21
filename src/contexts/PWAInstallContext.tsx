'use client';

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    useSyncExternalStore,
} from 'react';
import { usePathname } from 'next/navigation';

const LOGIN_INSTALL_PENDING_KEY = 'pwa-install-pending-after-login';
const LOGIN_INSTALL_DISMISSED_KEY = 'pwa-install-auto-prompt-dismissed';
const INSTALL_STATE_CHANGE_EVENT = 'pwa-install-state-change';

interface BeforeInstallPromptEvent extends Event {
    prompt: () => Promise<void>;
    userChoice: Promise<{
        outcome: 'accepted' | 'dismissed';
        platform: string;
    }>;
}

interface NavigatorWithStandalone extends Navigator {
    standalone?: boolean;
}

type InstallResult = 'accepted' | 'dismissed' | 'unavailable';

interface PWAInstallContextValue {
    canInstall: boolean;
    isInstalled: boolean;
    isIos: boolean;
    isAndroid: boolean;
    isMobile: boolean;
    isSafari: boolean;
    showLoginInstallPrompt: boolean;
    promptInstall: () => Promise<InstallResult>;
    dismissLoginInstallPrompt: () => void;
}

const PWAInstallContext = createContext<PWAInstallContextValue | null>(null);

function isStandaloneMode() {
    if (typeof window === 'undefined') {
        return false;
    }

    return (
        window.matchMedia('(display-mode: standalone)').matches ||
        Boolean((window.navigator as NavigatorWithStandalone).standalone)
    );
}

function hasPendingLoginPrompt() {
    if (typeof window === 'undefined') {
        return false;
    }

    return sessionStorage.getItem(LOGIN_INSTALL_PENDING_KEY) === 'true';
}

function clearPendingLoginPrompt() {
    if (typeof window === 'undefined') {
        return;
    }

    sessionStorage.removeItem(LOGIN_INSTALL_PENDING_KEY);
    window.dispatchEvent(new Event(INSTALL_STATE_CHANGE_EVENT));
}

function hasDismissedAutoPrompt() {
    if (typeof window === 'undefined') {
        return false;
    }

    return localStorage.getItem(LOGIN_INSTALL_DISMISSED_KEY) === 'true';
}

function setDismissedAutoPrompt() {
    if (typeof window === 'undefined') {
        return;
    }

    localStorage.setItem(LOGIN_INSTALL_DISMISSED_KEY, 'true');
    window.dispatchEvent(new Event(INSTALL_STATE_CHANGE_EVENT));
}

function clearDismissedAutoPrompt() {
    if (typeof window === 'undefined') {
        return;
    }

    localStorage.removeItem(LOGIN_INSTALL_DISMISSED_KEY);
    window.dispatchEvent(new Event(INSTALL_STATE_CHANGE_EVENT));
}

function getDeviceInfo() {
    if (typeof window === 'undefined') {
        return {
            isIos: false,
            isAndroid: false,
            isMobile: false,
            isSafari: false,
        };
    }

    const userAgent = window.navigator.userAgent;

    return {
        isIos: /iPad|iPhone|iPod/.test(userAgent),
        isAndroid: /Android/.test(userAgent),
        isMobile: /Android|iPhone|iPad|iPod|Mobile/i.test(userAgent),
        isSafari: /^((?!chrome|android).)*safari/i.test(userAgent),
    };
}

function subscribeInstallState(onStoreChange: () => void) {
    if (typeof window === 'undefined') {
        return () => undefined;
    }

    const handleChange = () => {
        onStoreChange();
    };

    window.addEventListener('storage', handleChange);
    window.addEventListener(INSTALL_STATE_CHANGE_EVENT, handleChange);

    return () => {
        window.removeEventListener('storage', handleChange);
        window.removeEventListener(INSTALL_STATE_CHANGE_EVENT, handleChange);
    };
}

export function PWAInstallProvider({ children }: { children: React.ReactNode }) {
    const pathname = usePathname();
    const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
    const [isInstalled, setIsInstalled] = useState(() => isStandaloneMode());
    const reloadOnControllerChangeRef = useRef(false);
    const deviceInfo = useMemo(() => getDeviceInfo(), []);
    const pendingLoginPrompt = useSyncExternalStore(
        subscribeInstallState,
        hasPendingLoginPrompt,
        () => false
    );
    const dismissedAutoPrompt = useSyncExternalStore(
        subscribeInstallState,
        hasDismissedAutoPrompt,
        () => false
    );

    useEffect(() => {
        if (typeof window === 'undefined') {
            return;
        }

        const handleBeforeInstallPrompt = (event: Event) => {
            console.log('[PWA] beforeinstallprompt event fired', event);
            event.preventDefault();
            setDeferredPrompt(event as BeforeInstallPromptEvent);
        };

        const handleAppInstalled = () => {
            clearPendingLoginPrompt();
            clearDismissedAutoPrompt();
            setDeferredPrompt(null);
            setIsInstalled(true);
        };

        const mediaQuery = window.matchMedia('(display-mode: standalone)');
        const handleDisplayModeChange = () => {
            setIsInstalled(isStandaloneMode());
        };

        console.log('[PWA] beforeinstallprompt listener attached');
        window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
        window.addEventListener('appinstalled', handleAppInstalled);
        mediaQuery.addEventListener('change', handleDisplayModeChange);

        return () => {
            window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
            window.removeEventListener('appinstalled', handleAppInstalled);
            mediaQuery.removeEventListener('change', handleDisplayModeChange);
        };
    }, []);

    useEffect(() => {
        if (typeof window === 'undefined' || !('serviceWorker' in navigator)) {
            return;
        }

        let intervalId: number | null = null;

        const handleControllerChange = () => {
            if (!reloadOnControllerChangeRef.current) {
                return;
            }

            reloadOnControllerChangeRef.current = false;
            window.location.reload();
        };

        const registerServiceWorker = async () => {
            try {
                const registration = await navigator.serviceWorker.register('/sw.js', {
                    scope: '/',
                    updateViaCache: 'none',
                });
                console.log('[PWA] Service worker registered', { scope: registration.scope });

                const activateWaitingWorker = () => {
                    if (!registration.waiting) {
                        return;
                    }

                    reloadOnControllerChangeRef.current = true;
                    registration.waiting.postMessage({ type: 'SKIP_WAITING' });
                };

                if (registration.waiting) {
                    activateWaitingWorker();
                }

                registration.addEventListener('updatefound', () => {
                    const worker = registration.installing;
                    if (!worker) {
                        return;
                    }

                    worker.addEventListener('statechange', () => {
                        if (worker.state === 'installed' && navigator.serviceWorker.controller) {
                            activateWaitingWorker();
                        }
                    });
                });

                const handleVisibilityChange = () => {
                    if (document.visibilityState === 'visible') {
                        registration.update().catch(() => {
                            // Ignore transient update failures.
                        });
                    }
                };

                document.addEventListener('visibilitychange', handleVisibilityChange);
                intervalId = window.setInterval(() => {
                    registration.update().catch(() => {
                        // Ignore transient update failures.
                    });
                }, 5 * 60 * 1000);

                return () => {
                    document.removeEventListener('visibilitychange', handleVisibilityChange);
                };
            } catch (error) {
                console.error('[PWA] Service worker registration failed', error);
                return undefined;
            }
        };

        let cleanupRegistrationListeners: (() => void) | undefined;

        navigator.serviceWorker.addEventListener('controllerchange', handleControllerChange);

        registerServiceWorker().then((cleanup) => {
            cleanupRegistrationListeners = cleanup;
        });

        return () => {
            navigator.serviceWorker.removeEventListener('controllerchange', handleControllerChange);
            cleanupRegistrationListeners?.();
            if (intervalId) {
                window.clearInterval(intervalId);
            }
        };
    }, []);

    useEffect(() => {
        const canInstall = !isInstalled && (Boolean(deferredPrompt) || (deviceInfo.isIos && deviceInfo.isSafari));
        console.log('[PWA] Install state', {
            canInstall,
            isInstalled,
            hasDeferredPrompt: Boolean(deferredPrompt),
            ...deviceInfo,
        });
    }, [deferredPrompt, isInstalled, deviceInfo]);

    const showLoginInstallPrompt = useMemo(() => (
        !isInstalled &&
        !dismissedAutoPrompt &&
        pendingLoginPrompt &&
        pathname !== '/login' &&
        (Boolean(deferredPrompt) || (deviceInfo.isIos && deviceInfo.isSafari))
    ), [
        deferredPrompt,
        deviceInfo.isIos,
        deviceInfo.isSafari,
        dismissedAutoPrompt,
        isInstalled,
        pathname,
        pendingLoginPrompt,
    ]);

    const promptInstall = useCallback(async (): Promise<InstallResult> => {
        if (isInstalled) {
            clearPendingLoginPrompt();
            return 'accepted';
        }

        if (!deferredPrompt) {
            return 'unavailable';
        }

        await deferredPrompt.prompt();
        const { outcome } = await deferredPrompt.userChoice;

        if (outcome === 'accepted') {
            clearPendingLoginPrompt();
            setDeferredPrompt(null);
            return 'accepted';
        }

        return 'dismissed';
    }, [deferredPrompt, isInstalled]);

    const dismissLoginInstallPrompt = useCallback(() => {
        clearPendingLoginPrompt();
        setDismissedAutoPrompt();
    }, []);

    const value = useMemo<PWAInstallContextValue>(() => ({
        canInstall: !isInstalled && (Boolean(deferredPrompt) || (deviceInfo.isIos && deviceInfo.isSafari)),
        isInstalled,
        isIos: deviceInfo.isIos,
        isAndroid: deviceInfo.isAndroid,
        isMobile: deviceInfo.isMobile,
        isSafari: deviceInfo.isSafari,
        showLoginInstallPrompt,
        promptInstall,
        dismissLoginInstallPrompt,
    }), [
        deferredPrompt,
        deviceInfo.isAndroid,
        deviceInfo.isIos,
        deviceInfo.isMobile,
        deviceInfo.isSafari,
        dismissLoginInstallPrompt,
        isInstalled,
        promptInstall,
        showLoginInstallPrompt,
    ]);

    return (
        <PWAInstallContext.Provider value={value}>
            {children}
            <LoginInstallPrompt />
        </PWAInstallContext.Provider>
    );
}

function LoginInstallPrompt() {
    const {
        isIos,
        isInstalled,
        showLoginInstallPrompt,
        promptInstall,
        dismissLoginInstallPrompt,
    } = usePWAInstall();

    const [installing, setInstalling] = useState(false);

    if (!showLoginInstallPrompt || isInstalled) {
        return null;
    }

    const handleInstall = async () => {
        setInstalling(true);

        try {
            await promptInstall();
        } finally {
            setInstalling(false);
        }
    };

    return (
        <div className="fixed top-4 right-4 left-4 md:left-auto md:w-[28rem] z-50">
            <div className="rounded-2xl border border-emerald-500/30 bg-surface/95 backdrop-blur-xl shadow-2xl p-5">
                <div className="flex items-start justify-between gap-4">
                    <div>
                        <p className="text-sm font-semibold text-foreground">Install GnuCash Web</p>
                        <p className="mt-1 text-sm text-foreground-muted">
                            {isIos
                                ? 'Add this app to your home screen for a full-screen mobile experience.'
                                : 'Install the app now so it opens from your home screen and works like a native app.'}
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={dismissLoginInstallPrompt}
                        className="text-foreground-muted hover:text-foreground transition-colors"
                        aria-label="Dismiss install prompt"
                    >
                        ×
                    </button>
                </div>

                {isIos ? (
                    <div className="mt-4 rounded-xl border border-border bg-background/60 px-4 py-3 text-sm text-foreground-secondary">
                        Open Safari’s share menu, then choose <span className="font-medium text-foreground">Add to Home Screen</span>.
                    </div>
                ) : (
                    <div className="mt-4 flex items-center gap-3">
                        <button
                            type="button"
                            onClick={handleInstall}
                            disabled={installing}
                            className="rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:bg-emerald-600/50 px-4 py-2 text-sm font-medium text-white transition-colors"
                        >
                            {installing ? 'Opening...' : 'Install App'}
                        </button>
                        <button
                            type="button"
                            onClick={dismissLoginInstallPrompt}
                            className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground-secondary hover:text-foreground hover:border-border-hover transition-colors"
                        >
                            Not now
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}

export function usePWAInstall() {
    const context = useContext(PWAInstallContext);

    if (!context) {
        throw new Error('usePWAInstall must be used within a PWAInstallProvider');
    }

    return context;
}

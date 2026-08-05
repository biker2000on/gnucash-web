import { defineConfig, devices } from '@playwright/test';

const localBaseUrl = 'http://127.0.0.1:3010';
const externalBaseUrl = process.env.E2E_BASE_URL;

export default defineConfig({
    testDir: './tests/e2e',
    // The ledger review suite depends on a seeded private book. Keep it out of
    // the default CI run until the demo seed is available; operators can opt
    // in explicitly with credentials.
    testIgnore: process.env.RUN_LEDGER_E2E === '1' ? [] : ['**/review-mode.spec.ts'],
    fullyParallel: false,
    retries: 0,
    timeout: 60000,
    expect: {
        timeout: 10000,
    },
    use: {
        baseURL: externalBaseUrl ?? localBaseUrl,
        trace: 'on-first-retry',
        screenshot: 'only-on-failure',
    },
    webServer: externalBaseUrl ? undefined : {
        command: 'npm run start -- -p 3010 --hostname 127.0.0.1',
        url: `${localBaseUrl}/favicon.svg`,
        reuseExistingServer: false,
        timeout: 120000,
    },
    projects: [
        {
            name: 'chromium',
            use: { ...devices['Desktop Chrome'] },
        },
    ],
});

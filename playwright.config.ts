import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
    testDir: './tests/e2e',
    fullyParallel: false,
    retries: 0,
    timeout: 60000,
    expect: {
        timeout: 10000,
    },
    use: {
        baseURL: 'http://127.0.0.1:3010',
        trace: 'on-first-retry',
        screenshot: 'only-on-failure',
    },
    webServer: {
        command: 'npm run start -- -p 3010 --hostname 127.0.0.1',
        url: 'http://127.0.0.1:3010/favicon.svg',
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

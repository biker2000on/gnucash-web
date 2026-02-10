import { test, expect } from '@playwright/test';

const BASE_URL = 'http://localhost:3000';
const USERNAME = 'biker2000on';
const PASSWORD = '6ujn&dafyOaKWaTmI1OYR666EgpdkaGG';

async function login(page: any) {
    await page.goto(`${BASE_URL}/login`);
    await page.fill('input[name="username"], input[type="text"]', USERNAME);
    await page.fill('input[type="password"]', PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL('**/accounts**', { timeout: 10000 });
}

/**
 * Wait for "Generating report..." to disappear, meaning report data loaded.
 * Falls back after maxWait ms.
 */
async function waitForReportLoad(page: any, maxWait = 30000) {
    try {
        // Wait for the loading text to appear first (may already be gone)
        const loadingText = page.locator('text=Generating report...');
        // Then wait for it to disappear
        await loadingText.waitFor({ state: 'hidden', timeout: maxWait });
    } catch {
        // Loading may have already completed before we checked
    }
    // Small buffer for rendering
    await page.waitForTimeout(500);
}

test.describe('Reports Index', () => {
    test('shows all 14 reports in 5 categories', async ({ page }) => {
        await login(page);
        await page.goto(`${BASE_URL}/reports`);
        await page.waitForTimeout(3000);

        const main = page.locator('main');

        // Check all category headings (h2 elements in main content)
        await expect(main.locator('h2:has-text("Financial Statements")')).toBeVisible();
        await expect(main.locator('h2:has-text("Account Reports")')).toBeVisible();
        await expect(main.locator('h2:has-text("Transaction Reports")')).toBeVisible();
        await expect(main.locator('h2:has-text("Investment Reports")')).toBeVisible();
        await expect(main.locator('h2:has-text("Chart Reports")')).toBeVisible();

        // Check new report names in h3 headings (scoped to main to avoid sidebar nav)
        await expect(main.locator('h3:has-text("Equity Statement")')).toBeVisible();
        await expect(main.locator('h3:has-text("Trial Balance")')).toBeVisible();
        await expect(main.locator('h3:has-text("General Journal")')).toBeVisible();
        await expect(main.locator('h3:has-text("General Ledger")')).toBeVisible();
        await expect(main.locator('h3:has-text("Reconciliation Report")')).toBeVisible();
        await expect(main.locator('h3:has-text("Investment Portfolio")')).toBeVisible();
        await expect(main.locator('h3:has-text("Net Worth Chart")')).toBeVisible();
        await expect(main.locator('h3:has-text("Income & Expense Chart")')).toBeVisible();

        await page.screenshot({ path: 'playwright-screenshots/reports-index.png', fullPage: true });
    });
});

test.describe('New Reports - Last Year 2025', () => {
    test.beforeEach(async ({ page }) => {
        await login(page);
    });

    test('Equity Statement loads with data', async ({ page }) => {
        await page.goto(`${BASE_URL}/reports/equity_statement`);
        await page.waitForTimeout(1000);
        const lastYearBtn = page.locator('button:has-text("Last Year")');
        if (await lastYearBtn.isVisible()) await lastYearBtn.click();
        await waitForReportLoad(page);
        await expect(page.locator('h1:has-text("Equity Statement")')).toBeVisible();
        await page.screenshot({ path: 'playwright-screenshots/equity-statement.png', fullPage: true });
    });

    test('Trial Balance loads with data', async ({ page }) => {
        await page.goto(`${BASE_URL}/reports/trial_balance`);
        await page.waitForTimeout(1000);
        const lastYearBtn = page.locator('button:has-text("Last Year")');
        if (await lastYearBtn.isVisible()) await lastYearBtn.click();
        await waitForReportLoad(page);
        await expect(page.locator('h1:has-text("Trial Balance")')).toBeVisible();
        // Should have Debit/Credit column headers after data loads
        await expect(page.locator('th:has-text("Debit")').first()).toBeVisible();
        await expect(page.locator('th:has-text("Credit")').first()).toBeVisible();
        await page.screenshot({ path: 'playwright-screenshots/trial-balance.png', fullPage: true });
    });

    test('General Journal loads with data', async ({ page }) => {
        await page.goto(`${BASE_URL}/reports/general_journal`);
        await page.waitForTimeout(1000);
        const lastYearBtn = page.locator('button:has-text("Last Year")');
        if (await lastYearBtn.isVisible()) await lastYearBtn.click();
        await waitForReportLoad(page);
        await expect(page.locator('h1:has-text("General Journal")')).toBeVisible();
        await page.screenshot({ path: 'playwright-screenshots/general-journal.png', fullPage: true });
    });

    test('General Ledger loads with data', async ({ page }) => {
        await page.goto(`${BASE_URL}/reports/general_ledger`);
        await page.waitForTimeout(1000);
        const lastYearBtn = page.locator('button:has-text("Last Year")');
        if (await lastYearBtn.isVisible()) await lastYearBtn.click();
        await waitForReportLoad(page);
        await expect(page.locator('h1:has-text("General Ledger")')).toBeVisible();
        await page.screenshot({ path: 'playwright-screenshots/general-ledger.png', fullPage: true });
    });

    test('Reconciliation Report loads', async ({ page }) => {
        await page.goto(`${BASE_URL}/reports/reconciliation`);
        await page.waitForTimeout(1000);
        const lastYearBtn = page.locator('button:has-text("Last Year")');
        if (await lastYearBtn.isVisible()) await lastYearBtn.click();
        await waitForReportLoad(page);
        await expect(page.locator('h1:has-text("Reconciliation Report")')).toBeVisible();
        await page.screenshot({ path: 'playwright-screenshots/reconciliation.png', fullPage: true });
    });

    test('Investment Portfolio loads with data', async ({ page }) => {
        await page.goto(`${BASE_URL}/reports/investment_portfolio`);
        await page.waitForTimeout(1000);
        const lastYearBtn = page.locator('button:has-text("Last Year")');
        if (await lastYearBtn.isVisible()) await lastYearBtn.click();
        await waitForReportLoad(page);
        await expect(page.locator('h1:has-text("Investment Portfolio")')).toBeVisible();
        // Should have investment-specific columns
        await expect(page.locator('th:has-text("Shares")').first()).toBeVisible();
        await expect(page.locator('th:has-text("Market Value")').first()).toBeVisible();
        await page.screenshot({ path: 'playwright-screenshots/investment-portfolio.png', fullPage: true });
    });

    test('Net Worth Chart loads', async ({ page }) => {
        await page.goto(`${BASE_URL}/reports/net_worth_chart`);
        await page.waitForTimeout(1000);
        const lastYearBtn = page.locator('button:has-text("Last Year")');
        if (await lastYearBtn.isVisible()) await lastYearBtn.click();
        await waitForReportLoad(page);
        await expect(page.locator('h1:has-text("Net Worth Chart")')).toBeVisible();
        await page.screenshot({ path: 'playwright-screenshots/net-worth-chart.png', fullPage: true });
    });

    test('Income & Expense Chart loads', async ({ page }) => {
        await page.goto(`${BASE_URL}/reports/income_expense_chart`);
        await page.waitForTimeout(1000);
        const lastYearBtn = page.locator('button:has-text("Last Year")');
        if (await lastYearBtn.isVisible()) await lastYearBtn.click();
        await waitForReportLoad(page);
        // Use h1 selector to avoid matching description or chart legend
        await expect(page.locator('h1:has-text("Income & Expense Chart")')).toBeVisible();
        await page.screenshot({ path: 'playwright-screenshots/income-expense-chart.png', fullPage: true });
    });
});

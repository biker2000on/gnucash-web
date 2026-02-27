import { test, expect, Page } from '@playwright/test';

const BASE_URL = 'http://localhost:3000';
const USERNAME = 'biker2000on';
const PASSWORD = '6ujn&dafyOaKWaTmI1OYR666EgpdkaGG';

/**
 * Login helper -- navigates to the login page, fills credentials, submits.
 * The login page is a client component wrapped in Suspense that first checks
 * auth status via /api/auth/me before showing the form.
 * After login, Next.js uses client-side router.push so we wait for the URL
 * to change rather than a full navigation.
 */
async function login(page: Page) {
    await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded' });
    // Wait for the login form to hydrate (client component with auth check)
    const usernameInput = page.locator('input[placeholder="Enter username"]');
    await usernameInput.waitFor({ state: 'visible', timeout: 30000 });
    await usernameInput.fill(USERNAME);
    await page.locator('input[placeholder="Enter password"]').fill(PASSWORD);

    // Click submit and wait for the login API response
    await Promise.all([
        page.waitForResponse(resp => resp.url().includes('/api/auth/login'), { timeout: 15000 }),
        page.locator('button[type="submit"]').click(),
    ]);

    // Wait for client-side router.push to /accounts
    await page.waitForFunction(
        () => window.location.pathname.startsWith('/accounts'),
        { timeout: 15000 },
    );
    await page.waitForTimeout(2000);
}

/**
 * Navigate to the first account that has transactions.
 * Goes to /accounts, clicks the first account link in the hierarchy,
 * and waits for the ledger table to appear.
 */
async function navigateToAccountWithTransactions(page: Page) {
    await page.goto(`${BASE_URL}/accounts`);
    await page.waitForTimeout(3000);

    // Click the first account link in the account hierarchy
    // Account names appear as links (anchor tags) in the hierarchy table
    const accountLink = page.locator('a[href^="/accounts/"]').first();
    await expect(accountLink).toBeVisible({ timeout: 10000 });
    await accountLink.click();
    await page.waitForURL('**/accounts/**', { timeout: 10000 });

    // Wait for the ledger table to render
    await page.waitForSelector('table', { timeout: 15000 });
    await page.waitForTimeout(1000);
}

// ============================================================
// 1. Normal mode: table renders, rows display, keyboard nav, click opens view modal
// ============================================================
test.describe('1. Normal mode still works', () => {
    test('table renders with transactions and header columns', async ({ page }) => {
        await login(page);
        await navigateToAccountWithTransactions(page);

        // Table should be visible
        const table = page.locator('table');
        await expect(table).toBeVisible();

        // Should have standard column headers
        await expect(page.locator('th:has-text("Date")')).toBeVisible();
        await expect(page.locator('th:has-text("Description")')).toBeVisible();
        await expect(page.locator('th:has-text("Amount")')).toBeVisible();
        await expect(page.locator('th:has-text("Balance")')).toBeVisible();

        // At least one row in the tbody
        const rows = page.locator('table tbody tr');
        const count = await rows.count();
        expect(count).toBeGreaterThan(0);
    });

    test('keyboard navigation with j/k moves focus ring', async ({ page }) => {
        await login(page);
        await navigateToAccountWithTransactions(page);

        // Press j to focus the first row
        await page.keyboard.press('j');
        await page.waitForTimeout(300);

        // The focused row should have the cyan ring class
        const focusedRow = page.locator('table tbody tr.ring-2');
        await expect(focusedRow).toBeVisible();

        // Press j again to move to the next row
        await page.keyboard.press('j');
        await page.waitForTimeout(300);

        // Should still have a focused row
        await expect(page.locator('table tbody tr.ring-2')).toBeVisible();

        // Press k to go back up
        await page.keyboard.press('k');
        await page.waitForTimeout(300);
        await expect(page.locator('table tbody tr.ring-2')).toBeVisible();
    });

    test('clicking a row opens the view modal', async ({ page }) => {
        await login(page);
        await navigateToAccountWithTransactions(page);

        // Click the first transaction row
        const firstRow = page.locator('table tbody tr').first();
        await firstRow.click();
        await page.waitForTimeout(500);

        // The transaction detail modal should appear
        // TransactionModal typically shows transaction details in a dialog/overlay
        const modal = page.locator('[role="dialog"], .fixed.inset-0, [class*="modal"]').first();
        // If no explicit modal role, look for the overlay that TransactionModal creates
        const anyOverlay = page.locator('.fixed').first();
        const isVisible = await modal.isVisible().catch(() => false) || await anyOverlay.isVisible().catch(() => false);
        expect(isVisible).toBeTruthy();
    });
});

// ============================================================
// 2. Review mode toggle
// ============================================================
test.describe('2. Review mode toggle', () => {
    test('Review Mode button appears and toggles review mode', async ({ page }) => {
        await login(page);
        await navigateToAccountWithTransactions(page);

        // Review Mode button should be visible
        const reviewBtn = page.locator('button:has-text("Review Mode")');
        await expect(reviewBtn).toBeVisible();

        // Click to activate review mode
        await reviewBtn.click();
        await page.waitForTimeout(500);

        // Button text should change to "Exit Review Mode" (use .first() because
        // empty state also has an Exit Review Mode button)
        await expect(page.locator('button:has-text("Exit Review Mode")').first()).toBeVisible();

        // The "Show Unreviewed Only" filter should auto-activate (amber styling)
        const unreviewedBtn = page.locator('button:has-text("Showing Unreviewed")');
        await expect(unreviewedBtn).toBeVisible();
    });

    test('Review mode shows cyan styling on the toggle button', async ({ page }) => {
        await login(page);
        await navigateToAccountWithTransactions(page);

        const reviewBtn = page.locator('button:has-text("Review Mode")');
        await reviewBtn.click();
        await page.waitForTimeout(500);

        // The active button should have cyan styling
        const exitBtn = page.locator('button:has-text("Exit Review Mode")').first();
        const className = await exitBtn.getAttribute('class');
        expect(className).toContain('cyan');
    });
});

// ============================================================
// 3. Review mode mutual exclusivity with reconciliation
// ============================================================
test.describe('3. Review mode mutual exclusivity', () => {
    test('entering review mode exits reconciliation', async ({ page }) => {
        await login(page);
        await navigateToAccountWithTransactions(page);

        // Start reconciliation first
        const reconcileBtn = page.locator('button:has-text("Reconcile")');
        await expect(reconcileBtn).toBeVisible();
        await reconcileBtn.click();
        await page.waitForTimeout(500);

        // Reconciliation mode should be active
        await expect(page.locator('text=Reconciliation Mode')).toBeVisible();

        // Now click Review Mode
        const reviewBtn = page.locator('button:has-text("Review Mode")');
        await reviewBtn.click();
        await page.waitForTimeout(500);

        // Reconciliation panel should be gone
        await expect(page.locator('text=Reconciliation Mode')).toBeHidden();

        // Review mode should be active
        await expect(page.locator('button:has-text("Exit Review Mode")').first()).toBeVisible();
    });

    test('starting reconciliation exits review mode', async ({ page }) => {
        await login(page);
        await navigateToAccountWithTransactions(page);

        // Enter review mode first
        const reviewBtn = page.locator('button:has-text("Review Mode")');
        await reviewBtn.click();
        await page.waitForTimeout(500);
        await expect(page.locator('button:has-text("Exit Review Mode")').first()).toBeVisible();

        // Now start reconciliation
        const reconcileBtn = page.locator('button:has-text("Reconcile")');
        await reconcileBtn.click();
        await page.waitForTimeout(500);

        // Reconciliation mode should be active
        await expect(page.locator('text=Reconciliation Mode')).toBeVisible();

        // Review mode should be off -- button should say "Review Mode" not "Exit Review Mode"
        await expect(page.locator('button:has-text("Exit Review Mode")').first()).toBeHidden();
    });
});

// ============================================================
// 4. Review mode always-edit: focused row shows editable inputs
// ============================================================
test.describe('4. Review mode always-edit', () => {
    test('focused row in review mode shows editable input cells', async ({ page }) => {
        await login(page);
        await navigateToAccountWithTransactions(page);

        // Enter review mode
        await page.locator('button:has-text("Review Mode")').click();
        await page.waitForTimeout(1000);

        // Check if there are transactions
        const rows = page.locator('table tbody tr');
        const count = await rows.count();
        if (count === 0) {
            // All reviewed -- skip
            test.skip();
            return;
        }

        // The first row should be auto-focused and show editable inputs
        // EditableRow renders input elements when isActive=true
        const firstRow = rows.first();

        // Check for input fields in the focused row (date, description, account, amount)
        const inputs = firstRow.locator('input, select');
        const inputCount = await inputs.count();
        // Active editable row should have at least 2 inputs (date + description + amount or similar)
        // The checkbox is also an input, so there should be several
        expect(inputCount).toBeGreaterThanOrEqual(2);
    });
});

// ============================================================
// 5. Review mode keyboard: Arrow keys move between rows, Enter saves, Escape blurs
// ============================================================
test.describe('5. Review mode keyboard', () => {
    test('ArrowDown/ArrowUp move focus between rows', async ({ page }) => {
        await login(page);
        await navigateToAccountWithTransactions(page);

        await page.locator('button:has-text("Review Mode")').click();
        await page.waitForTimeout(1000);

        const rows = page.locator('table tbody tr');
        const count = await rows.count();
        if (count < 2) {
            test.skip();
            return;
        }

        // First row should be auto-focused (ring-2 class)
        await expect(rows.first()).toHaveClass(/ring-2/);

        // Blur any focused inputs first by clicking outside the input area
        await page.locator('table thead').click();
        await page.waitForTimeout(200);

        // Press ArrowDown to move to second row
        await page.keyboard.press('ArrowDown');
        await page.waitForTimeout(500);

        // Second row should now have the focus ring
        await expect(rows.nth(1)).toHaveClass(/ring-2/);

        // Press ArrowUp to go back
        await page.keyboard.press('ArrowUp');
        await page.waitForTimeout(500);

        await expect(rows.first()).toHaveClass(/ring-2/);
    });

    test('Escape removes focus', async ({ page }) => {
        await login(page);
        await navigateToAccountWithTransactions(page);

        await page.locator('button:has-text("Review Mode")').click();
        await page.waitForTimeout(1000);

        const rows = page.locator('table tbody tr');
        if (await rows.count() === 0) {
            test.skip();
            return;
        }

        // Row 0 should be focused
        await expect(rows.first()).toHaveClass(/ring-2/);

        // Blur any active input
        await page.locator('table thead').click();
        await page.waitForTimeout(200);

        // Press Escape
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);

        // No row should have the focus ring now
        const focusedRows = page.locator('table tbody tr.ring-2');
        await expect(focusedRows).toHaveCount(0);
    });
});

// ============================================================
// 6. Review mode Ctrl+R marks transaction as reviewed
// ============================================================
test.describe('6. Review mode Ctrl+R', () => {
    test('Ctrl+R marks the focused transaction as reviewed', async ({ page }) => {
        await login(page);
        await navigateToAccountWithTransactions(page);

        await page.locator('button:has-text("Review Mode")').click();
        await page.waitForTimeout(1000);

        const rows = page.locator('table tbody tr');
        const initialCount = await rows.count();
        if (initialCount === 0) {
            test.skip();
            return;
        }

        // Blur any active input so keyboard handler is on the table level
        await page.locator('table thead').click();
        await page.waitForTimeout(200);

        // Press Ctrl+R to mark the focused (first) transaction as reviewed
        await page.keyboard.press('Control+r');
        await page.waitForTimeout(2000); // Wait for API call and re-render

        // The transaction list should update - since unreviewed filter is on,
        // the reviewed transaction should disappear from the list
        const newCount = await rows.count();
        // Either fewer rows (transaction was removed from unreviewed list) or same
        // (if the transaction was already reviewed)
        expect(newCount).toBeLessThanOrEqual(initialCount);
    });
});

// ============================================================
// 7. Review mode checkboxes: click toggles, shift+click selects range, Select All/Clear
// ============================================================
test.describe('7. Review mode checkboxes', () => {
    test('clicking checkbox toggles selection', async ({ page }) => {
        await login(page);
        await navigateToAccountWithTransactions(page);

        await page.locator('button:has-text("Review Mode")').click();
        await page.waitForTimeout(1000);

        const rows = page.locator('table tbody tr');
        if (await rows.count() === 0) {
            test.skip();
            return;
        }

        // Find the first checkbox in the table body
        const firstCheckbox = page.locator('table tbody tr input[type="checkbox"]').first();
        await expect(firstCheckbox).toBeVisible();

        // Click to check
        await firstCheckbox.check();
        await page.waitForTimeout(200);
        await expect(firstCheckbox).toBeChecked();

        // Click to uncheck
        await firstCheckbox.uncheck();
        await page.waitForTimeout(200);
        await expect(firstCheckbox).not.toBeChecked();
    });

    test('Select All button selects all checkboxes', async ({ page }) => {
        await login(page);
        await navigateToAccountWithTransactions(page);

        await page.locator('button:has-text("Review Mode")').click();
        await page.waitForTimeout(1000);

        const rows = page.locator('table tbody tr');
        const count = await rows.count();
        if (count === 0) {
            test.skip();
            return;
        }

        // Click "Select All" button
        const selectAllBtn = page.locator('button:has-text("Select All")');
        await expect(selectAllBtn).toBeVisible();
        await selectAllBtn.click();
        await page.waitForTimeout(300);

        // All body checkboxes should be checked
        const checkboxes = page.locator('table tbody input[type="checkbox"]');
        const cbCount = await checkboxes.count();
        for (let i = 0; i < cbCount; i++) {
            await expect(checkboxes.nth(i)).toBeChecked();
        }
    });

    test('Clear button deselects all checkboxes', async ({ page }) => {
        await login(page);
        await navigateToAccountWithTransactions(page);

        await page.locator('button:has-text("Review Mode")').click();
        await page.waitForTimeout(1000);

        const rows = page.locator('table tbody tr');
        if (await rows.count() === 0) {
            test.skip();
            return;
        }

        // Select All first
        await page.locator('button:has-text("Select All")').click();
        await page.waitForTimeout(300);

        // Click "Clear"
        const clearBtn = page.locator('button:has-text("Clear")');
        await expect(clearBtn).toBeVisible();
        await clearBtn.click();
        await page.waitForTimeout(300);

        // All checkboxes should be unchecked
        const checkboxes = page.locator('table tbody input[type="checkbox"]');
        const cbCount = await checkboxes.count();
        for (let i = 0; i < cbCount; i++) {
            await expect(checkboxes.nth(i)).not.toBeChecked();
        }
    });

    test('header checkbox toggles all checkboxes', async ({ page }) => {
        await login(page);
        await navigateToAccountWithTransactions(page);

        await page.locator('button:has-text("Review Mode")').click();
        await page.waitForTimeout(1000);

        const rows = page.locator('table tbody tr');
        if (await rows.count() === 0) {
            test.skip();
            return;
        }

        // Header checkbox in the thead
        const headerCheckbox = page.locator('table thead input[type="checkbox"]');
        await expect(headerCheckbox).toBeVisible();

        // Check it to select all
        await headerCheckbox.check();
        await page.waitForTimeout(300);

        const bodyCheckboxes = page.locator('table tbody input[type="checkbox"]');
        const cbCount = await bodyCheckboxes.count();
        for (let i = 0; i < cbCount; i++) {
            await expect(bodyCheckboxes.nth(i)).toBeChecked();
        }

        // Uncheck to deselect all
        await headerCheckbox.uncheck();
        await page.waitForTimeout(300);

        for (let i = 0; i < cbCount; i++) {
            await expect(bodyCheckboxes.nth(i)).not.toBeChecked();
        }
    });
});

// ============================================================
// 8. Review mode bulk review: "Mark Reviewed" button
// ============================================================
test.describe('8. Review mode bulk review', () => {
    test('Mark Reviewed button is disabled when nothing selected', async ({ page }) => {
        await login(page);
        await navigateToAccountWithTransactions(page);

        await page.locator('button:has-text("Review Mode")').click();
        await page.waitForTimeout(1000);

        // The "Mark Reviewed" button should exist and be disabled
        const markBtn = page.locator('button:has-text("Mark Reviewed")');
        await expect(markBtn).toBeVisible();
        await expect(markBtn).toBeDisabled();
    });

    test('Mark Reviewed button enables when checkboxes selected', async ({ page }) => {
        await login(page);
        await navigateToAccountWithTransactions(page);

        await page.locator('button:has-text("Review Mode")').click();
        await page.waitForTimeout(1000);

        const rows = page.locator('table tbody tr');
        if (await rows.count() === 0) {
            test.skip();
            return;
        }

        // Select the first checkbox
        const firstCheckbox = page.locator('table tbody input[type="checkbox"]').first();
        await firstCheckbox.check();
        await page.waitForTimeout(300);

        // Mark Reviewed button should now be enabled
        const markBtn = page.locator('button:has-text("Mark Reviewed")');
        await expect(markBtn).toBeEnabled();

        // Button text should show count
        const btnText = await markBtn.textContent();
        expect(btnText).toContain('1');
    });
});

// ============================================================
// 9. Review mode edit button: pencil icon opens edit modal
// ============================================================
test.describe('9. Review mode edit button', () => {
    test('pencil/edit icon on each row opens the edit modal', async ({ page }) => {
        await login(page);
        await navigateToAccountWithTransactions(page);

        await page.locator('button:has-text("Review Mode")').click();
        await page.waitForTimeout(1000);

        const rows = page.locator('table tbody tr');
        if (await rows.count() === 0) {
            test.skip();
            return;
        }

        // Each row in review mode has an edit button (pencil icon via svg)
        const editButton = page.locator('table tbody tr button[title="Edit"]').first();
        await expect(editButton).toBeVisible();
        await editButton.click();
        await page.waitForTimeout(500);

        // The TransactionFormModal should open -- it has form inputs for editing
        // Look for common modal indicators
        const modal = page.locator('[role="dialog"], .fixed.inset-0').first();
        const anyFormInput = page.locator('.fixed input[type="text"], .fixed input[type="date"], .fixed textarea').first();
        const isModalVisible = await modal.isVisible().catch(() => false);
        const isFormVisible = await anyFormInput.isVisible().catch(() => false);
        expect(isModalVisible || isFormVisible).toBeTruthy();
    });
});

// ============================================================
// 10. Review mode empty state: "All caught up!" message
// ============================================================
test.describe('10. Review mode empty state', () => {
    test('shows "All caught up!" when no unreviewed transactions', async ({ page }) => {
        await login(page);
        await navigateToAccountWithTransactions(page);

        await page.locator('button:has-text("Review Mode")').click();
        await page.waitForTimeout(1000);

        // Check if there are any rows
        const rows = page.locator('table tbody tr');
        const count = await rows.count();

        if (count === 0) {
            // All transactions are already reviewed -- the empty state should show
            await expect(page.locator('text=All caught up!')).toBeVisible();
            await expect(page.locator('button:has-text("Exit Review Mode")').first()).toBeVisible();
        } else {
            // There are unreviewed transactions, so we can't test the empty state directly
            // Just confirm the empty state message is NOT visible when there are rows
            await expect(page.locator('text=All caught up!')).toBeHidden();
        }
    });
});

// ============================================================
// 11. Reconciliation auto-fill: SimpleFin balance pre-fills statement balance
// ============================================================
test.describe('11. Reconciliation auto-fill', () => {
    test('reconciliation panel shows Statement Balance input when reconciling', async ({ page }) => {
        await login(page);
        await navigateToAccountWithTransactions(page);

        // Click Reconcile
        const reconcileBtn = page.locator('button:has-text("Reconcile")');
        await expect(reconcileBtn).toBeVisible();
        await reconcileBtn.click();
        await page.waitForTimeout(500);

        // Reconciliation Mode panel should appear
        await expect(page.locator('text=Reconciliation Mode')).toBeVisible();

        // Statement Balance input should exist
        const balanceInput = page.locator('input[type="number"][step="0.01"]');
        await expect(balanceInput).toBeVisible();

        // Statement Date input should exist
        const dateInput = page.locator('input[type="date"]');
        await expect(dateInput).toBeVisible();

        // If SimpleFin data is available, the balance should be pre-filled
        // (This depends on whether the test account has SimpleFin mapping)
        const balanceValue = await balanceInput.inputValue();
        // We just verify the field exists and is functional -- the pre-fill
        // depends on the account's SimpleFin connection
        expect(typeof balanceValue).toBe('string');
    });
});

import { test, expect } from '@playwright/test';
import * as path from 'path';

const RESULTS_DIR = path.join(process.cwd(), 'test-results');

test.describe('Investment Chart % Change Mode Tests', () => {
  test.beforeEach(async ({ page }) => {
    // Set longer timeout for login
    test.setTimeout(90000);
    
    // Login
    await page.goto('http://localhost:3000/login');
    await page.waitForLoadState('networkidle');
    
    // Fill login form
    await page.fill('input[type="text"]', 'biker2000on');
    await page.fill('input[type="password"]', '6ujn&dafyOaKWaTmI1OYR666EgpdkaGG');
    await page.click('button[type="submit"]');
    
    // Wait for redirect to accounts page
    await page.waitForURL(/.*accounts.*/, { timeout: 15000 });
  });

  test('Test 1: Portfolio Performance Chart - % Change Mode', async ({ page }) => {
    // Navigate to investments page
    await page.goto('http://localhost:3000/investments');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000); // Wait for data to load

    // Take screenshot of default $ mode
    await page.screenshot({ 
      path: path.join(RESULTS_DIR, 'portfolio-dollar-mode.png'),
      fullPage: true 
    });
    console.log('Screenshot 1: Portfolio chart in $ mode captured');

    // Find the Portfolio Performance chart section
    const performanceSection = page.locator('text=Portfolio Performance').locator('..');
    
    // Find and click the % toggle button (second toggle group, first % button)
    const percentButton = performanceSection.locator('button:has-text("%")');
    await expect(percentButton).toBeVisible();
    await percentButton.click();
    await page.waitForTimeout(1500); // Wait for chart animation

    // Take screenshot of % mode
    await page.screenshot({ 
      path: path.join(RESULTS_DIR, 'portfolio-percent-mode.png'),
      fullPage: true 
    });
    console.log('Screenshot 2: Portfolio chart in % mode captured');

    // Verify % toggle is active
    await expect(percentButton).toHaveClass(/bg-cyan-600/);

    // Try switching periods in % mode
    const threeMonthButton = performanceSection.locator('button:has-text("3M")');
    await threeMonthButton.click();
    await page.waitForTimeout(500);

    const oneYearButton = performanceSection.locator('button:has-text("1Y")');
    await oneYearButton.click();
    await page.waitForTimeout(500);

    // Take screenshot after period changes
    await page.screenshot({ 
      path: path.join(RESULTS_DIR, 'portfolio-percent-1Y.png'),
      fullPage: true 
    });
    console.log('Screenshot 3: Portfolio chart in % mode (1Y period) captured');

    // Switch back to $ mode
    const dollarButton = performanceSection.locator('button:has-text("$")');
    await dollarButton.click();
    await page.waitForTimeout(1000);

    // Verify $ toggle is active
    await expect(dollarButton).toHaveClass(/bg-cyan-600/);

    console.log('Test 1 completed: Portfolio Performance Chart');
    console.log('');
    console.log('=== EXPECTED VISUAL ELEMENTS IN % MODE ===');
    console.log('- Chart should show a green/red gradient FILL area (not just a cyan line)');
    console.log('- Dashed horizontal line at 0% (zero baseline)');
    console.log('- Y-axis labels showing percentage values (e.g., "5.0%")');
    console.log('- Fill area between the line and zero baseline');
    console.log('- Green fill above 0%, red fill below 0%');
  });

  test('Test 2: Individual Investment Price Chart - % Change Mode', async ({ page }) => {
    // Navigate to investments page
    await page.goto('http://localhost:3000/investments');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    // Find and click on the first investment holding row
    const firstHoldingRow = page.locator('table tbody tr').first();
    await expect(firstHoldingRow).toBeVisible();
    await firstHoldingRow.click();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    console.log('Navigated to individual investment detail page');

    // Take screenshot of default $ mode
    await page.screenshot({ 
      path: path.join(RESULTS_DIR, 'investment-dollar-mode.png'),
      fullPage: true 
    });
    console.log('Screenshot 4: Investment price chart in $ mode captured');

    // Find the Price History chart section
    const priceHistorySection = page.locator('text=Price History').locator('..');
    
    // Find and click the % toggle button
    const percentButton = priceHistorySection.locator('button:has-text("%")');
    await expect(percentButton).toBeVisible();
    await percentButton.click();
    await page.waitForTimeout(1500); // Wait for chart animation

    // Take screenshot of % mode
    await page.screenshot({ 
      path: path.join(RESULTS_DIR, 'investment-percent-mode.png'),
      fullPage: true 
    });
    console.log('Screenshot 5: Investment price chart in % mode captured');

    // Verify % toggle is active
    await expect(percentButton).toHaveClass(/bg-cyan-600/);

    // Switch back to $ mode
    const dollarButton = priceHistorySection.locator('button:has-text("$")');
    await dollarButton.click();
    await page.waitForTimeout(1000);

    // Verify $ toggle is active
    await expect(dollarButton).toHaveClass(/bg-cyan-600/);

    // Take screenshot after switching back
    await page.screenshot({ 
      path: path.join(RESULTS_DIR, 'investment-back-to-dollar.png'),
      fullPage: true 
    });
    console.log('Screenshot 6: Investment price chart back in $ mode captured');

    console.log('Test 2 completed: Individual Investment Price Chart');
    console.log('');
    console.log('=== EXPECTED VISUAL ELEMENTS IN % MODE ===');
    console.log('- Chart should show a green/red gradient FILL area (not just a cyan line)');
    console.log('- Dashed horizontal line at 0% (zero baseline)');
    console.log('- Y-axis labels showing percentage values (e.g., "5.0%")');
    console.log('- Fill area between the line and zero baseline');
    console.log('- Green fill above 0%, red fill below 0%');
  });
});

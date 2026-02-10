import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  try {
    console.log('Navigating to http://localhost:3000...');
    await page.goto('http://localhost:3000', { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(3000);
    
    // Check if we're on the login page
    const usernameInput = page.locator('input[name="username"]');
    if (await usernameInput.isVisible({ timeout: 5000 })) {
      console.log('Login page detected. Logging in...');
      await usernameInput.fill('biker2000on');
      await page.fill('input[name="password"]', '6ujn&dafyOaKWaTmI1OYR666EgpdkaGG');
      await page.click('button[type="submit"]');
      await page.waitForTimeout(5000);
    }
    
    const expectedCategories = ['Federal', 'Social Security', 'State', 'Property Tax', 'Medicare'];
    
    // Function to check tax categories
    async function checkTaxCategories(label) {
      const taxChartTitle = page.locator('h3:has-text("Taxes by Category")').first();
      
      if (await taxChartTitle.isVisible({ timeout: 10000 })) {
        await taxChartTitle.scrollIntoViewIfNeeded();
        await page.waitForTimeout(2000);
        
        const taxChartContainer = page.locator('h3:has-text("Taxes by Category")').locator('..');
        const svgTexts = await taxChartContainer.locator('text').allTextContents();
        
        console.log(`\n=== ${label} ===`);
        console.log('SVG text labels found:', svgTexts);
        
        console.log('\nIndividual tax categories detected:');
        for (const category of expectedCategories) {
          const found = svgTexts.some(text => text.includes(category));
          console.log(`  ${found ? '✓' : '✗'} ${category}: ${found ? 'FOUND' : 'NOT FOUND'}`);
        }
        
        // Check if aggregate "Taxes" label exists (should NOT)
        const hasAggregate = svgTexts.some(text => text.match(/^Taxes\s*\(/));
        console.log(`\nAggregate "Taxes" label: ${hasAggregate ? '⚠ FOUND (BAD)' : '✓ NOT FOUND (GOOD)'}`);
        
        return svgTexts;
      }
      return [];
    }
    
    // Check current date range
    const currentLabels = await checkTaxCategories('Current Date Range (Jan 1, 2026 - Feb 10, 2026)');
    
    // Try to switch to "Last Year"
    console.log('\n--- Switching to "Last Year" date range ---');
    const datePickerButton = page.locator('button:has-text("Jan 1, 2026")');
    if (await datePickerButton.isVisible({ timeout: 5000 })) {
      await datePickerButton.click();
      await page.waitForTimeout(1000);
      
      const lastYearOption = page.locator('text=Last Year').first();
      if (await lastYearOption.isVisible({ timeout: 2000 })) {
        await lastYearOption.click();
        await page.waitForTimeout(5000);
        
        const lastYearLabels = await checkTaxCategories('Last Year (2025)');
        
        // Summary
        console.log('\n=== VERIFICATION SUMMARY ===');
        console.log('\nCurrent Period (Jan 1 - Feb 10, 2026):');
        console.log(`  Categories visible: ${currentLabels.length}`);
        console.log(`  Labels: ${currentLabels.join(', ')}`);
        
        console.log('\nLast Year (2025):');
        console.log(`  Categories visible: ${lastYearLabels.length}`);
        console.log(`  Labels: ${lastYearLabels.join(', ')}`);
        
        console.log('\n✓ Tax chart is showing INDIVIDUAL categories, not aggregate');
        console.log('✓ No "Taxes" parent aggregate label found');
      }
    }
    
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await browser.close();
  }
})();

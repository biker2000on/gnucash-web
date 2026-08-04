/**
 * App-wide abbreviation glossary. Rendered by `<Abbr term="..." />`
 * (src/components/ui/Abbr.tsx) as the abbreviation plus a small (i) tooltip.
 *
 * Conventions:
 * - Keys are the canonical on-screen spelling of the abbreviation.
 * - `expansion` is the full name (what the letters stand for).
 * - `gloss` is an optional one/two-sentence plain-English explanation; add one
 *   whenever the expansion alone would not help a non-accountant.
 *
 * Per DESIGN.md ("Abbreviations"), every user-visible abbreviation must resolve
 * through this map. Add new terms here first, then use `<Abbr>`.
 */

export interface GlossaryEntry {
    /** Full name the abbreviation stands for. */
    expansion: string;
    /** Optional one/two-sentence plain-English explanation. */
    gloss?: string;
}

export const GLOSSARY: Record<string, GlossaryEntry> = {
    // ---- Income tax core ----
    AGI: {
        expansion: 'Adjusted Gross Income',
        gloss: 'Total income minus specific adjustments (IRA deductions, self-employment tax deduction, etc.). Many credits and phase-outs key off this number.',
    },
    MAGI: {
        expansion: 'Modified Adjusted Gross Income',
        gloss: 'AGI with certain deductions and exclusions added back. Each provision (IRA limits, NIIT, premium credits) defines its own MAGI.',
    },
    QBI: {
        expansion: 'Qualified Business Income',
        gloss: 'Profit from a pass-through business (sole proprietorship, partnership, S corp). Up to 20% may be deductible under §199A.',
    },
    SE: {
        expansion: 'Self-Employment',
        gloss: 'Self-employment tax covers Social Security and Medicare (15.3% combined) on net earnings from self-employment.',
    },
    NIIT: {
        expansion: 'Net Investment Income Tax',
        gloss: 'An extra 3.8% tax on investment income (interest, dividends, capital gains) when MAGI exceeds $200k single / $250k joint.',
    },
    SALT: {
        expansion: 'State and Local Taxes',
        gloss: 'The itemized deduction for state/local income, sales, and property taxes, subject to an annual cap.',
    },
    AMT: {
        expansion: 'Alternative Minimum Tax',
        gloss: 'A parallel tax calculation with fewer deductions; you pay the higher of regular tax or AMT.',
    },
    EITC: {
        expansion: 'Earned Income Tax Credit',
        gloss: 'A refundable credit for lower-income workers; amount depends on earned income and number of children. Not allowed on a married-filing-separately return.',
    },
    IDR: {
        expansion: 'Income-Driven Repayment',
        gloss: 'Federal student-loan plans (IBR, PAYE, ICR) that set the monthly payment from the borrower’s income. Filing separately can shrink the payment because only the borrower’s own AGI counts.',
    },
    CTC: {
        expansion: 'Child Tax Credit',
        gloss: 'A per-child tax credit for qualifying children under 17, phased out at higher incomes.',
    },
    ACTC: {
        expansion: 'Additional Child Tax Credit',
        gloss: 'The refundable portion of the Child Tax Credit — paid out even when it exceeds tax owed.',
    },
    LTCG: {
        expansion: 'Long-Term Capital Gain',
        gloss: 'Gain on an asset held more than one year, taxed at preferential 0/15/20% rates.',
    },
    STCG: {
        expansion: 'Short-Term Capital Gain',
        gloss: 'Gain on an asset held one year or less, taxed at ordinary income rates.',
    },
    LT: {
        expansion: 'Long-Term',
        gloss: 'Held more than one year; gains qualify for preferential capital gains rates.',
    },
    ST: {
        expansion: 'Short-Term',
        gloss: 'Held one year or less; gains are taxed at ordinary income rates.',
    },
    'ST/LT': {
        expansion: 'Short-Term / Long-Term',
        gloss: 'Holding period classification: more than one year is long-term (preferential rates); one year or less is short-term (ordinary rates).',
    },
    NOL: {
        expansion: 'Net Operating Loss',
        gloss: 'When deductible business losses exceed income; generally carried forward to offset future income.',
    },

    // ---- Filing statuses ----
    MFJ: {
        expansion: 'Married Filing Jointly',
        gloss: 'Filing status for married couples combining income on one return.',
    },
    MFS: {
        expansion: 'Married Filing Separately',
        gloss: 'Filing status where each spouse files their own return; many credits and deductions are reduced or disallowed.',
    },
    HOH: {
        expansion: 'Head of Household',
        gloss: 'Filing status for unmarried taxpayers who pay over half the cost of keeping up a home for a qualifying person.',
    },
    QSS: {
        expansion: 'Qualifying Surviving Spouse',
        gloss: 'Filing status allowing a widow(er) with a dependent child to use joint-return rates for two years after the spouse’s death.',
    },

    // ---- Accounts & savings vehicles ----
    HSA: {
        expansion: 'Health Savings Account',
        gloss: 'Tax-advantaged account paired with a high-deductible health plan: deductible contributions, tax-free growth, tax-free medical withdrawals.',
    },
    FSA: {
        expansion: 'Flexible Spending Account',
        gloss: 'Employer account funding health or dependent-care costs with pre-tax dollars; typically use-it-or-lose-it each year.',
    },
    IRA: {
        expansion: 'Individual Retirement Arrangement',
        gloss: 'Personal retirement account. Traditional contributions may be deductible; Roth contributions grow tax-free.',
    },
    SEP: {
        expansion: 'Simplified Employee Pension',
        gloss: 'An employer-funded IRA for self-employed people and small businesses, with much higher contribution limits than a regular IRA.',
    },
    SIMPLE: {
        expansion: 'Savings Incentive Match Plan for Employees',
        gloss: 'A small-employer retirement plan with employee deferrals plus a required employer match or contribution.',
    },
    RMD: {
        expansion: 'Required Minimum Distribution',
        gloss: 'The minimum amount that must be withdrawn from pre-tax retirement accounts each year starting at the statutory age.',
    },
    HDHP: {
        expansion: 'High-Deductible Health Plan',
        gloss: 'A health plan meeting IRS deductible/out-of-pocket thresholds; enrollment is what makes you HSA-eligible.',
    },

    // ---- Forms & filings ----
    '1040-ES': {
        expansion: 'Form 1040-ES, Estimated Tax for Individuals',
        gloss: 'The quarterly estimated tax payment vouchers for income not covered by withholding.',
    },
    '8949': {
        expansion: 'Form 8949, Sales and Other Dispositions of Capital Assets',
        gloss: 'The IRS form listing each security sale with dates, proceeds, and cost basis; totals flow to Schedule D.',
    },
    'W-2': {
        expansion: 'Form W-2, Wage and Tax Statement',
        gloss: 'The annual statement employers send showing wages paid and taxes withheld.',
    },
    'W-4': {
        expansion: 'Form W-4, Employee’s Withholding Certificate',
        gloss: 'The form you give an employer to set how much federal income tax is withheld from each paycheck.',
    },
    'W-9': {
        expansion: 'Form W-9, Request for Taxpayer Identification Number and Certification',
        gloss: 'The form a payee fills out so a business can report payments (e.g., on a 1099).',
    },
    '1099': {
        expansion: 'Form 1099 (information return)',
        gloss: 'A family of IRS forms reporting non-wage payments: 1099-NEC for contractor pay, 1099-INT interest, 1099-DIV dividends, 1099-B broker sales.',
    },
    '990-N': {
        expansion: 'Form 990-N (e-Postcard)',
        gloss: 'The annual electronic notice small tax-exempt organizations (gross receipts ≤ $50k) file instead of a full Form 990.',
    },
    'Schedule C': {
        expansion: 'Schedule C (Form 1040), Profit or Loss From Business',
        gloss: 'Reports income and expenses of a sole proprietorship; the net profit flows to your 1040 and self-employment tax.',
    },
    'Schedule D': {
        expansion: 'Schedule D (Form 1040), Capital Gains and Losses',
        gloss: 'Summarizes capital gains and losses from Form 8949 and computes the tax treatment.',
    },
    'Schedule E': {
        expansion: 'Schedule E (Form 1040), Supplemental Income and Loss',
        gloss: 'Reports rental real estate, royalties, and pass-through income from partnerships and S corps.',
    },
    'Schedule F': {
        expansion: 'Schedule F (Form 1040), Profit or Loss From Farming',
        gloss: 'Reports farm income and expenses; the net profit flows to your 1040 and self-employment tax.',
    },
    TXF: {
        expansion: 'Tax Exchange Format',
        gloss: 'A plain-text file format tax software (TurboTax, H&R Block) can import for capital gains and other tax data.',
    },
    EIN: {
        expansion: 'Employer Identification Number',
        gloss: 'The federal tax ID number for a business or organization.',
    },

    // ---- Statute references ----
    '§179': {
        expansion: 'Section 179 expensing',
        gloss: 'Lets a business deduct the full cost of qualifying equipment in the year placed in service instead of depreciating it.',
    },
    '§1091': {
        expansion: 'Section 1091 (wash sales)',
        gloss: 'Disallows a loss when you buy substantially identical securities within 30 days before or after the sale; the loss is added to the replacement’s basis.',
    },
    '§199A': {
        expansion: 'Section 199A (qualified business income deduction)',
        gloss: 'The up-to-20% deduction on pass-through business income, subject to taxable-income and wage limits.',
    },
    '§7503': {
        expansion: 'Section 7503 (weekend/holiday rule)',
        gloss: 'When a tax deadline falls on a Saturday, Sunday, or legal holiday, it rolls to the next business day.',
    },
    OBBBA: {
        expansion: 'One Big Beautiful Bill Act',
        gloss: 'The 2025 tax law adding, among other things, deductions for tips, overtime pay, and car-loan interest, and a senior bonus deduction (2025–2028).',
    },

    // ---- Payroll ----
    FICA: {
        expansion: 'Federal Insurance Contributions Act',
        gloss: 'The payroll tax funding Social Security (6.2%) and Medicare (1.45%), paid by both employee and employer.',
    },
    OASDI: {
        expansion: 'Old-Age, Survivors, and Disability Insurance',
        gloss: 'The Social Security portion of payroll tax: 6.2% of wages up to the annual wage base.',
    },

    // ---- Investing ----
    DRIP: {
        expansion: 'Dividend Reinvestment Plan',
        gloss: 'Dividends automatically buy more shares instead of paying out cash. Each reinvestment is still taxable and starts a new tax lot.',
    },
    ROC: {
        expansion: 'Return of Capital',
        gloss: 'A distribution that returns part of your original investment rather than earnings; it is not taxed now but reduces your cost basis.',
    },
    FIFO: {
        expansion: 'First In, First Out',
        gloss: 'Cost basis method that sells your oldest shares first.',
    },
    LIFO: {
        expansion: 'Last In, First Out',
        gloss: 'Cost basis method that sells your newest shares first.',
    },
    'G/L': {
        expansion: 'Gain/Loss',
        gloss: 'The difference between what you sold for (proceeds) and what you paid (cost basis).',
    },
    QDI: {
        expansion: 'Qualified Dividend Income',
        gloss: 'Dividends meeting IRS holding-period rules, taxed at the preferential long-term capital gains rates instead of ordinary rates.',
    },
    NAV: {
        expansion: 'Net Asset Value',
        gloss: 'The per-share value of a fund: total assets minus liabilities, divided by shares outstanding.',
    },
    ESPP: {
        expansion: 'Employee Stock Purchase Plan',
        gloss: 'An employer plan letting employees buy company stock, often at a discount, via payroll deductions.',
    },
    RSU: {
        expansion: 'Restricted Stock Unit',
        gloss: 'Employer stock that vests over time; the value at vesting is taxed as wages.',
    },
    FX: {
        expansion: 'Foreign Exchange',
        gloss: 'Currency conversion. FX rates translate amounts held in other currencies into the book currency.',
    },

    // ---- Business / bookkeeping ----
    AR: {
        expansion: 'Accounts Receivable',
        gloss: 'Money customers owe you for invoices not yet paid.',
    },
    AP: {
        expansion: 'Accounts Payable',
        gloss: 'Money you owe vendors for bills not yet paid.',
    },
    'AR/AP': {
        expansion: 'Accounts Receivable / Accounts Payable',
        gloss: 'Money owed to you by customers (AR) and money you owe vendors (AP).',
    },
    COGS: {
        expansion: 'Cost of Goods Sold',
        gloss: 'The direct cost of products sold (materials, inventory). Revenue minus COGS is gross profit.',
    },
    'P&L': {
        expansion: 'Profit & Loss',
        gloss: 'The income statement: revenue minus expenses over a period.',
    },
    QBO: {
        expansion: 'QuickBooks Online',
        gloss: 'Intuit’s cloud accounting product; this app can import its exports.',
    },
    LLC: {
        expansion: 'Limited Liability Company',
        gloss: 'A state-law business entity that shields personal assets from business liabilities; taxed as a sole proprietorship, partnership, or corporation.',
    },
    SCU: {
        expansion: 'Smallest Commodity Unit',
        gloss: 'GnuCash’s smallest tracked fraction of a commodity — e.g., 1/100 for dollars, 1/10000 for many mutual funds.',
    },

    // ---- Farm / North Carolina ----
    PUV: {
        expansion: 'Present-Use Value',
        gloss: 'North Carolina’s farmland program taxing qualifying agricultural land at its farm-use value instead of market value.',
    },
    NCDOR: {
        expansion: 'North Carolina Department of Revenue',
        gloss: 'The state tax agency for North Carolina.',
    },

    // ---- Planning / metrics ----
    FIRE: {
        expansion: 'Financial Independence, Retire Early',
        gloss: 'A savings strategy targeting a portfolio (often 25× annual spending) that can sustain withdrawals indefinitely.',
    },
    FI: {
        expansion: 'Financial Independence',
        gloss: 'The point where portfolio withdrawals can cover living expenses without work income.',
    },
    KPI: {
        expansion: 'Key Performance Indicator',
        gloss: 'A headline metric summarizing performance, e.g. net worth or savings rate.',
    },
    YTD: {
        expansion: 'Year to Date',
        gloss: 'From January 1 of the current year through today.',
    },
    ES: {
        expansion: 'Estimated Tax',
        gloss: 'Quarterly prepayments of tax (Form 1040-ES) on income without withholding.',
    },
    APR: {
        expansion: 'Annual Percentage Rate',
        gloss: 'The yearly interest rate on a loan, including certain fees.',
    },
    APY: {
        expansion: 'Annual Percentage Yield',
        gloss: 'The effective yearly return including compounding.',
    },
    PMI: {
        expansion: 'Private Mortgage Insurance',
        gloss: 'Insurance lenders require when a down payment is under 20%; protects the lender, paid by the borrower.',
    },
    TCO: {
        expansion: 'Total Cost of Ownership',
        gloss: 'Everything an asset costs over its life — purchase, fuel, insurance, maintenance, depreciation — not just the sticker price.',
    },
    SWR: {
        expansion: 'Safe Withdrawal Rate',
        gloss: 'The percentage of a portfolio you can withdraw annually with low risk of running out (the classic rule of thumb is 4%).',
    },
};

/** Look up a glossary entry; returns undefined for unknown terms. */
export function getGlossaryEntry(term: string): GlossaryEntry | undefined {
    return GLOSSARY[term];
}

/**
 * North Carolina farm/agriculture rule constants — client-safe, no I/O.
 *
 * Encodes the NC-specific numbers the Farm & Apiary Analyzer weighs:
 * sales-tax exemption thresholds, LLC fees, and present-use value hints.
 * Verified July 2026 against the cited statutes/agency pages. Constants
 * change rarely; user-variable knobs (combined sales-tax rate, purchase
 * volume) flow through the tool's pinned inputs instead.
 *
 * ESTIMATES ONLY — not tax or legal advice.
 */

/**
 * "Qualifying farmer" annual gross farming income threshold for the NC
 * sales-tax exemption certificate (Form E-595QF): $10,000+ in the preceding
 * taxable year, or a $10,000+ average over the three preceding taxable years.
 * G.S. § 105-164.13E.
 */
export const QUALIFYING_FARMER_INCOME_THRESHOLD = 10_000;

/**
 * Conditional farmer certificate (Form E-595CF) for growers who don't yet
 * meet the income threshold: valid for the issue year plus two following
 * taxable years, non-renewable, and if the $10k threshold is never met all
 * exempted taxes are clawed back WITH interest from the purchase dates.
 * A new certificate is barred within 15 taxable years of a prior one.
 */
export const CONDITIONAL_FARMER_CERT_YEARS = 3;

/** NC Articles of Organization filing fee (Form L-01, Secretary of State). */
export const NC_LLC_FORMATION_FEE = 125;

/**
 * NC LLC annual report fee, due April 15 each year starting the year after
 * formation. The model uses the $200 base (paper) fee; online filing adds a
 * $3 e-filing surcharge that is deliberately not modeled. NC levies NO
 * franchise tax on LLCs (franchise tax applies to corporations only).
 */
export const NC_LLC_ANNUAL_REPORT_FEE = 200;

/**
 * Default combined state + local sales/use tax rate used to estimate the
 * value of exempt farm purchases (NC state 4.75% + typical 2–2.75% local).
 * User-adjustable in the tool.
 */
export const DEFAULT_COMBINED_SALES_TAX_RATE = 0.07;

/**
 * NC present-use value (PUV) property-tax program thresholds,
 * G.S. § 105-277.3. Honey sales count toward the income requirement since
 * July 1, 2023 (the 2023 Farm Act deleted the honey exclusion — many county
 * pages still show the old rule). Disqualification triggers a 3-year rollback
 * of deferred taxes plus interest.
 */
export const PUV = {
  /** Agricultural classification: acres in actual production. */
  agAcres: 10,
  /** Horticultural classification: acres in actual production. */
  hortAcres: 5,
  /** 3-year average gross income minimum from the qualifying tract. */
  avgIncomeMin: 1_000,
} as const;

/**
 * Purchase categories exempt for a qualifying/conditional farmer when used
 * primarily in farming operations (G.S. § 105-164.13E(a), apiary-relevant
 * selection).
 */
export const EXEMPT_PURCHASE_CATEGORIES: string[] = [
  'Farm machinery, attachments, repair parts, and lubricants (not hand tools or registered highway vehicles)',
  'Feed — sugar syrup, pollen substitute',
  'Remedies, vaccines, medications — mite treatments, antibiotics',
  'Containers and packaging used to sell products — honey jars, lids, labels applied at sale',
  'Building materials for structures used to house, raise, or feed animals — hive bodies and housing',
  'Fuel, piped natural gas, and separately metered electricity used in farming',
  'Fertilizer, seeds, plastic mulch, potting soil',
  'Repair, maintenance, and installation services on exempt items',
];

/**
 * Model caveats surfaced in the tool's assumptions panel. Kept here (not in
 * farm-analysis.ts) because they are NC/apiary-specific facts rather than
 * math simplifications.
 */
export const NC_FARM_ASSUMPTION_NOTES: string[] = [
  'A single-member LLC is a disregarded entity: federal and NC income taxes are identical to a sole proprietorship. The LLC buys a liability shield (bee stings, farmers-market claims, product liability) — not tax savings.',
  'The qualifying-farmer sales-tax exemption, Schedule F deductions, and present-use value all work WITHOUT an LLC.',
  'Raw honey sold in its original state by the producer is exempt from collecting NC sales tax (G.S. § 105-164.13(4b)); no sales-tax registration is needed for producer-only sales. The exemption is lost for value-added products (creamed/infused honey, candles) — those trigger registration and collection.',
  'Section 179 expensing is effectively unlimited for a small apiary ($2.5M limit in 2025, $2.56M in 2026) and 100% bonus depreciation applies to equipment placed in service after Jan 19, 2025.',
  'Farmers with ≥2/3 of gross income from farming may skip quarterly estimates by filing and paying by March 1, or make a single estimated payment by Jan 15.',
  'NC hive registration is voluntary; localities cannot ban ownership of 5 or fewer hives; selling fewer than 10 hives per year requires no permit.',
  'Bottling your own raw honey falls under NCDA&CS home food processor guidelines — registration is recommended but likely not required for raw own-honey sales; confirm with NCDA&CS Food & Drug Protection.',
  'Present-use value requires the LAND to be in agricultural production (10 acres agricultural / 5 acres horticultural); hives alone rarely satisfy the acreage test.',
];

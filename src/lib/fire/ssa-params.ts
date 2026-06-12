/**
 * Social Security Administration parameter tables.
 *
 * Versioned, typed tables of the published SSA values needed to compute a
 * retirement benefit: the Average Wage Index (AWI) series, PIA formula bend
 * points by eligibility year, the OASDI taxable wage base (contribution and
 * benefit base), the COLA series, and normal retirement age by birth year.
 *
 * Sources (verified 2026-06):
 * - AWI series:      https://www.ssa.gov/oact/cola/awiseries.html
 * - Bend points:     https://www.ssa.gov/oact/cola/bendpoints.html
 * - Wage base:       https://www.ssa.gov/oact/cola/cbb.html
 * - COLA series:     https://www.ssa.gov/oact/cola/colaseries.html
 *
 * To append a new year: add the AWI entry (published each October for the
 * year two years prior), the bend points and wage base for the new program
 * year, and the COLA effective the prior December. Bump SSA_PARAMS_VERSION.
 */

export const SSA_PARAMS_VERSION = 1;

/* ------------------------------------------------------------------ */
/* Average Wage Index (AWI), 1951 through latest published year        */
/* ------------------------------------------------------------------ */

/** National Average Wage Index by year. 2024 ($69,846.57) is the latest published value. */
export const AWI_SERIES: Readonly<Record<number, number>> = {
  1951: 2799.16, 1952: 2973.32, 1953: 3139.44, 1954: 3155.64, 1955: 3301.44,
  1956: 3532.36, 1957: 3641.72, 1958: 3673.80, 1959: 3855.80, 1960: 4007.12,
  1961: 4086.76, 1962: 4291.40, 1963: 4396.64, 1964: 4576.32, 1965: 4658.72,
  1966: 4938.36, 1967: 5213.44, 1968: 5571.76, 1969: 5893.76, 1970: 6186.24,
  1971: 6497.08, 1972: 7133.80, 1973: 7580.16, 1974: 8030.76, 1975: 8630.92,
  1976: 9226.48, 1977: 9779.44, 1978: 10556.03, 1979: 11479.46, 1980: 12513.46,
  1981: 13773.10, 1982: 14531.34, 1983: 15239.24, 1984: 16135.07, 1985: 16822.51,
  1986: 17321.82, 1987: 18426.51, 1988: 19334.04, 1989: 20099.55, 1990: 21027.98,
  1991: 21811.60, 1992: 22935.42, 1993: 23132.67, 1994: 23753.53, 1995: 24705.66,
  1996: 25913.90, 1997: 27426.00, 1998: 28861.44, 1999: 30469.84, 2000: 32154.82,
  2001: 32921.92, 2002: 33252.09, 2003: 34064.95, 2004: 35648.55, 2005: 36952.94,
  2006: 38651.41, 2007: 40405.48, 2008: 41334.97, 2009: 40711.61, 2010: 41673.83,
  2011: 42979.61, 2012: 44321.67, 2013: 44888.16, 2014: 46481.52, 2015: 48098.63,
  2016: 48642.15, 2017: 50321.89, 2018: 52145.80, 2019: 54099.99, 2020: 55628.60,
  2021: 60575.07, 2022: 63795.13, 2023: 66621.80, 2024: 69846.57,
};

export const FIRST_AWI_YEAR = 1951;
export const LATEST_AWI_YEAR = 2024;

/* ------------------------------------------------------------------ */
/* PIA formula bend points by eligibility year                         */
/* ------------------------------------------------------------------ */

/**
 * PIA formula bend points [first, second] by year of eligibility (the year a
 * worker turns 62, becomes disabled, or dies before 62).
 * Bend points for year Y equal the 1979 amounts ($180 / $1,085) scaled by
 * AWI(Y-2) / AWI(1977), rounded to the nearest dollar.
 */
export const PIA_BEND_POINTS: Readonly<Record<number, readonly [number, number]>> = {
  1979: [180, 1085], 1980: [194, 1171], 1981: [211, 1274], 1982: [230, 1388],
  1983: [254, 1528], 1984: [267, 1612], 1985: [280, 1691], 1986: [297, 1790],
  1987: [310, 1866], 1988: [319, 1922], 1989: [339, 2044], 1990: [356, 2145],
  1991: [370, 2230], 1992: [387, 2333], 1993: [401, 2420], 1994: [422, 2545],
  1995: [426, 2567], 1996: [437, 2635], 1997: [455, 2741], 1998: [477, 2875],
  1999: [505, 3043], 2000: [531, 3202], 2001: [561, 3381], 2002: [592, 3567],
  2003: [606, 3653], 2004: [612, 3689], 2005: [627, 3779], 2006: [656, 3955],
  2007: [680, 4100], 2008: [711, 4288], 2009: [744, 4483], 2010: [761, 4586],
  2011: [749, 4517], 2012: [767, 4624], 2013: [791, 4768], 2014: [816, 4917],
  2015: [826, 4980], 2016: [856, 5157], 2017: [885, 5336], 2018: [895, 5397],
  2019: [926, 5583], 2020: [960, 5785], 2021: [996, 6002], 2022: [1024, 6172],
  2023: [1115, 6721], 2024: [1174, 7078], 2025: [1226, 7391], 2026: [1286, 7749],
};

export const LATEST_BEND_POINT_YEAR = 2026;

/** 1979 base bend points and base-year AWI used to project future bend points. */
const BEND_BASE: readonly [number, number] = [180, 1085];
const BEND_BASE_AWI_YEAR = 1977; // AWI(eligibility year - 2)

/** PIA formula factors fixed in law. */
export const PIA_FACTORS = [0.9, 0.32, 0.15] as const;

/* ------------------------------------------------------------------ */
/* OASDI contribution and benefit base (taxable wage base)             */
/* ------------------------------------------------------------------ */

/** Taxable maximum by year (1937-1950 = $3,000). */
export const WAGE_BASE: Readonly<Record<number, number>> = {
  1951: 3600, 1952: 3600, 1953: 3600, 1954: 3600,
  1955: 4200, 1956: 4200, 1957: 4200, 1958: 4200,
  1959: 4800, 1960: 4800, 1961: 4800, 1962: 4800, 1963: 4800, 1964: 4800, 1965: 4800,
  1966: 6600, 1967: 6600,
  1968: 7800, 1969: 7800, 1970: 7800, 1971: 7800,
  1972: 9000, 1973: 10800, 1974: 13200, 1975: 14100, 1976: 15300, 1977: 16500,
  1978: 17700, 1979: 22900, 1980: 25900, 1981: 29700, 1982: 32400, 1983: 35700,
  1984: 37800, 1985: 39600, 1986: 42000, 1987: 43800, 1988: 45000, 1989: 48000,
  1990: 51300, 1991: 53400, 1992: 55500, 1993: 57600, 1994: 60600, 1995: 61200,
  1996: 62700, 1997: 65400, 1998: 68400, 1999: 72600, 2000: 76200, 2001: 80400,
  2002: 84900, 2003: 87000, 2004: 87900, 2005: 90000, 2006: 94200, 2007: 97500,
  2008: 102000, 2009: 106800, 2010: 106800, 2011: 106800, 2012: 110100,
  2013: 113700, 2014: 117000, 2015: 118500, 2016: 118500, 2017: 127200,
  2018: 128400, 2019: 132900, 2020: 137700, 2021: 142800, 2022: 147000,
  2023: 160200, 2024: 168600, 2025: 176100, 2026: 184500,
};

export const PRE_1951_WAGE_BASE = 3000;
export const LATEST_WAGE_BASE_YEAR = 2026;

/* ------------------------------------------------------------------ */
/* Cost-of-living adjustments (percent, effective December of year)    */
/* ------------------------------------------------------------------ */

export const COLA_SERIES: Readonly<Record<number, number>> = {
  1975: 8.0, 1976: 6.4, 1977: 5.9, 1978: 6.5, 1979: 9.9, 1980: 14.3, 1981: 11.2,
  1982: 7.4, 1983: 3.5, 1984: 3.5, 1985: 3.1, 1986: 1.3, 1987: 4.2, 1988: 4.0,
  1989: 4.7, 1990: 5.4, 1991: 3.7, 1992: 3.0, 1993: 2.6, 1994: 2.8, 1995: 2.6,
  1996: 2.9, 1997: 2.1, 1998: 1.3, 1999: 2.5, 2000: 3.5, 2001: 2.6, 2002: 1.4,
  2003: 2.1, 2004: 2.7, 2005: 4.1, 2006: 3.3, 2007: 2.3, 2008: 5.8, 2009: 0.0,
  2010: 0.0, 2011: 3.6, 2012: 1.7, 2013: 1.5, 2014: 1.7, 2015: 0.0, 2016: 0.3,
  2017: 2.0, 2018: 2.8, 2019: 1.6, 2020: 1.3, 2021: 5.9, 2022: 8.7, 2023: 3.2,
  2024: 2.5, 2025: 2.8,
};

export const LATEST_COLA_YEAR = 2025;

/* ------------------------------------------------------------------ */
/* Normal retirement age & claiming-age adjustment factors             */
/* ------------------------------------------------------------------ */

/**
 * Normal (full) retirement age in months, by birth year.
 * 65 for 1937 and earlier, rising 2 months per birth year to 66 (1943-1954),
 * then 2 months per year again to 67 for 1960 and later.
 */
export function normalRetirementAgeMonths(birthYear: number): number {
  if (birthYear <= 1937) return 65 * 12;
  if (birthYear <= 1942) return 65 * 12 + (birthYear - 1937) * 2;
  if (birthYear <= 1954) return 66 * 12;
  if (birthYear <= 1959) return 66 * 12 + (birthYear - 1954) * 2;
  return 67 * 12;
}

/** Human-readable NRA, e.g. "67" or "66 and 10 months". */
export function normalRetirementAgeLabel(birthYear: number): string {
  const months = normalRetirementAgeMonths(birthYear);
  const years = Math.floor(months / 12);
  const rem = months % 12;
  return rem === 0 ? `${years}` : `${years} and ${rem} month${rem === 1 ? '' : 's'}`;
}

/** Early-claiming reduction: 5/9 of 1% per month for the first 36 months, 5/12 of 1% beyond. */
export const EARLY_REDUCTION_FIRST_36 = 5 / 9 / 100;
export const EARLY_REDUCTION_BEYOND_36 = 5 / 12 / 100;

/** Delayed retirement credit for birth years 1943+: 2/3 of 1% per month (8%/yr), up to age 70. */
export const DELAYED_CREDIT_PER_MONTH = 2 / 3 / 100;

/**
 * Multiplier applied to the PIA for a given claiming age (in months) relative
 * to the worker's NRA. Claiming is clamped to the 62-70 window.
 */
export function claimingAdjustmentFactor(birthYear: number, claimingAgeMonths: number): number {
  const clamped = Math.min(70 * 12, Math.max(62 * 12, claimingAgeMonths));
  const nra = normalRetirementAgeMonths(birthYear);
  if (clamped < nra) {
    const early = nra - clamped;
    const reduction =
      Math.min(36, early) * EARLY_REDUCTION_FIRST_36 +
      Math.max(0, early - 36) * EARLY_REDUCTION_BEYOND_36;
    return 1 - reduction;
  }
  const delayed = clamped - nra; // credits stop accruing at 70 via the clamp
  return 1 + delayed * DELAYED_CREDIT_PER_MONTH;
}

/* ------------------------------------------------------------------ */
/* Lookups with future-year extrapolation                              */
/* ------------------------------------------------------------------ */

export interface SsaYearParams {
  year: number;
  awi: number;
  wageBase: number;
  /** PIA bend points treating `year` as the eligibility year */
  bendPoints: [number, number];
  /** True when any component was extrapolated rather than published */
  estimated: boolean;
}

/**
 * AWI for a year. Years beyond the published series grow at
 * `wageGrowthPct`/yr from the latest published value; 0 (the default) keeps
 * everything in today's wage terms, which is what a today's-dollars benefit
 * estimate wants. Years before 1951 clamp to the 1951 value.
 */
export function awiForYear(year: number, wageGrowthPct = 0): number {
  if (year <= FIRST_AWI_YEAR) return AWI_SERIES[FIRST_AWI_YEAR];
  if (year <= LATEST_AWI_YEAR) return AWI_SERIES[year];
  return AWI_SERIES[LATEST_AWI_YEAR] * Math.pow(1 + wageGrowthPct / 100, year - LATEST_AWI_YEAR);
}

/** Taxable wage base for a year, extrapolating beyond the published table. */
export function wageBaseForYear(year: number, wageGrowthPct = 0): number {
  if (year < 1951) return PRE_1951_WAGE_BASE;
  if (year <= LATEST_WAGE_BASE_YEAR) return WAGE_BASE[year];
  // The statutory base tracks AWI growth, rounded to a $300 multiple.
  const projected =
    WAGE_BASE[LATEST_WAGE_BASE_YEAR] *
    Math.pow(1 + wageGrowthPct / 100, year - LATEST_WAGE_BASE_YEAR);
  return Math.round(projected / 300) * 300;
}

/** Bend points for an eligibility year, extrapolating beyond the published table. */
export function bendPointsForYear(eligibilityYear: number, wageGrowthPct = 0): [number, number] {
  const published = PIA_BEND_POINTS[eligibilityYear];
  if (published) return [published[0], published[1]];
  if (eligibilityYear < 1979) {
    const first = PIA_BEND_POINTS[1979];
    return [first[0], first[1]];
  }
  // bend(Y) = 1979 amounts x AWI(Y-2)/AWI(1977), rounded to the nearest dollar
  const ratio = awiForYear(eligibilityYear - 2, wageGrowthPct) / AWI_SERIES[BEND_BASE_AWI_YEAR];
  return [Math.round(BEND_BASE[0] * ratio), Math.round(BEND_BASE[1] * ratio)];
}

/**
 * Full parameter set for a year, extrapolated when beyond published data.
 * With the default 0% wage growth, future years are frozen at today's values,
 * keeping the whole computation in today's dollars.
 */
export function estimateFutureParams(year: number, wageGrowthPct = 0): SsaYearParams {
  const estimated =
    year > LATEST_AWI_YEAR || year > LATEST_WAGE_BASE_YEAR || !PIA_BEND_POINTS[year];
  return {
    year,
    awi: awiForYear(year, wageGrowthPct),
    wageBase: wageBaseForYear(year, wageGrowthPct),
    bendPoints: bendPointsForYear(year, wageGrowthPct),
    estimated,
  };
}

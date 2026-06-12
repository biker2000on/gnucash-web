/**
 * Historical annual returns dataset, 1928-2024.
 *
 * Source: NYU Stern (Aswath Damodaran) "Historical Returns on Stocks, Bonds
 * and Bills" dataset. All values are NOMINAL annual total returns:
 *  - stocks: S&P 500 total return (price appreciation + dividends)
 *  - bonds:  US 10-year Treasury bond total return (coupon + price change)
 *  - inflation: US CPI annual inflation
 *
 * Values are expressed as decimal fractions (0.10 = 10%).
 * Sampling the (stock, bond, inflation) triple from the same row preserves
 * the historical correlation structure between asset classes and inflation.
 */

export interface HistoricalYear {
  year: number;
  /** S&P 500 nominal total return (incl. dividends) */
  stocks: number;
  /** US 10-year Treasury nominal total return */
  bonds: number;
  /** CPI inflation */
  inflation: number;
}

export const HISTORICAL_RETURNS: readonly HistoricalYear[] = [
  { year: 1928, stocks: 0.4381, bonds: 0.0084, inflation: -0.0115 },
  { year: 1929, stocks: -0.0830, bonds: 0.0420, inflation: 0.0058 },
  { year: 1930, stocks: -0.2512, bonds: 0.0454, inflation: -0.0640 },
  { year: 1931, stocks: -0.4384, bonds: -0.0256, inflation: -0.0932 },
  { year: 1932, stocks: -0.0864, bonds: 0.0879, inflation: -0.1027 },
  { year: 1933, stocks: 0.4998, bonds: 0.0186, inflation: 0.0076 },
  { year: 1934, stocks: -0.0119, bonds: 0.0796, inflation: 0.0152 },
  { year: 1935, stocks: 0.4674, bonds: 0.0447, inflation: 0.0299 },
  { year: 1936, stocks: 0.3194, bonds: 0.0502, inflation: 0.0145 },
  { year: 1937, stocks: -0.3534, bonds: 0.0138, inflation: 0.0286 },
  { year: 1938, stocks: 0.2928, bonds: 0.0421, inflation: -0.0278 },
  { year: 1939, stocks: -0.0110, bonds: 0.0441, inflation: 0.0000 },
  { year: 1940, stocks: -0.1067, bonds: 0.0540, inflation: 0.0071 },
  { year: 1941, stocks: -0.1277, bonds: -0.0202, inflation: 0.0993 },
  { year: 1942, stocks: 0.1917, bonds: 0.0229, inflation: 0.0903 },
  { year: 1943, stocks: 0.2506, bonds: 0.0249, inflation: 0.0296 },
  { year: 1944, stocks: 0.1903, bonds: 0.0258, inflation: 0.0230 },
  { year: 1945, stocks: 0.3582, bonds: 0.0380, inflation: 0.0225 },
  { year: 1946, stocks: -0.0843, bonds: 0.0313, inflation: 0.1813 },
  { year: 1947, stocks: 0.0520, bonds: 0.0092, inflation: 0.0884 },
  { year: 1948, stocks: 0.0570, bonds: 0.0195, inflation: 0.0299 },
  { year: 1949, stocks: 0.1830, bonds: 0.0466, inflation: -0.0207 },
  { year: 1950, stocks: 0.3081, bonds: 0.0043, inflation: 0.0593 },
  { year: 1951, stocks: 0.2368, bonds: -0.0030, inflation: 0.0600 },
  { year: 1952, stocks: 0.1815, bonds: 0.0227, inflation: 0.0075 },
  { year: 1953, stocks: -0.0121, bonds: 0.0414, inflation: 0.0075 },
  { year: 1954, stocks: 0.5256, bonds: 0.0329, inflation: -0.0074 },
  { year: 1955, stocks: 0.3260, bonds: -0.0134, inflation: 0.0037 },
  { year: 1956, stocks: 0.0744, bonds: -0.0226, inflation: 0.0299 },
  { year: 1957, stocks: -0.1046, bonds: 0.0680, inflation: 0.0290 },
  { year: 1958, stocks: 0.4372, bonds: -0.0210, inflation: 0.0176 },
  { year: 1959, stocks: 0.1206, bonds: -0.0265, inflation: 0.0173 },
  { year: 1960, stocks: 0.0034, bonds: 0.1164, inflation: 0.0136 },
  { year: 1961, stocks: 0.2664, bonds: 0.0206, inflation: 0.0067 },
  { year: 1962, stocks: -0.0881, bonds: 0.0569, inflation: 0.0133 },
  { year: 1963, stocks: 0.2261, bonds: 0.0168, inflation: 0.0164 },
  { year: 1964, stocks: 0.1642, bonds: 0.0373, inflation: 0.0097 },
  { year: 1965, stocks: 0.1240, bonds: 0.0072, inflation: 0.0192 },
  { year: 1966, stocks: -0.0997, bonds: 0.0291, inflation: 0.0346 },
  { year: 1967, stocks: 0.2380, bonds: -0.0158, inflation: 0.0304 },
  { year: 1968, stocks: 0.1081, bonds: 0.0327, inflation: 0.0472 },
  { year: 1969, stocks: -0.0824, bonds: -0.0501, inflation: 0.0620 },
  { year: 1970, stocks: 0.0356, bonds: 0.1675, inflation: 0.0557 },
  { year: 1971, stocks: 0.1422, bonds: 0.0979, inflation: 0.0327 },
  { year: 1972, stocks: 0.1876, bonds: 0.0282, inflation: 0.0341 },
  { year: 1973, stocks: -0.1431, bonds: 0.0366, inflation: 0.0871 },
  { year: 1974, stocks: -0.2590, bonds: 0.0199, inflation: 0.1234 },
  { year: 1975, stocks: 0.3700, bonds: 0.0361, inflation: 0.0694 },
  { year: 1976, stocks: 0.2383, bonds: 0.1598, inflation: 0.0486 },
  { year: 1977, stocks: -0.0698, bonds: 0.0129, inflation: 0.0670 },
  { year: 1978, stocks: 0.0651, bonds: -0.0078, inflation: 0.0902 },
  { year: 1979, stocks: 0.1852, bonds: 0.0067, inflation: 0.1329 },
  { year: 1980, stocks: 0.3174, bonds: -0.0299, inflation: 0.1252 },
  { year: 1981, stocks: -0.0470, bonds: 0.0820, inflation: 0.0892 },
  { year: 1982, stocks: 0.2042, bonds: 0.3281, inflation: 0.0383 },
  { year: 1983, stocks: 0.2234, bonds: 0.0320, inflation: 0.0379 },
  { year: 1984, stocks: 0.0615, bonds: 0.1373, inflation: 0.0395 },
  { year: 1985, stocks: 0.3124, bonds: 0.2571, inflation: 0.0380 },
  { year: 1986, stocks: 0.1849, bonds: 0.2428, inflation: 0.0110 },
  { year: 1987, stocks: 0.0581, bonds: -0.0496, inflation: 0.0443 },
  { year: 1988, stocks: 0.1654, bonds: 0.0822, inflation: 0.0442 },
  { year: 1989, stocks: 0.3148, bonds: 0.1769, inflation: 0.0465 },
  { year: 1990, stocks: -0.0306, bonds: 0.0624, inflation: 0.0611 },
  { year: 1991, stocks: 0.3023, bonds: 0.1500, inflation: 0.0306 },
  { year: 1992, stocks: 0.0749, bonds: 0.0936, inflation: 0.0290 },
  { year: 1993, stocks: 0.0997, bonds: 0.1421, inflation: 0.0275 },
  { year: 1994, stocks: 0.0133, bonds: -0.0804, inflation: 0.0267 },
  { year: 1995, stocks: 0.3720, bonds: 0.2348, inflation: 0.0254 },
  { year: 1996, stocks: 0.2268, bonds: 0.0143, inflation: 0.0332 },
  { year: 1997, stocks: 0.3310, bonds: 0.0994, inflation: 0.0170 },
  { year: 1998, stocks: 0.2834, bonds: 0.1492, inflation: 0.0161 },
  { year: 1999, stocks: 0.2089, bonds: -0.0825, inflation: 0.0268 },
  { year: 2000, stocks: -0.0903, bonds: 0.1666, inflation: 0.0339 },
  { year: 2001, stocks: -0.1185, bonds: 0.0557, inflation: 0.0155 },
  { year: 2002, stocks: -0.2197, bonds: 0.1512, inflation: 0.0238 },
  { year: 2003, stocks: 0.2836, bonds: 0.0038, inflation: 0.0188 },
  { year: 2004, stocks: 0.1074, bonds: 0.0449, inflation: 0.0326 },
  { year: 2005, stocks: 0.0483, bonds: 0.0287, inflation: 0.0342 },
  { year: 2006, stocks: 0.1561, bonds: 0.0196, inflation: 0.0254 },
  { year: 2007, stocks: 0.0548, bonds: 0.1021, inflation: 0.0408 },
  { year: 2008, stocks: -0.3655, bonds: 0.2010, inflation: 0.0009 },
  { year: 2009, stocks: 0.2594, bonds: -0.1112, inflation: 0.0272 },
  { year: 2010, stocks: 0.1482, bonds: 0.0846, inflation: 0.0150 },
  { year: 2011, stocks: 0.0210, bonds: 0.1604, inflation: 0.0296 },
  { year: 2012, stocks: 0.1589, bonds: 0.0297, inflation: 0.0174 },
  { year: 2013, stocks: 0.3215, bonds: -0.0910, inflation: 0.0150 },
  { year: 2014, stocks: 0.1352, bonds: 0.1075, inflation: 0.0076 },
  { year: 2015, stocks: 0.0138, bonds: 0.0128, inflation: 0.0073 },
  { year: 2016, stocks: 0.1177, bonds: 0.0069, inflation: 0.0207 },
  { year: 2017, stocks: 0.2161, bonds: 0.0280, inflation: 0.0211 },
  { year: 2018, stocks: -0.0423, bonds: -0.0002, inflation: 0.0191 },
  { year: 2019, stocks: 0.3121, bonds: 0.0964, inflation: 0.0229 },
  { year: 2020, stocks: 0.1802, bonds: 0.1133, inflation: 0.0136 },
  { year: 2021, stocks: 0.2847, bonds: -0.0442, inflation: 0.0704 },
  { year: 2022, stocks: -0.1804, bonds: -0.1783, inflation: 0.0645 },
  { year: 2023, stocks: 0.2606, bonds: 0.0388, inflation: 0.0335 },
  { year: 2024, stocks: 0.2502, bonds: -0.0164, inflation: 0.0289 },
] as const;

/** First year covered by the dataset. */
export const FIRST_YEAR = HISTORICAL_RETURNS[0].year;
/** Last year covered by the dataset. */
export const LAST_YEAR = HISTORICAL_RETURNS[HISTORICAL_RETURNS.length - 1].year;

/** Arithmetic mean of a numeric array. */
export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Mean nominal stock return across the dataset (decimal). */
export function meanStockReturn(): number {
  return mean(HISTORICAL_RETURNS.map(r => r.stocks));
}

/** Mean nominal bond return across the dataset (decimal). */
export function meanBondReturn(): number {
  return mean(HISTORICAL_RETURNS.map(r => r.bonds));
}

/** Mean CPI inflation across the dataset (decimal). */
export function meanInflation(): number {
  return mean(HISTORICAL_RETURNS.map(r => r.inflation));
}

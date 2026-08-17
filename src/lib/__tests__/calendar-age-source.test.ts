import { readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE_ROOT = resolve(process.cwd(), 'src');

interface DurationException {
  path: string;
  token: string;
  count: number;
  justification: string;
}

// Every production use of 365.25 is a concrete, fractional-duration site.
// Exact inventory and identifying tokens make additions and stale exemptions fail.
const LEGITIMATE_FRACTIONAL_YEAR_SITES: DurationException[] = [
  { path: 'app/(main)/tools/fire-calculator/page.tsx', token: 'const years = daysDiff / 365.25;', count: 1, justification: 'Annualizes time-weighted return over arbitrary dates.' },
  { path: 'lib/fixed-income.ts', token: 'DAY_MS * 365.25', count: 2, justification: 'Documents and computes fractional years remaining to maturity.' },
  { path: 'lib/investment-performance.ts', token: '/ (365.25 * MS_PER_DAY)', count: 1, justification: 'Annualizes investment performance over arbitrary dates.' },
  { path: 'lib/recurring-detection.ts', token: '365.25 / 7 / 12', count: 1, justification: 'Converts a weekly cadence to an average monthly cadence.' },
  { path: 'lib/services/goal.service.ts', token: '365.25 / 12', count: 1, justification: 'Defines an average days-per-month duration constant.' },
];

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && /\.tsx?$/.test(path) && !path.includes('/__tests__/') ? [path] : [];
  });
}

function fractionalYearSites(): Array<Pick<DurationException, 'path' | 'count'>> {
  return sourceFiles(SOURCE_ROOT).flatMap((file) => {
    const count = [...readFileSync(file, 'utf8').matchAll(/\b365\.25\b/g)].length;
    return count > 0 ? [{ path: relative(SOURCE_ROOT, file), count }] : [];
  }).sort((a, b) => a.path.localeCompare(b.path));
}

describe('calendar-age source guard', () => {
  it('allows only the audited fractional-duration uses of 365.25', () => {
    const expected = LEGITIMATE_FRACTIONAL_YEAR_SITES
      .map(({ path, count }) => ({ path, count }))
      .sort((a, b) => a.path.localeCompare(b.path));
    expect(fractionalYearSites()).toEqual(expected);

    for (const entry of LEGITIMATE_FRACTIONAL_YEAR_SITES) {
      expect(entry.justification).not.toBe('');
      expect(readFileSync(resolve(SOURCE_ROOT, entry.path), 'utf8')).toContain(entry.token);
    }
  });

  it('forbids elapsed-milliseconds age arithmetic outright', () => {
    const ageByMilliseconds = /(?:Date\.now\(\)|\.getTime\(\))[^;\n]{0,240}\/\s*\(?\s*365\.25\s*\*\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/gs;
    const violations = sourceFiles(SOURCE_ROOT).flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      return [...source.matchAll(ageByMilliseconds)].map((match) => ({
        path: relative(SOURCE_ROOT, file),
        expression: match[0],
      }));
    });
    expect(violations).toEqual([]);
  });
});

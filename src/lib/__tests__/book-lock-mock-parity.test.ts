import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

async function testFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async entry => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return testFiles(file);
    return /\.(test|spec)\.[jt]sx?$/.test(entry.name) ? [file] : [];
  }));
  return nested.flat();
}

function bookLockMockFactories(source: string): string[] {
  const starts = source.matchAll(/vi\.mock\(\s*['"][^'"]*book-lock['"]/g);
  const factories: string[] = [];

  for (const match of starts) {
    let depth = 0;
    let quote: string | undefined;
    let escaped = false;
    let end = match.index ?? 0;
    for (; end < source.length; end++) {
      const character = source[end];
      if (quote) {
        if (!escaped && character === quote) quote = undefined;
        escaped = !escaped && character === '\\';
        continue;
      }
      if (character === '"' || character === "'" || character === '`') {
        quote = character;
      } else if (character === '(') {
        depth++;
      } else if (character === ')' && --depth === 0) {
        end++;
        break;
      }
    }
    factories.push(source.slice(match.index, end));
  }

  return factories;
}

describe('book-lock mock parity', () => {
  it('loads the real module before overriding individual book-lock helpers', async () => {
    const srcRoot = path.join(process.cwd(), 'src');
    const files = await testFiles(srcRoot);
    const offenders: string[] = [];

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      const mocks = bookLockMockFactories(source);
      const hasNonParityMock = mocks.some(mock => !(
        /,\s*async\s*\(\s*importOriginal\s*\)/.test(mock)
        && (/\.\.\.\s*\(\s*await\s+importOriginal/.test(mock) || /\.\.\.\s*actual\b/.test(mock))
      ));
      if (hasNonParityMock) {
        offenders.push(path.relative(process.cwd(), file));
      }
    }

    expect(offenders, 'Book-lock mocks must spread importOriginal() so new exports are inherited automatically.').toEqual([]);
  });
});

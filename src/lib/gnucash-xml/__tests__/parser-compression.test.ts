import { gzipSync, strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { parseGnuCashXml } from '../parser';

const VALID_BOOK = `<?xml version="1.0" encoding="utf-8"?>
<gnc-v2><gnc:book version="2.0.0"><book:id type="guid">00000000000000000000000000000000</book:id></gnc:book></gnc-v2>`;

describe('parser — compressed XML limits', () => {
  it('imports a normal gzip-compressed book', () => {
    const data = parseGnuCashXml(gzipSync(strToU8(VALID_BOOK)));

    expect(data.book?.id).toBe('00000000000000000000000000000000');
  });

  it('rejects gzip content that expands beyond the decompressed size cap', () => {
    const gzipBomb = gzipSync(new Uint8Array(65 * 1024 * 1024));

    expect(() => parseGnuCashXml(gzipBomb)).toThrow(
      'GnuCash XML exceeds the 64 MB decompressed size limit.',
    );
  });
});

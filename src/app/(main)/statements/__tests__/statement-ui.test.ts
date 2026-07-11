import { describe, it, expect } from 'vitest';
import {
  statusBadge,
  sourceBadge,
  isPollingStatus,
  tieOutDisplay,
  canFinalize,
  buildMissingDecisions,
  buildUnmatchDecision,
  missingCounterparts,
  amountTone,
  formatSignedAbsolute,
  cleanRulePattern,
  type MissingLineState,
} from '../statement-ui';

describe('statusBadge', () => {
  it('maps each known status to a stable label', () => {
    expect(statusBadge('uploaded').label).toBe('Uploaded');
    expect(statusBadge('parsing').label).toBe('Parsing');
    expect(statusBadge('parsed').label).toBe('Parsed');
    expect(statusBadge('reconciled').label).toBe('Reconciled');
    expect(statusBadge('error').label).toBe('Error');
  });

  it('uses the positive token for reconciled and negative for error', () => {
    expect(statusBadge('reconciled').className).toContain('--positive');
    expect(statusBadge('error').className).toContain('--negative');
  });

  it('falls back gracefully for unknown status', () => {
    expect(statusBadge('weird').label).toBe('weird');
    expect(statusBadge('').label).toBe('Unknown');
  });
});

describe('sourceBadge', () => {
  it('upper-cases known sources', () => {
    expect(sourceBadge('pdf').label).toBe('PDF');
    expect(sourceBadge('csv').label).toBe('CSV');
    expect(sourceBadge('ofx').label).toBe('OFX');
  });

  it('falls back for unknown source', () => {
    expect(sourceBadge('qfx').label).toBe('QFX');
    expect(sourceBadge('').label).toBe('FILE');
  });
});

describe('isPollingStatus', () => {
  it('polls only while uploaded or parsing', () => {
    expect(isPollingStatus('uploaded')).toBe(true);
    expect(isPollingStatus('parsing')).toBe(true);
    expect(isPollingStatus('parsed')).toBe(false);
    expect(isPollingStatus('reconciled')).toBe(false);
    expect(isPollingStatus('error')).toBe(false);
  });
});

describe('tieOutDisplay', () => {
  it('is positive when tiesOut is true', () => {
    const d = tieOutDisplay({ expectedChange: 10, actualChange: 10, difference: 0, tiesOut: true });
    expect(d.tone).toBe('positive');
    expect(d.status).toBe('Balances');
  });

  it('is warning when tiesOut is null (unverifiable)', () => {
    const d = tieOutDisplay({ expectedChange: null, actualChange: 10, difference: null, tiesOut: null });
    expect(d.tone).toBe('warning');
    expect(d.status).toBe('Unverifiable');
  });

  it('is warning when tieOut is missing entirely', () => {
    expect(tieOutDisplay(null).tone).toBe('warning');
    expect(tieOutDisplay(undefined).tone).toBe('warning');
  });

  it('is negative and reports the difference when tiesOut is false', () => {
    const d = tieOutDisplay({ expectedChange: 100, actualChange: 75, difference: -25, tiesOut: false });
    expect(d.tone).toBe('negative');
    expect(d.status).toBe('Out of balance');
    expect(d.detail).toContain('$25.00');
  });
});

describe('canFinalize', () => {
  it('only enables finalize on an exact tie-out', () => {
    expect(canFinalize({ expectedChange: 0, actualChange: 0, difference: 0, tiesOut: true })).toBe(true);
    expect(canFinalize({ expectedChange: 0, actualChange: 1, difference: 1, tiesOut: false })).toBe(false);
    expect(canFinalize({ expectedChange: null, actualChange: null, difference: null, tiesOut: null })).toBe(false);
    expect(canFinalize(null)).toBe(false);
    expect(canFinalize(undefined)).toBe(false);
  });
});

describe('buildMissingDecisions', () => {
  it('emits add with counterpart and ignore without', () => {
    const states: MissingLineState[] = [
      { lineId: 1, decision: 'add', counterpartAccountGuid: 'acc-a' },
      { lineId: 2, decision: 'ignore' },
      { lineId: 3, decision: 'add' }, // no counterpart yet
    ];
    expect(buildMissingDecisions(states)).toEqual([
      { lineId: 1, decision: 'add', counterpartAccountGuid: 'acc-a' },
      { lineId: 2, decision: 'ignore' },
      { lineId: 3, decision: 'add' },
    ]);
  });

  it('omits the counterpart key on ignore even if one is set in state', () => {
    const states: MissingLineState[] = [
      { lineId: 5, decision: 'ignore', counterpartAccountGuid: 'stale' },
    ];
    const [payload] = buildMissingDecisions(states);
    expect(payload).toEqual({ lineId: 5, decision: 'ignore' });
    expect('counterpartAccountGuid' in payload).toBe(false);
  });
});

describe('buildUnmatchDecision', () => {
  it('models un-matching a confirmed line as ignore', () => {
    expect(buildUnmatchDecision(42)).toEqual({ lineId: 42, decision: 'ignore' });
  });
});

describe('missingCounterparts', () => {
  it('flags add lines lacking a counterpart account', () => {
    const states: MissingLineState[] = [
      { lineId: 1, decision: 'add', counterpartAccountGuid: 'x' },
      { lineId: 2, decision: 'add' },
      { lineId: 3, decision: 'ignore' },
      { lineId: 4, decision: 'add', counterpartAccountGuid: '' },
    ];
    expect(missingCounterparts(states)).toEqual([2, 4]);
  });
});

describe('amountTone', () => {
  it('colors by sign', () => {
    expect(amountTone(5)).toContain('--positive');
    expect(amountTone(-5)).toContain('--negative');
    expect(amountTone(0)).toBe('text-foreground-secondary');
  });
});

describe('cleanRulePattern', () => {
  it('drops digit-bearing reference tokens and lowercases', () => {
    expect(cleanRulePattern('STARBUCKS #1234 SEATTLE WA')).toBe('starbucks');
    expect(cleanRulePattern('AMAZON MKTPL*RT4Y89 SEATTLE')).toBe('amazon');
  });

  it('keeps original separators so the pattern still contains-matches', () => {
    const desc = 'PAYPAL *SPOTIFY 402-935-7733';
    const pattern = cleanRulePattern(desc);
    expect(pattern).toBe('paypal *spotify');
    // The whole point: a 'contains' rule built from the pattern matches the line.
    expect(desc.toLowerCase().includes(pattern)).toBe(true);
  });

  it('strips leading bank-noise words', () => {
    expect(cleanRulePattern('POS PURCHASE STARBUCKS')).toBe('starbucks');
    expect(cleanRulePattern('ACH PAYMENT TO NETFLIX.COM')).toBe('netflix.com');
    expect(cleanRulePattern('DEBIT CARD PURCHASE TRADER JOES')).toBe('trader joes');
  });

  it('keeps at least one token even if everything looks like noise', () => {
    expect(cleanRulePattern('ACH PAYMENT')).toBe('payment');
  });

  it('skips runs that are entirely noise words', () => {
    expect(cleanRulePattern('CHK 1042 HOMETOWN PLUMBING LLC INV 88')).toBe(
      'hometown plumbing llc inv',
    );
  });

  it('trims stray punctuation from the edges', () => {
    expect(cleanRulePattern('*SPOTIFY*')).toBe('spotify');
  });

  it('falls back to the raw lowercased text when every token has digits', () => {
    expect(cleanRulePattern('7-ELEVEN 32145')).toBe('7-eleven 32145');
  });

  it('handles empty / whitespace descriptions', () => {
    expect(cleanRulePattern('')).toBe('');
    expect(cleanRulePattern('   ')).toBe('');
  });

  it('result is always a substring of the collapsed lowercased description', () => {
    const samples = [
      'POS PURCHASE STARBUCKS #1234 SEATTLE',
      'PAYPAL *SPOTIFY 402-935-7733',
      'TRANSFER FROM SAVINGS 001',
      'Check 204',
      'WHOLEFDS MKT 10259 AUSTIN TX',
    ];
    for (const s of samples) {
      const pattern = cleanRulePattern(s);
      if (pattern) {
        expect(s.replace(/\s+/g, ' ').trim().toLowerCase().includes(pattern)).toBe(true);
      }
    }
  });
});

describe('formatSignedAbsolute', () => {
  it('formats magnitude with currency and thousands separators', () => {
    expect(formatSignedAbsolute(-1234.5)).toBe('$1,234.50');
    expect(formatSignedAbsolute(0)).toBe('$0.00');
    expect(formatSignedAbsolute(25)).toBe('$25.00');
  });
});

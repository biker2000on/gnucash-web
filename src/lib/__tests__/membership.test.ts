import { describe, it, expect } from 'vitest';
import {
  computeMembershipPeriod,
  computeDuesStatus,
  addDays,
} from '@/lib/membership';

describe('computeMembershipPeriod', () => {
  describe('calendar_year', () => {
    it('covers the calendar year of the paid date for a first payment', () => {
      expect(computeMembershipPeriod('calendar_year', '2026-03-15', null)).toEqual({
        periodStart: '2026-01-01',
        periodEnd: '2026-12-31',
      });
    });

    it('covers the current year when the member lapsed last year', () => {
      expect(computeMembershipPeriod('calendar_year', '2026-02-01', '2024-12-31')).toEqual({
        periodStart: '2026-01-01',
        periodEnd: '2026-12-31',
      });
    });

    it('renews the next year when already paid through this year (early renewal)', () => {
      expect(computeMembershipPeriod('calendar_year', '2026-11-20', '2026-12-31')).toEqual({
        periodStart: '2027-01-01',
        periodEnd: '2027-12-31',
      });
    });

    it('stacks multiple prepaid years', () => {
      expect(computeMembershipPeriod('calendar_year', '2026-11-20', '2027-12-31')).toEqual({
        periodStart: '2028-01-01',
        periodEnd: '2028-12-31',
      });
    });
  });

  describe('anniversary', () => {
    it('runs one year from the paid date for a first payment', () => {
      expect(computeMembershipPeriod('anniversary', '2026-03-15', null)).toEqual({
        periodStart: '2026-03-15',
        periodEnd: '2027-03-14',
      });
    });

    it('extends from paid-through when renewing early', () => {
      expect(computeMembershipPeriod('anniversary', '2026-03-01', '2026-03-14')).toEqual({
        periodStart: '2026-03-15',
        periodEnd: '2027-03-14',
      });
    });

    it('restarts from the paid date after a lapse', () => {
      expect(computeMembershipPeriod('anniversary', '2026-06-01', '2025-12-31')).toEqual({
        periodStart: '2026-06-01',
        periodEnd: '2027-05-31',
      });
    });

    it('handles Feb 29 starts', () => {
      expect(computeMembershipPeriod('anniversary', '2028-02-29', null)).toEqual({
        periodStart: '2028-02-29',
        periodEnd: '2029-02-28',
      });
    });
  });

  describe('lifetime', () => {
    it('never expires', () => {
      expect(computeMembershipPeriod('lifetime', '2026-03-15', null)).toEqual({
        periodStart: '2026-03-15',
        periodEnd: null,
      });
    });
  });
});

describe('computeDuesStatus', () => {
  const today = '2026-07-14';

  it('honorary members are exempt', () => {
    expect(computeDuesStatus('honorary', null, false, 0, today)).toBe('exempt');
  });

  it('lifetime payment wins over dates', () => {
    expect(computeDuesStatus('active', '2020-12-31', true, 0, today)).toBe('lifetime');
  });

  it('never paid → unpaid', () => {
    expect(computeDuesStatus('active', null, false, 0, today)).toBe('unpaid');
  });

  it('paid through the future → current', () => {
    expect(computeDuesStatus('active', '2026-12-31', false, 0, today)).toBe('current');
  });

  it('expired → lapsed', () => {
    expect(computeDuesStatus('active', '2025-12-31', false, 0, today)).toBe('lapsed');
  });

  it('grace days keep a recently expired member current', () => {
    expect(computeDuesStatus('active', '2026-06-30', false, 30, today)).toBe('current');
    expect(computeDuesStatus('active', '2026-06-30', false, 7, today)).toBe('lapsed');
  });
});

describe('addDays', () => {
  it('crosses month and year boundaries', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
  });
});

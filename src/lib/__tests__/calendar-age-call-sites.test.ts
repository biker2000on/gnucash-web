import { describe, expect, it } from 'vitest';
import { profileAgeFromBirthday } from '@/app/(main)/profile/page';
import { fireCalculatorAgeFromBirthday } from '@/app/(main)/tools/fire-calculator/page';
import { drawdownAgeFromBirthday } from '@/app/api/tools/drawdown/prefill/route';
import { isAge65PlusAtYearEnd } from '@/lib/scenario/data';

const birthday = '1952-03-01';
const birthdayDay = new Date('2026-03-01T00:00:00Z');

describe('calendar-age call sites', () => {
  it('uses calendar age in the profile birthday display', () => {
    expect(profileAgeFromBirthday(birthday, birthdayDay)).toBe(74);
  });

  it('uses calendar age to anchor drawdown projections', () => {
    expect(drawdownAgeFromBirthday(birthday, birthdayDay)).toBe(74);
  });

  it('uses calendar age when loading and saving FIRE projection birthdays', () => {
    expect(fireCalculatorAgeFromBirthday(birthday, birthdayDay)).toBe(74);
  });

  it('accepts a full ISO birthday when applying the 65-plus year-end deduction', () => {
    expect(isAge65PlusAtYearEnd('1961-12-31T00:00:00.000Z', 2026)).toBe(true);
  });
});

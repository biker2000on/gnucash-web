import { describe, expect, it } from 'vitest';
import { ageFromBirthday } from '../data';

describe('scenario ageFromBirthday', () => {
  it('counts a birthday exactly once the calendar date is reached', () => {
    expect(ageFromBirthday('2000-03-01', new Date('2025-03-01T12:00:00Z'))).toBe(25);
  });
});

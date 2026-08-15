import { describe, expect, it } from 'vitest';
import { resolveFarmerEstimatedTaxElection } from '../farmer-estimated-tax';

describe('resolveFarmerEstimatedTaxElection', () => {
  it('requires both a farm-labeled book and an explicit qualification assertion', () => {
    expect(resolveFarmerEstimatedTaxElection({ businessActivity: 'farm', qualifyingFarmerAsserted: true })).toBe(true);
    expect(resolveFarmerEstimatedTaxElection({ businessActivity: 'farm', qualifyingFarmerAsserted: false })).toBe(false);
    expect(resolveFarmerEstimatedTaxElection({ businessActivity: 'general', qualifyingFarmerAsserted: true })).toBe(false);
  });
});

/**
 * Decide whether the tracker may apply the IRC §6654(i) farmer election.
 * A farm-labeled book only exposes the option; it does not prove the
 * two-thirds gross-income test, which must be explicitly asserted until the
 * tracker has the required income data.
 */
export function resolveFarmerEstimatedTaxElection(input: {
  businessActivity: 'general' | 'farm';
  qualifyingFarmerAsserted: boolean;
}): boolean {
  return input.businessActivity === 'farm' && input.qualifyingFarmerAsserted;
}

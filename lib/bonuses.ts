export const DEFAULT_BONUSES = {
  customerFirstBookingCreditCents: 2500,
  moverFirstJobBonusCents: 2500,
  threeFiveStarJobsBonusCents: 2500,
  moverReferralBonusCents: 5000,
  driverReferralBonusCents: 7500,
  partnerReferralCreditCents: 2500,
} as const;

export function qualifiesForThreeFiveStarJobs(ratings: number[]) {
  return ratings.filter((rating) => rating === 5).length >= 3;
}

export function bonusIsEconomicallySafe(input: { amountCents: number; platformRevenueCents: number }) {
  return input.amountCents <= Math.round(input.platformRevenueCents * 0.5);
}

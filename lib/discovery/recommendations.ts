/**
 * Phase 5 recommendations — RULE-BASED and TRANSPARENT. Every
 * recommendation carries a plain-language `reason` the UI displays.
 * There is NO opaque score: a worker is recommended because a stated
 * rule matched, and the rule is shown to the customer. The handoff is
 * explicit — if a rule can't be stated in one sentence, it doesn't ship.
 *
 * This file defines the rules and the reason strings. The actual DB
 * queries live in the recommendations route; this keeps the rule
 * definitions (the thing worth reviewing and testing) in one readable,
 * db-free place.
 */

export type RecommendationRule = "SAME_MARKET_HIGH_RATED" | "SIMILAR_TO_RECENTLY_HIRED";

/**
 * The rules, in priority order. Each has a machine id, a human label,
 * and a `describe()` that produces the exact sentence shown next to a
 * recommended worker. Keeping describe() here (not scattered in the
 * route) means the displayed reason and the rule can never drift apart.
 */
export const RECOMMENDATION_RULES: {
  id: RecommendationRule;
  label: string;
  describe: (ctx: { marketName?: string; hiredWorkerName?: string }) => string;
}[] = [
  {
    id: "SAME_MARKET_HIGH_RATED",
    label: "Top-rated in your market",
    describe: ({ marketName }) =>
      `Highly rated (4.5+) ${marketName ? `in ${marketName}` : "in your market"} and not already in your network.`,
  },
  {
    id: "SIMILAR_TO_RECENTLY_HIRED",
    label: "Similar to someone you hired",
    describe: ({ hiredWorkerName }) =>
      `Shares skills and market with ${hiredWorkerName ? hiredWorkerName : "a worker you recently hired"}.`,
  },
];

// The rating floor used by SAME_MARKET_HIGH_RATED, named so the route
// and any test reference one constant, not a magic number in two places.
export const RECOMMENDATION_MIN_RATING = 4.5;

export function ruleById(id: RecommendationRule) {
  const rule = RECOMMENDATION_RULES.find(r => r.id === id);
  if (!rule) throw new Error(`Unknown recommendation rule: ${id}`);
  return rule;
}

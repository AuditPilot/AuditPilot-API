/**
 * Plan definitions — single source of truth for plan ids and feature limits.
 * This moves out of server/lib/stripe.ts so non-billing modules can import it
 * without pulling in the Stripe SDK.
 */

export const PLANS = ["starter", "pro", "agency"] as const;
export type Plan = (typeof PLANS)[number];

/** Sentinel for "no limit" (Infinity is not JSON-serializable). */
export const UNLIMITED = -1;

export interface PlanLimits {
  audits: number; // repository audits per month (-1 = unlimited)
  pullRequests: number; // PR reviews per month (-1 = unlimited)
}

export const LIMITS: Record<Plan, PlanLimits> = {
  starter: { audits: 5, pullRequests: 2 },
  pro: { audits: 100, pullRequests: 100 },
  agency: { audits: UNLIMITED, pullRequests: UNLIMITED },
};

export function isUnlimited(n: number): boolean {
  return n === UNLIMITED;
}

export function defaultPlan(): Plan {
  return "starter";
}

export function planOf(candidate: string | undefined | null): Plan {
  const plan = PLANS.find(p => p === candidate);
  return plan ?? "starter";
}

import Stripe from "stripe";
import { ENV } from "../config/env";
import { LIMITS, PLANS, UNLIMITED, type Plan } from "../config/plans";

/**
 * Stripe client + price mapping.
 * Plan *semantics* live in server/config/plans.ts; this file only deals with
 * the SDK and Stripe-specific configuration.
 */

if (!ENV.STRIPE_SECRET_KEY) {
  // Logged via logger for structured output; billing endpoints validate more
  // strictly at request time.
  console.warn("[stripe] STRIPE_SECRET_KEY is not set — billing endpoints disabled");
}

// The SDK does not throw on a placeholder key until an API call is made;
// construction is kept safe for local dev with Stripe disabled.
export const stripe = new Stripe(ENV.STRIPE_SECRET_KEY || "sk_test_placeholder");

export const STRIPE_ENABLED = Boolean(ENV.STRIPE_SECRET_KEY);

// Re-exported here so existing imports keep working during the module split.
export { PLANS, LIMITS, UNLIMITED };
export type { Plan };

// Stripe price IDs from the dashboard, mapped to plan ids
export const STRIPE_PRICE_IDS: Partial<Record<Plan, string>> = {
  pro: ENV.STRIPE_PRO_PRICE_ID,
  agency: ENV.STRIPE_AGENCY_PRICE_ID,
};

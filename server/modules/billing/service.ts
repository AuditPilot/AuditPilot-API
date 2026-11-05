import { STRIPE_ENABLED, stripe, STRIPE_PRICE_IDS } from "../../lib/stripe";
import { PLANS, type Plan } from "../../config/plans";
import { logger } from "../../config/logger";
import { User, type UserDocument } from "../../models/User";
import { AppError } from "../../middleware/errorHandler";

export async function createCheckoutSession(
  user: UserDocument,
  plan: string,
  host: string,
  protocol: string,
): Promise<string | null> {
  if (!plan || !(Object.values(PLANS) as string[]).includes(plan)) {
    throw AppError.badRequest("Invalid plan selected");
  }
  const priceId = STRIPE_PRICE_IDS[plan as Plan];
  if (!priceId || priceId.startsWith("price_placeholder")) {
    throw AppError.badRequest("This plan is not configured for checkout yet");
  }
  if (!STRIPE_ENABLED) {
    throw AppError.internal("Stripe Secret Key is not configured");
  }

  let stripeCustomerId = user.stripeCustomerId;
  if (!stripeCustomerId) {
    const customer = await stripe.customers.create({
      email: user.email || undefined,
      name: user.displayName || user.username,
      metadata: { userId: String(user._id) },
    });
    stripeCustomerId = customer.id;
    await User.findByIdAndUpdate(user._id, { stripeCustomerId });
  }

  const session = await stripe.checkout.sessions.create({
    customer: stripeCustomerId,
    payment_method_types: ["card"],
    line_items: [{ price: priceId, quantity: 1 }],
    mode: "subscription",
    success_url: `${protocol}://${host}/app?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${protocol}://${host}/app?billing=true`,
    metadata: { userId: String(user._id), plan },
  });

  return session.url;
}

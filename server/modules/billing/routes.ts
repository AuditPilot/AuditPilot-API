import { Router, type Request, Response } from "express";
import { requireAuth } from "../../middleware/auth";
import { recordAuditLog, auditTrail } from "../../middleware/auditLog";
import { logger } from "../../config/logger";
import { STRIPE_ENABLED, stripe } from "../../lib/stripe";
import { PLANS } from "../../config/plans";
import { User } from "../../models/User";
import { createCheckoutSession } from "./service";

export const billingRouter = Router();

// === Checkout ===

billingRouter.post(
  "/billing/create-checkout-session",
  requireAuth,
  auditTrail({ action: "billing.checkout_started" }),
  async (req: Request, res: Response) => {
    const { plan } = (req.body ?? {}) as { plan?: string };
    const user = req.user!;

    if (!plan || !(Object.values(PLANS) as string[]).includes(plan)) {
      return res.status(400).json({ message: "Invalid plan selected" });
    }

    try {
      if (!STRIPE_ENABLED) {
        throw new Error("Stripe Secret Key is not configured correctly in .env");
      }

      const url = await createCheckoutSession(user, plan, req.get("host") || "", req.protocol);

      return res.json({ url });
    } catch (error) {
      logger.error({ err: (error as Error).message }, "Stripe checkout error");
      return res.status(500).json({
        message: "Failed to create checkout session",
        details: (error as Error).message,
      });
    }
  },
);

// === Verify session (ownership-checked) ===

billingRouter.post("/billing/verify-session", requireAuth, async (req: Request, res: Response) => {
  const { sessionId } = (req.body ?? {}) as { sessionId?: string };
  const user = req.user!;

  if (!sessionId) {
    return res.status(400).json({ message: "sessionId is required" });
  }

  try {
    if (!STRIPE_ENABLED) {
      throw new Error("Stripe Secret Key is not configured correctly in .env");
    }
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    // Ownership check: the session must belong to the requesting user
    // (prevents plan escalation using another account's paid session id)
    if (session.metadata?.userId !== String(user._id)) {
      return res.status(403).json({ message: "This checkout session does not belong to you" });
    }

    if (session.payment_status === "paid") {
      const plan = session.metadata?.plan;
      const subscriptionId = session.subscription as string;

      if (plan) {
        await User.findByIdAndUpdate(user._id, {
          plan: plan,
          stripeSubscriptionId: subscriptionId,
        });

        const updatedUser = await User.findById(user._id);
        recordAuditLog(req, {
          action: "billing.plan_verified",
          targetType: "user",
          targetId: String(user._id),
          meta: { plan },
        });
        return res.json({ success: true, plan: updatedUser?.plan });
      }
    }

    return res.json({ success: false });
  } catch (error) {
    logger.error({ err: (error as Error).message }, "Session verification error");
    return res.status(500).json({ message: "Failed to verify session" });
  }
});

// === Webhook ===

billingRouter.post("/billing/webhook", async (req: Request, res: Response) => {
  const sig = (req.headers as Record<string, string | string[] | undefined>)["stripe-signature"];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    // Never accept unsigned payloads — missing secret is a configuration error
    logger.error("STRIPE_WEBHOOK_SECRET is not configured — rejecting webhook");
    return res.status(503).json({ message: "Stripe webhook not configured" });
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.rawBody as unknown as Buffer,
      sig as string,
      webhookSecret,
    );
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "Stripe webhook signature error");
    return res.status(400).send(`Webhook Error: ${(err as Error).message}`);
  }

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as {
        metadata?: { userId?: string; plan?: string };
        subscription?: string;
      };
      const { userId, plan } = session.metadata ?? {};

      if (userId && plan) {
        await User.findByIdAndUpdate(userId, {
          plan: plan,
          stripeSubscriptionId: session.subscription,
        });
        logger.info({ userId, plan }, "user upgraded via checkout");
      }
      break;
    }
    case "customer.subscription.updated": {
      // Portal-driven subscription changes: a subscription that is no longer
      // active (past_due / unpaid / canceled) reverting to starter. We do NOT
      // change the plan on active/trialing statuses — keep what checkout set.
      const subscription = event.data.object as { customer: string; status: string };
      const stillActive = subscription.status === "active" || subscription.status === "trialing";
      if (!stillActive) {
        await User.findOneAndUpdate(
          { stripeCustomerId: subscription.customer },
          { plan: "starter" },
        );
        logger.info(
          { customerId: subscription.customer, status: subscription.status },
          "subscription no longer active — plan reverted to starter",
        );
      }
      break;
    }
    case "customer.subscription.deleted": {
      const subscription = event.data.object as { customer: string };
      await User.findOneAndUpdate(
        { stripeCustomerId: subscription.customer },
        { plan: "starter", stripeSubscriptionId: null },
      );
      logger.info({ customerId: subscription.customer }, "subscription deleted — reverted to starter");
      break;
    }
    default:
      logger.info({ type: event.type }, "Unhandled Stripe event");
  }

  res.json({ received: true });
});

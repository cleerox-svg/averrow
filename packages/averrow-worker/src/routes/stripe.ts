// Stripe webhook routes.
//
// Public, unauthenticated endpoint for Stripe to POST lifecycle
// events. The handler verifies the Stripe-Signature HMAC before
// trusting any payload, so opening the route up doesn't expose
// any state-mutation surface to unauthenticated callers.
//
// Currently a single route; extracted into its own file so future
// Stripe-adjacent endpoints (Checkout session create, customer
// portal redirect, etc.) have a clean home.
//
// v3 Phase D Stripe sprint 4.

import type { RouterType, IRequest } from "itty-router";
import type { Env } from "../types";
import { handleStripeWebhook } from "../handlers/stripeWebhook";

export function registerStripeRoutes(router: RouterType<IRequest>): void {
  router.post("/api/stripe/webhook", (request: Request, env: Env) =>
    handleStripeWebhook(request, env),
  );
}

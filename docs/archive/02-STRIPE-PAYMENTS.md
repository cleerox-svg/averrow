> Archived 2026-06-10: roadmap item shipped — Stripe integration live (handlers/stripeWebhook.ts); residual dashboard work tracked in IMPROVEMENT_PLAN_2026-06 (S6).

# Stripe Payments + Accounting Integration

## Pricing Tiers
| Tier | Price | Method |
|------|-------|--------|
| Professional | $1,499/mo | Stripe Checkout (credit card) |
| Business | $3,999/mo | Stripe Checkout (credit card) |
| Enterprise | Custom | Manual invoice (Stripe Invoicing) |

## Stripe Webhook Events
- checkout.session.completed → activate plan
- invoice.payment_succeeded → extend subscription
- invoice.payment_failed → 3-day grace then suspend
- customer.subscription.updated → sync plan to org
- customer.subscription.deleted → downgrade to free

## DB Changes Needed
```sql
ALTER TABLE organizations ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE organizations ADD COLUMN stripe_subscription_id TEXT;
ALTER TABLE organizations ADD COLUMN stripe_price_id TEXT;
ALTER TABLE organizations ADD COLUMN trial_ends_at TEXT;
ALTER TABLE organizations ADD COLUMN suspended_at TEXT;
ALTER TABLE organizations ADD COLUMN suspension_reason TEXT;
```

## New Worker Endpoints
- POST /api/stripe/webhook — receive events (HMAC verified)
- POST /api/billing/checkout — create Checkout session
- GET  /api/billing/portal — create Customer Portal session
- GET  /api/billing/status — current subscription status

## Self-Service Upgrade Flow
1. Org Settings → [Upgrade Plan]
2. POST /api/billing/checkout {plan: 'business'}
3. Stripe hosted checkout page
4. Webhook fires → plan activated
5. Redirect back with success state

## Accounting: QuickBooks Online
- REST API, automatic invoice sync
- Revenue recognition: subscription revenue monthly
- Trigger: invoice.payment_succeeded → create QBO invoice

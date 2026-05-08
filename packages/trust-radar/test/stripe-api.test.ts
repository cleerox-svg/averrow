import { describe, it, expect, vi, afterEach } from "vitest";
import {
  stripeUrlEncode,
  stripeApiCall,
  createCheckoutSession,
  createPortalSession,
  StripeApiError,
} from "../src/lib/stripe-api";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("stripeUrlEncode", () => {
  it("encodes flat key/value pairs", () => {
    expect(stripeUrlEncode({ customer: "cus_123", mode: "subscription" }))
      .toBe("customer=cus_123&mode=subscription");
  });

  it("encodes nested objects with bracket syntax", () => {
    const out = stripeUrlEncode({
      subscription_data: {
        trial_period_days: 14,
        metadata: { org_id: "42", plan_id: "professional" },
      },
    });
    expect(out).toContain("subscription_data%5Btrial_period_days%5D=14");
    expect(out).toContain("subscription_data%5Bmetadata%5D%5Borg_id%5D=42");
    expect(out).toContain("subscription_data%5Bmetadata%5D%5Bplan_id%5D=professional");
  });

  it("encodes arrays with index", () => {
    const out = stripeUrlEncode({
      line_items: [
        { price: "price_pro", quantity: 1 },
        { price: "price_dwm", quantity: 1 },
      ],
    });
    expect(out).toContain("line_items%5B0%5D%5Bprice%5D=price_pro");
    expect(out).toContain("line_items%5B1%5D%5Bprice%5D=price_dwm");
  });

  it("skips null/undefined values", () => {
    const out = stripeUrlEncode({ customer: "cus_123", customer_email: null, foo: undefined });
    expect(out).toBe("customer=cus_123");
  });

  it("escapes special characters", () => {
    const out = stripeUrlEncode({ note: "hello world & friends" });
    expect(out).toBe("note=hello%20world%20%26%20friends");
  });
});

describe("stripeApiCall", () => {
  it("sends Bearer auth + form-urlencoded body on POST", async () => {
    const fetchMock = vi.fn(async (_url: unknown, init: unknown) => {
      const headers = (init as { headers: Record<string, string> }).headers;
      const body = (init as { body: string }).body;
      expect(headers["Authorization"]).toBe("Bearer sk_test_abc");
      expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
      expect(body).toBe("foo=bar");
      return new Response('{"id":"ch_123"}', { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await stripeApiCall<{ id: string }>("sk_test_abc", "POST", "/charges", { foo: "bar" });
    expect(result.id).toBe("ch_123");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("throws StripeApiError with status + parsed message on 4xx", async () => {
    vi.stubGlobal("fetch", async () => new Response(
      JSON.stringify({ error: { type: "invalid_request_error", message: "No such price: 'price_xxx'" } }),
      { status: 400 },
    ));
    await expect(stripeApiCall("sk", "POST", "/checkout/sessions", { foo: 1 }))
      .rejects.toThrow(StripeApiError);
    try {
      await stripeApiCall("sk", "POST", "/checkout/sessions", { foo: 1 });
    } catch (e) {
      expect(e).toBeInstanceOf(StripeApiError);
      expect((e as StripeApiError).status).toBe(400);
      expect((e as StripeApiError).message).toContain("No such price");
    }
  });

  it("throws on non-JSON response", async () => {
    vi.stubGlobal("fetch", async () => new Response("not json", { status: 200 }));
    await expect(stripeApiCall("sk", "POST", "/x", { a: 1 })).rejects.toThrow(StripeApiError);
  });
});

describe("createCheckoutSession", () => {
  it("POSTs to /checkout/sessions and returns the session", async () => {
    const fetchMock = vi.fn(async (url: unknown) => {
      expect(url).toBe("https://api.stripe.com/v1/checkout/sessions");
      return new Response(
        JSON.stringify({ id: "cs_123", url: "https://checkout.stripe.com/cs_123", status: "open" }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const session = await createCheckoutSession("sk_test", {
      mode: "subscription",
      line_items: [{ price: "price_pro", quantity: 1 }],
      success_url: "https://averrow.com/tenant/settings/billing?checkout=success",
      cancel_url:  "https://averrow.com/tenant/settings/billing?checkout=cancelled",
      client_reference_id: "42",
      subscription_data: { trial_period_days: 14, metadata: { org_id: "42" } },
    });
    expect(session.id).toBe("cs_123");
    expect(session.url).toContain("checkout.stripe.com");
  });
});

describe("createPortalSession", () => {
  it("POSTs to /billing_portal/sessions", async () => {
    const fetchMock = vi.fn(async (url: unknown) => {
      expect(url).toBe("https://api.stripe.com/v1/billing_portal/sessions");
      return new Response(
        JSON.stringify({ id: "bps_123", url: "https://billing.stripe.com/bps_123" }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const session = await createPortalSession("sk_test", {
      customer: "cus_acme",
      return_url: "https://averrow.com/tenant/settings/billing",
    });
    expect(session.url).toContain("billing.stripe.com");
  });
});

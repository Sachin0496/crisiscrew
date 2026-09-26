import { describe, expect, it } from "vitest";
import { postMonitoringAlert } from "../freshworks/freshservice-alerts";
import { simulatedLaya } from "./laya-sim";

describe("simulated Laya", () => {
  const laya = simulatedLaya();
  const ask = async (text: string) => {
    const v = await laya.classify(text);
    return [v.ticketType.label, v.surface.label, v.ticketType.confidence] as const;
  };

  it("answers Laya's two questions, labeled as simulated", async () => {
    const v = await laya.classify("Payment failed but bank shows debit.");
    expect(v).toMatchObject({ source: "laya", model: "simulated", ticketType: { label: "failure" }, surface: { label: "checkout_payments" } });
    expect(v.ticketType.confidence).toBeGreaterThan(0.9);
  });

  it("tells failures from questions and requests, and finds the area", async () => {
    expect((await ask("Can't complete payment for my order.")).slice(0, 2)).toEqual(["failure", "checkout_payments"]);
    expect((await ask("Is cash on delivery available in Pune?")).slice(0, 2)).toEqual(["question", "delivery_orders"]);
    expect((await ask("My parcel tracking has not updated for three days, no update at all")).slice(0, 2)).toEqual(["failure", "delivery_orders"]);
    expect((await ask("My OTP isn't arriving so I can't log in")).slice(0, 2)).toEqual(["failure", "login_account"]);
    expect((await ask("I want to cancel my order")).slice(0, 1)).toEqual(["request"]);
  });

  it("is unsure without evidence, so the built-in labels stand", async () => {
    const [, , confidence] = await ask("hello");
    expect(confidence).toBeLessThan(0.6);
  });
});

describe("Freshservice Alert Management webhook", () => {
  it("posts the alert with the integration's auth-key", async () => {
    const sent: { url: string; init: RequestInit }[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      sent.push({ url, init });
      return Response.json({ message: "Accepted" }, { status: 202 });
    }) as unknown as typeof globalThis.fetch;
    await postMonitoringAlert({ url: "https://acme.alerts.freshservice.com/integrations/1/alerts", key: "k", fetch }, { resource: "checkout-service", metric_name: "http_5xx_rate", severity: "critical", message: "5xx at 3.4%" });
    expect((sent[0]!.init.headers as Record<string, string>).authorization).toBe("auth-key k");
    expect(JSON.parse(String(sent[0]!.init.body))).toMatchObject({ resource: "checkout-service", severity: "critical" });
  });

  it("says why Freshservice refused", async () => {
    const fetch = (async () => Response.json({ message: "You are not authorized to access AMS" }, { status: 401 })) as unknown as typeof globalThis.fetch;
    await expect(postMonitoringAlert({ url: "https://acme.alerts.freshservice.com/integrations/1/alerts", key: "bad", fetch }, { resource: "x", metric_name: "m", severity: "critical", message: "m" })).rejects.toThrow(/401.*not authorized/);
  });
});

describe("Freshdesk labels", () => {
  it("records the classification as the ticket's type and tags", async () => {
    const { freshdeskLabels } = await import("../freshworks/freshdesk");
    expect(freshdeskLabels({ ticketType: "failure", isFailure: true, surface: "checkout_payments", classifier: { source: "laya", model: "simulated", ticketType: "failure" } })).toEqual({
      type: "Incident",
      tags: ["crisiscrew", "ticket-failure", "area-checkout-payments", "classified-by-laya-simulated"],
    });
    expect(freshdeskLabels({ ticketType: "question", isFailure: false, surface: "delivery_orders" }).type).toBe("Question");
    expect(freshdeskLabels({ ticketType: "request", isFailure: false, surface: "refunds_billing" }).type).toBe("Refund");
    expect(freshdeskLabels({ ticketType: "request", isFailure: false, surface: "other" }).type).toBeUndefined();
  });
});

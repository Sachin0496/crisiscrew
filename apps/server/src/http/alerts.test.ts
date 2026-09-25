import { CachedEmbedder, FreshserviceAlertsClient, type FreshserviceAlert } from "@crisiscrew/adapters";
import type { Alert } from "@crisiscrew/contracts";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_EMBEDDING_MODEL, loadConfig } from "../config";
import { EMBEDDING_CACHE_DIR } from "../paths";
import { Runtime } from "../runtime";
import { loadPolicy, loadScenarios } from "../scenarios";
import { createApp } from "./app";

const fsAlert: FreshserviceAlert = {
  id: 9101,
  subject: "checkout-service 5xx rate 3.4% for 5 minutes",
  metric_name: "http_5xx_rate",
  severity: 201,
  state: 1,
  tags: ["service:checkout-service"],
  occurrence_time: new Date().toISOString(),
};

async function setup(live: boolean) {
  const fetch = (async (input: string | URL) => {
    const path = new URL(String(input)).pathname;
    const body = path.endsWith("/9101") ? { alert: fsAlert } : { alerts: [fsAlert] };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof globalThis.fetch;
  const env = live ? { ALERTS: "freshservice", FRESHSERVICE_DOMAIN: "acme", FRESHSERVICE_API_KEY: "fs", FRESHSERVICE_WEBHOOK_SECRET: "fs-secret" } : {};
  const config = loadConfig({ SANDBOX_LATENCY_MS: "0", ADMIN_TOKEN: "admin", ...env });
  const runtime = new Runtime({
    policy: loadPolicy(),
    scenarios: loadScenarios(),
    embedder: new CachedEmbedder({ modelId: DEFAULT_EMBEDDING_MODEL, dir: EMBEDDING_CACHE_DIR, inner: null }),
    latencyMs: 0,
    liveWorld: "checkout-v4.21.7",
    ...(live ? { live: { alerts: { client: new FreshserviceAlertsClient({ domain: "acme.freshservice.com", apiKey: "fs", fetch }), rules: [] } } } : {}),
  });
  await runtime.start();
  return { app: createApp({ runtime, config }), runtime };
}

const post = (body: unknown, headers: Record<string, string> = {}) => ({ method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("alert routes", () => {
  it("takes a Freshservice webhook with the shared secret, reads the alert back, and opens an incident from it", async () => {
    const { app, runtime } = await setup(true);
    const hook = "/api/webhooks/freshservice/alerts";
    expect((await app.request(hook, post({ alert_id: 9101 }))).status).toBe(401);
    expect((await app.request(hook, post({}, { "x-crisiscrew-secret": "fs-secret" }))).status).toBe(400);
    expect((await app.request(hook, post({ alert_id: "9101" }, { "x-crisiscrew-secret": "fs-secret" }))).status).toBe(202);
    await vi.waitFor(() => expect(runtime.state().incidentOrder).toHaveLength(1), { timeout: 5_000 });
    const incident = runtime.state().incidents[runtime.state().incidentOrder[0]!]!;
    expect(incident).toMatchObject({ trigger: "alert", surface: "checkout_payments" });
    // The poll sees the same alert again: it's recorded once.
    await runtime.pollFreshserviceAlerts();
    expect(Object.values(runtime.state().alerts)).toHaveLength(1);
  });

  it("lets an admin post an alert by hand, and keeps the Freshservice webhook off when alerts aren't switched on", async () => {
    const { app, runtime } = await setup(false);
    expect((await app.request("/api/webhooks/freshservice/alerts", post({ alert_id: 1 }, { "x-crisiscrew-secret": "x" }))).status).toBe(404);
    const alert = { service: "search-service", metric: "cpu", severity: "critical", label: "CPU 97%" };
    expect((await app.request("/api/alerts", post(alert))).status).toBe(401);
    expect((await app.request("/api/alerts", post({ ...alert, severity: "sev1" }, { authorization: "Bearer admin" }))).status).toBe(400);
    const res = await app.request("/api/alerts", post(alert, { authorization: "Bearer admin" }));
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ source: "manual", service: "search-service", severity: "critical" } satisfies Partial<Alert>);
    // search-service isn't in the live world's catalog, so nothing opens.
    expect(runtime.state().incidentOrder).toHaveLength(0);
  });
});

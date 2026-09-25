import { CachedEmbedder } from "@crisiscrew/adapters";
import type { PagingView } from "@crisiscrew/contracts";
import type { IncidentsPort } from "@crisiscrew/core";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_EMBEDDING_MODEL, loadConfig } from "../config";
import { EMBEDDING_CACHE_DIR } from "../paths";
import { Runtime } from "../runtime";
import { loadPolicy, loadScenarios } from "../scenarios";
import { createApp } from "./app";

/** Stands in for Freshservice: files every incident as ticket #314. */
const freshservice: IncidentsPort = {
  mode: "live",
  adapter: "freshservice",
  open: async () => ({ id: "#314", url: "https://acme.freshservice.com/a/tickets/314" }),
  note: async () => undefined,
  setImportance: async () => undefined,
};

async function setup() {
  const scenarios = loadScenarios();
  const hero = scenarios.get("checkout-v4.21.7")!;
  // Nobody answers, so paging runs out and waits for a human.
  scenarios.set("nobody-answers", { ...hero, id: "nobody-answers", world: { ...hero.world, oncall: hero.world.oncall.map((r) => ({ ...r, answers: "no_answer" as const })) } });
  const config = loadConfig({ SANDBOX_LATENCY_MS: "0", ADMIN_TOKEN: "admin", FRESHSERVICE_WEBHOOK_SECRET: "fs-secret" });
  const runtime = new Runtime({
    policy: loadPolicy(),
    scenarios,
    embedder: new CachedEmbedder({ modelId: DEFAULT_EMBEDDING_MODEL, dir: EMBEDDING_CACHE_DIR, inner: null }),
    latencyMs: 0,
    liveWorld: "checkout-v4.21.7",
    live: { incidents: freshservice },
  });
  await runtime.start();
  const done = new Promise<void>((resolve) => {
    const off = runtime.bus.subscribe((e) => {
      if (e.type === "replay.finished") {
        off();
        resolve();
      }
    });
  });
  await runtime.startReplay("nobody-answers", 500);
  await done;
  const incidentId = runtime.state().incidentOrder[0]!;
  // Calls finish on the scenario clock after the replay's last ticket, so wait for paging to run out.
  await vi.waitFor(() => expect(runtime.state().incidents[incidentId]?.paging?.status).toBe("exhausted"), { timeout: 10_000, interval: 50 });
  return { app: createApp({ runtime, config }), runtime, incidentId };
}

const post = (body: unknown, headers: Record<string, string> = {}) => ({ method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("acknowledging a page", () => {
  it("takes an acknowledgement from a Freshservice workflow, by the incident's ticket id, with the shared secret", async () => {
    const { app, runtime, incidentId } = await setup();
    expect(runtime.state().incidents[incidentId]?.paging?.status).toBe("exhausted");
    const hook = "/api/webhooks/freshservice/acknowledge";
    expect((await app.request(hook, post({ ticket_id: 314 }))).status).toBe(401);
    expect((await app.request(hook, post({ ticket_id: 999 }, { "x-crisiscrew-secret": "fs-secret" }))).status).toBe(404);
    const res = await app.request(hook, post({ ticket_id: "314", agent_name: "Asha Rao" }, { "x-crisiscrew-secret": "fs-secret" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ incidentId, paging: { status: "acknowledged", acknowledgedBy: "Asha Rao", via: "operator" } });

    // Already taken: an operator's acknowledgement changes nothing.
    const again = await app.request(`/api/incidents/${incidentId}/page/acknowledge`, post({ by: "Vikram" }, { authorization: "Bearer admin" }));
    expect(((await again.json()) as PagingView).acknowledgedBy).toBe("Asha Rao");
  });

  it("lets an admin acknowledge in CrisisCrew, and refuses without the token or for an unknown incident", async () => {
    const { app, incidentId } = await setup();
    const route = `/api/incidents/${incidentId}/page/acknowledge`;
    expect((await app.request(route, post({ by: "Vikram" }))).status).toBe(401);
    expect((await app.request("/api/incidents/INC-404/page/acknowledge", post({}, { authorization: "Bearer admin" }))).status).toBe(404);
    const res = await app.request(route, post({}, { authorization: "Bearer admin", "x-operator-name": "Vikram S." }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "acknowledged", acknowledgedBy: "Vikram S.", via: "operator" });
  });

  it("keeps the Freshservice route off without its secret", async () => {
    const config = loadConfig({});
    const runtime = new Runtime({
      policy: loadPolicy(),
      scenarios: loadScenarios(),
      embedder: new CachedEmbedder({ modelId: DEFAULT_EMBEDDING_MODEL, dir: EMBEDDING_CACHE_DIR, inner: null }),
      latencyMs: 0,
      liveWorld: "checkout-v4.21.7",
    });
    await runtime.start();
    expect((await createApp({ runtime, config }).request("/api/webhooks/freshservice/acknowledge", post({ ticket_id: 314 }))).status).toBe(404);
  });
});

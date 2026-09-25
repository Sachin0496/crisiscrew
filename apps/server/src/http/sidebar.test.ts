import { CachedEmbedder } from "@crisiscrew/adapters";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { DEFAULT_EMBEDDING_MODEL, loadConfig } from "../config";
import { EMBEDDING_CACHE_DIR, REPO_ROOT } from "../paths";
import { Runtime } from "../runtime";
import { loadPolicy, loadScenarios } from "../scenarios";
import { createApp } from "./app";

/** The Freshdesk sidebar's renderer, loaded the way the browser loads it: a plain script that sets self.CrisisCrewSidebar. */
function sidebarRenderer(): { renderImpact(data: unknown): string; escapeHtml(value: string): string } {
  const code = readFileSync(`${REPO_ROOT}integrations/freshdesk-sidebar/app/scripts/render.js`, "utf8");
  const sandbox: { self: Record<string, unknown> } = { self: {} };
  runInNewContext(code, sandbox);
  return sandbox.self.CrisisCrewSidebar as ReturnType<typeof sidebarRenderer>;
}

async function afterHeroReplay() {
  const runtime = new Runtime({
    policy: loadPolicy(),
    scenarios: loadScenarios(),
    embedder: new CachedEmbedder({ modelId: DEFAULT_EMBEDDING_MODEL, dir: EMBEDDING_CACHE_DIR, inner: null }),
    latencyMs: 0,
    liveWorld: "checkout-v4.21.7",
  });
  await runtime.start();
  const done = new Promise<void>((resolve) => runtime.bus.subscribe((e) => e.type === "replay.finished" && resolve()));
  await runtime.startReplay("checkout-v4.21.7", 500);
  await done;
  return { app: createApp({ runtime, config: loadConfig({ SANDBOX_LATENCY_MS: "0", PUBLIC_BASE_URL: "https://crisiscrew.example", ADMIN_TOKEN: "a", APPROVER_TOKEN: "b" }) }), runtime };
}

describe("the Freshdesk sidebar app against the server's real payload", () => {
  const sidebar = sidebarRenderer();

  it("shows the incident, coverage, the customer's state, evidence and recovery", async () => {
    const { app } = await afterHeroReplay();
    const html = sidebar.renderImpact(await (await app.request("/api/tickets/T-1004/impact")).json());
    expect(html).toContain("Checkout and payment failures");
    expect(html).toContain("Likely cause: <strong>checkout-service v4.21.7</strong> (97%)");
    expect(html).toMatch(/Recovery coverage<\/span><strong>21\/23<\/strong>/);
    expect(html).toContain("8 complained · 15 silent · 2 need a human");
    expect(html).toContain("<strong>Priya K.</strong>");
    expect(html).toContain("Confirmed from a failed or pending payment inside the incident window.");
    expect(html).toMatch(/Card payment of ₹649 failed at/);
    expect(html).toContain("Reply on this ticket");
    expect(html).toContain("Goodwill credit · ₹200");
    expect(html).toContain('href="https://crisiscrew.example/#/customers/c-priya"');
  });

  it("says when a ticket isn't tracked or isn't part of an incident, and escapes what customers wrote", async () => {
    const { app } = await afterHeroReplay();
    expect(sidebar.renderImpact(await (await app.request("/api/freshdesk/tickets/12345")).json())).toContain("Not tracked yet");
    // T-1001 is b1's question about a delivery address: read, but not part of the incident.
    expect(sidebar.renderImpact(await (await app.request("/api/tickets/T-1001/impact")).json())).toContain("Not part of an incident");
    expect(sidebar.escapeHtml('<img src=x onerror="alert(1)">')).toBe("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });
});

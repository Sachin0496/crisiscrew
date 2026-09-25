import { CachedEmbedder, FreshdeskClient, restWriter, type FreshdeskTicket } from "@crisiscrew/adapters";
import { parseOffset, recoveryCoverage, type Scenario } from "@crisiscrew/contracts";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_EMBEDDING_MODEL, loadConfig } from "../config";
import { EMBEDDING_CACHE_DIR } from "../paths";
import { Runtime } from "../runtime";
import { loadPolicy, loadScenarios } from "../scenarios";
import { createApp } from "./app";
import type { TicketImpact } from "./impact";

/** The hero world moved five minutes earlier, so every failed payment has already happened when a live session starts. */
function pastWorld(): Scenario {
  const hero = loadScenarios().get("checkout-v4.21.7")!;
  const earlier = (at: string) => `${parseOffset(at) / 1000 - 300}s`;
  return {
    ...hero,
    id: "freshdesk-live",
    world: {
      ...hero.world,
      deployments: hero.world.deployments.map((d) => ({ ...d, at: earlier(d.at) })),
      attempts: hero.world.attempts.map((a) => ({ ...a, at: earlier(a.at) })),
    },
  };
}

const COMPLAINTS: Record<number, { email: string; name: string; text: string }> = {
  101: { email: "priya.k@example.com", name: "Priya K.", text: "My checkout keeps loading forever." },
  102: { email: "arjun.k@example.com", name: "Arjun K.", text: "UPI isn't working. Tried twice." },
  103: { email: "sneha.m@example.com", name: "Sneha M.", text: "Payment failed but bank shows debit." },
  104: { email: "varun.n@example.com", name: "Varun N.", text: "Card rejected on checkout — card is fine." },
  105: { email: "judge@example.org", name: "A Judge", text: "Every payment method fails when I try to check out." },
};

/** A fake Freshdesk: serves the complaints above and records every note and reply written back. */
function fakeFreshdesk(createdAt = () => new Date().toISOString()) {
  const writes: { kind: "note" | "reply"; ticketId: number; body: string }[] = [];
  const ticket = (id: number): FreshdeskTicket => {
    const c = COMPLAINTS[id]!;
    return { id, subject: null, description_text: c.text, source: 2, created_at: createdAt(), requester: { id: 9000 + id, name: c.name, email: c.email } };
  };
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const one = url.pathname.match(/^\/api\/v2\/tickets\/(\d+)$/);
    if (method === "GET" && one) return COMPLAINTS[Number(one[1])] ? reply(ticket(Number(one[1]))) : reply({ description: "not found" }, 404);
    if (method === "GET" && url.pathname === "/api/v2/tickets") return reply(Object.keys(COMPLAINTS).map((id) => ticket(Number(id))));
    const write = url.pathname.match(/^\/api\/v2\/tickets\/(\d+)\/(notes|reply)$/);
    if (method === "POST" && write) {
      writes.push({ kind: write[2] === "notes" ? "note" : "reply", ticketId: Number(write[1]), body: (JSON.parse(String(init?.body)) as { body: string }).body });
      return reply({ id: writes.length }, 201);
    }
    return reply({ description: "unexpected" }, 404);
  });
  return { writes, fetch: fetch as unknown as typeof globalThis.fetch };
}

async function setup(options: { freshdesk?: boolean; createdAt?: () => string } = {}) {
  const fake = fakeFreshdesk(options.createdAt);
  const env = options.freshdesk === false ? {} : { TICKETS: "freshdesk", FRESHDESK_DOMAIN: "acme", FRESHDESK_API_KEY: "fd-key", FRESHDESK_WEBHOOK_SECRET: "hook-secret" };
  const config = loadConfig({ SANDBOX_LATENCY_MS: "0", ...env });
  const client = new FreshdeskClient({ domain: "acme.freshdesk.com", apiKey: "fd-key", fetch: fake.fetch });
  const scenarios = loadScenarios();
  scenarios.set("freshdesk-live", pastWorld());
  const runtime = new Runtime({
    policy: loadPolicy(),
    scenarios,
    embedder: new CachedEmbedder({ modelId: DEFAULT_EMBEDDING_MODEL, dir: EMBEDDING_CACHE_DIR, inner: null }),
    latencyMs: 0,
    liveWorld: "freshdesk-live",
    ...(options.freshdesk === false ? {} : { live: { freshdesk: { client, writer: restWriter(client) } } }),
  });
  await runtime.start();
  return { app: createApp({ runtime, config }), runtime, fake };
}

const hook = (body: unknown, secret?: string) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...(secret ? { "x-crisiscrew-secret": secret } : {}) },
  body: JSON.stringify(body),
});

describe("Freshdesk webhook", () => {
  it("accepts a new ticket id, reads the ticket back, and ingests it once, matched to the customer by email", async () => {
    const { app, runtime } = await setup();
    const res = await app.request("/api/webhooks/freshdesk", hook({ ticket_id: 101 }, "hook-secret"));
    expect(res.status).toBe(202);
    await vi.waitFor(() => expect(runtime.state().ticketOrder).toHaveLength(1));
    const view = runtime.state().tickets[runtime.state().ticketOrder[0]!]!;
    expect(view.ticket).toMatchObject({ source: "freshdesk", externalId: "freshdesk:101", customerRef: "c-priya", customerName: "Priya K.", channel: "portal" });
    expect(await runtime.ingestFreshdesk(101)).toEqual({ status: "duplicate", freshdeskId: 101 });
    // Freshdesk's simple mode nests the fields; it's accepted too.
    expect((await app.request("/api/webhooks/freshdesk", hook({ freshdesk_webhook: { ticket_id: "102" } }, "hook-secret"))).status).toBe(202);
    await vi.waitFor(() => expect(runtime.state().ticketOrder).toHaveLength(2));
  });

  it("refuses a missing or wrong secret and a body without a ticket id, and is off without Freshdesk", async () => {
    const { app } = await setup();
    expect((await app.request("/api/webhooks/freshdesk", hook({ ticket_id: 101 }))).status).toBe(401);
    expect((await app.request("/api/webhooks/freshdesk", hook({ ticket_id: 101 }, "nope"))).status).toBe(401);
    expect((await app.request("/api/webhooks/freshdesk", hook({ id: 101 }, "hook-secret"))).status).toBe(400);
    const off = await setup({ freshdesk: false });
    expect((await off.app.request("/api/webhooks/freshdesk", hook({ ticket_id: 101 }, "hook-secret"))).status).toBe(404);
  });
});

describe("a customer-harm response driven from Freshdesk", () => {
  it("opens the incident from Freshdesk complaints, writes back to each ticket, and shows each customer's impact in the sidebar data", async () => {
    const { app, runtime, fake } = await setup();
    for (const id of [101, 102, 103, 104]) await runtime.ingestFreshdesk(id);
    await runtime.engineNow().whenIdle();
    const state = runtime.state();
    const incident = state.incidents[state.incidentOrder[0]!]!;
    expect(incident.ticketIds).toHaveLength(4);
    expect(recoveryCoverage(incident)).toMatchObject({ complained: 4, silent: 19 });

    // Every Freshdesk ticket got a private link note, the customer's update as a reply, and the outcome note.
    for (const id of [101, 102, 103, 104]) {
      const mine = fake.writes.filter((w) => w.ticketId === id);
      expect(mine.map((w) => w.kind)).toEqual(["note", "reply", "note"]);
      expect(mine[2]?.body).toMatch(/^CrisisCrew · INC-\d{4}-001 · Checkout and payment failures<br>Confirmed affected:/);
    }
    // Silent customers came from the orders data, not Freshdesk, so nothing about them was written there.
    expect(new Set(fake.writes.map((w) => w.ticketId))).toEqual(new Set([101, 102, 103, 104]));
    // The audit log names the adapter that served each call.
    const replies = runtime.engineNow().audit.entries().filter((e) => e.tool === "send_customer_update" && e.argsSummary.includes("ticket_reply"));
    expect(replies.every((e) => e.adapter === "freshdesk")).toBe(true);

    const sidebar = (await (await app.request("/api/freshdesk/tickets/101")).json()) as TicketImpact;
    expect(sidebar).toMatchObject({
      tracked: true,
      ticket: { externalId: "freshdesk:101", customerName: "Priya K.", reportsFailure: true },
      incident: { title: "Checkout and payment failures", coverage: { confirmed: 23 } },
      customer: { ref: "c-priya", confidence: "confirmed", complained: true, state: "recovered" },
    });
    expect(await (await app.request("/api/freshdesk/tickets/999")).json()).toMatchObject({ tracked: false });
  });

  it("answers a complaint it can't match to a failed payment with an acknowledgement, and never credits it", async () => {
    const { runtime, fake } = await setup();
    for (const id of [101, 102, 103, 104, 105]) {
      await runtime.ingestFreshdesk(id);
      await runtime.engineNow().whenIdle();
    }
    const state = runtime.state();
    const incident = state.incidents[state.incidentOrder[0]!]!;
    const judge = incident.impact!.customers.find((c) => c.name === "A Judge");
    expect(judge).toMatchObject({ confidence: "unverified", complained: true, ref: "freshdesk:requester:9105" });
    expect(fake.writes.find((w) => w.ticketId === 105 && w.kind === "reply")?.body).toMatch(/couldn&#39;t find a failed payment on your account yet/);
    expect(state.credits.some((c) => c.customerRef === judge?.ref)).toBe(false);
  });
});

describe("Freshdesk poll fallback", () => {
  it("ingests tickets created since the session started, once, and ignores older ones", async () => {
    let created = new Date(Date.now() - 60 * 60_000).toISOString();
    const { runtime } = await setup({ createdAt: () => created });
    expect(await runtime.pollFreshdesk()).toBe(0);
    created = new Date(Date.now() + 1_000).toISOString();
    expect(await runtime.pollFreshdesk()).toBe(5);
    expect(await runtime.pollFreshdesk()).toBe(0);
    expect(runtime.state().ticketOrder).toHaveLength(5);
  });
});

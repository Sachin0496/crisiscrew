import { CachedEmbedder } from "@crisiscrew/adapters";
import type { CrisisEvent } from "@crisiscrew/contracts";
import { describe, expect, it } from "vitest";
import { DEFAULT_EMBEDDING_MODEL } from "./config";
import { EMBEDDING_CACHE_DIR } from "./paths";
import { Runtime } from "./runtime";
import { loadPolicy, loadScenarios } from "./scenarios";

function runtime() {
  return new Runtime({
    policy: loadPolicy(),
    scenarios: loadScenarios(),
    embedder: new CachedEmbedder({ modelId: DEFAULT_EMBEDDING_MODEL, dir: EMBEDDING_CACHE_DIR, inner: null }),
    latencyMs: 0,
    liveWorld: "checkout-v4.21.7",
  });
}

function finished(rt: Runtime): Promise<CrisisEvent> {
  return new Promise((resolve) => {
    const off = rt.bus.subscribe((e) => {
      if (e.type === "replay.finished") {
        off();
        resolve(e);
      }
    });
  });
}

describe("Runtime", () => {
  it("starts in a live session backed by the sandbox world, with no tickets", async () => {
    const rt = runtime();
    await rt.start();
    expect(rt.state().session).toMatchObject({ mode: "live", scenarioId: "checkout-v4.21.7" });
    expect(rt.state().ticketOrder).toEqual([]);
  });

  it("replays a scenario in real time through the engine and announces when it's done", async () => {
    const rt = runtime();
    await rt.start();
    const done = finished(rt);
    await rt.startReplay("checkout-v4.21.7", 500);
    await done;
    const s = rt.state();
    expect(s.session).toMatchObject({ mode: "replay", scenarioId: "checkout-v4.21.7", speed: 500 });
    expect(s.ticketOrder).toHaveLength(13);
    expect(s.incidents[s.incidentOrder[0]!]?.status).toBe("awaiting_approval");
    expect(s.replayFinished).toBe(true);
  });

  it("a new replay replaces the old one: nothing from the first leaks into the second", async () => {
    const rt = runtime();
    await rt.start();
    await rt.startReplay("checkout-v4.21.7", 1);
    const done = finished(rt);
    await rt.startReplay("two-card-complaints", 500);
    await done;
    await new Promise((r) => setTimeout(r, 50));
    const s = rt.state();
    expect(s.session.scenarioId).toBe("two-card-complaints");
    expect(s.ticketOrder).toHaveLength(2);
    expect(s.incidentOrder).toEqual([]);
  });

  it("puts a typed ticket into the current session as a manual ticket", async () => {
    const rt = runtime();
    await rt.start();
    const ticket = await rt.ingest({ customerRef: "judge", customerName: "A Judge", channel: "chat", body: "My checkout keeps loading forever." });
    expect(ticket.source).toBe("manual");
    expect(rt.state().tickets[ticket.id]?.signal?.surface).toBe("checkout_payments");
  });

  it("anchors a live session's world in the past, so customers' failed payments are already on record", async () => {
    const rt = runtime();
    await rt.start();
    for (const customerName of ["Priya K.", "Arjun K.", "Sneha M.", "Varun N."]) {
      const known = await rt.findCustomer({ name: customerName });
      const body = { "Priya K.": "My checkout keeps loading forever.", "Arjun K.": "UPI isn't working. Tried twice.", "Sneha M.": "Payment failed but bank shows debit.", "Varun N.": "Card rejected on checkout — card is fine." }[customerName]!;
      await rt.ingest({ customerRef: known!.ref, customerName, channel: "chat", body });
    }
    await rt.engineNow().whenIdle();
    const s = rt.state();
    const incident = s.incidents[s.incidentOrder[0]!]!;
    const complained = incident.impact!.customers.filter((c) => c.complained);
    expect(complained.map((c) => `${c.ref}:${c.confidence}`)).toEqual(["c-priya:confirmed", "c-arjun:confirmed", "c-sneha:confirmed", "c-varun:confirmed"]);
    expect(incident.impact!.customers.filter((c) => !c.complained)).toHaveLength(19);
  });

  it("lists scenarios with what each is expected to show", () => {
    const list = runtime().scenarioList();
    expect(list.find((s) => s.id === "lookalike-checkout-questions")).toMatchObject({ expected: { incident: false, refusedBy: "failure_share" } });
  });
});

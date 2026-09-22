import { CachedEmbedder } from "@crisiscrew/adapters";
import { PatternEngine, type PatternResult } from "@crisiscrew/core";
import { describe, expect, it } from "vitest";
import { DEFAULT_EMBEDDING_MODEL } from "./config";
import { EMBEDDING_CACHE_DIR } from "./paths";
import { loadPolicy, loadScenarios, scenarioTickets } from "./scenarios";

// Real embeddings from the committed cache; no model is loaded.
const embedder = new CachedEmbedder({ modelId: DEFAULT_EMBEDDING_MODEL, dir: EMBEDDING_CACHE_DIR, inner: null });
const policy = loadPolicy();
const scenarios = loadScenarios();

async function detect(id: string) {
  const scenario = scenarios.get(id)!;
  const engine = new PatternEngine(embedder, policy.correlation, { baselinePerHour: scenario.world.baselinePerHour });
  await engine.init();
  const results: { body: string; result: PatternResult }[] = [];
  for (const ticket of scenarioTickets(scenario, 0)) {
    const result = await engine.ingest(ticket);
    if (result.fires) engine.attachIncident("INC", result.candidate?.memberTicketIds ?? []);
    results.push({ body: ticket.body, result });
  }
  return { scenario, results };
}

describe("detection over the scenario data", () => {
  it.each([...scenarios.keys()])("%s opens an incident only if expected", async (id) => {
    const { scenario, results } = await detect(id);
    expect(results.some((r) => r.result.fires)).toBe(scenario.expected.incident);
    if (scenario.expected.refusedBy) {
      const last = results[results.length - 1]!.result.candidate;
      expect(last?.gates.filter((g) => !g.pass).map((g) => g.name)).toContain(scenario.expected.refusedBy);
    }
  });

  it("hero: fires on the fourth complaint and links all eight complaints, but no background ticket", async () => {
    const { results } = await detect("checkout-v4.21.7");
    const firing = results.find((r) => r.result.fires);
    expect(firing?.body).toBe("Card rejected on checkout — card is fine.");
    const joined = results.filter((r) => r.result.joinIncidentId).map((r) => r.body);
    expect(joined).toEqual([
      "Can't complete payment for my order.",
      "Money got deducted twice but the order page says failed.",
      "Payment page goes blank after I enter the bank OTP, and the order is not placed.",
      "Tried three different cards and the payment still fails at the last step.",
    ]);
    expect((firing?.result.candidate?.memberTicketIds.length ?? 0) + joined.length).toBe(8);
  });

  it("classifies every look-alike question as a question", async () => {
    const { results } = await detect("lookalike-checkout-questions");
    expect(results.map((r) => r.result.signal.isFailure)).toEqual([false, false, false, false, false, true]);
  });
});

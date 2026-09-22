/**
 * Calibration report: runs every scenario through the detection engine with
 * each cached model and prints classifications, similarities and gate
 * outcomes, so thresholds are chosen from data.
 *
 *   pnpm --filter @crisiscrew/server exec tsx src/cli/calibrate.ts [model ...]
 */
import { CachedEmbedder } from "@crisiscrew/adapters";
import { parseOffset, type Scenario, type Ticket } from "@crisiscrew/contracts";
import { cosine, PatternEngine, ticketText } from "@crisiscrew/core";
import { EMBEDDING_CACHE_DIR } from "../paths";
import { loadPolicy, loadScenarios } from "../scenarios";

const models = process.argv.slice(2);
if (models.length === 0) models.push("Xenova/all-MiniLM-L6-v2", "Xenova/paraphrase-multilingual-MiniLM-L12-v2");

const policy = loadPolicy();
const scenarios = loadScenarios();
const f = (x: number) => x.toFixed(2);

function tickets(s: Scenario): Ticket[] {
  const customers = new Map(s.world.customers.map((c) => [c.ref, c.name]));
  return s.tickets.map((t, i) => ({
    id: `${s.id}#${i + 1}`,
    source: "sandbox",
    customerRef: t.customerRef,
    customerName: customers.get(t.customerRef) ?? t.customerRef,
    channel: t.channel,
    subject: t.subject,
    body: t.body,
    receivedAt: parseOffset(t.at),
  }));
}

for (const modelId of models) {
  const embedder = new CachedEmbedder({ modelId, dir: EMBEDDING_CACHE_DIR, inner: null });
  console.log(`\n=== ${modelId} ===`);

  for (const s of scenarios.values()) {
    const engine = new PatternEngine(embedder, policy.correlation, { baselinePerHour: s.world.baselinePerHour });
    await engine.init();
    let firedAt: string | undefined;
    const lines: string[] = [];
    for (const t of tickets(s)) {
      const r = await engine.ingest(t);
      const failing = r.candidate?.gates.filter((g) => !g.pass).map((g) => g.name) ?? [];
      lines.push(
        `  ${r.signal.isFailure ? "FAIL" : "  q "} ${r.signal.surface.padEnd(17)} fs=${f(r.signal.failureScore).padStart(5)} ` +
          `near=${f(r.nearest[0]?.similarity ?? 0)} size=${r.candidate?.memberTicketIds.length ?? 0} coh=${f(r.candidate?.cohesion ?? 0)} ` +
          `${r.fires ? "FIRES" : r.joinIncidentId ? `joins ${r.joinIncidentId}` : `refused:${failing.join(",")}`}  "${t.body.slice(0, 60)}"`,
      );
      if (r.fires && !firedAt) {
        firedAt = t.id;
        engine.attachIncident("INC", r.candidate?.memberTicketIds ?? []);
      }
    }
    const ok = Boolean(firedAt) === s.expected.incident;
    console.log(`\n[${ok ? "ok" : "MISMATCH"}] ${s.id}: expected ${s.expected.incident ? "incident" : "no incident"}, got ${firedAt ? `fired at ${firedAt}` : "no incident"}`);
    for (const l of lines) console.log(l);
  }

  // Pairwise similarity summaries for the hand-labeled groups.
  const hero = scenarios.get("checkout-v4.21.7")!;
  const heroFail = hero.tickets.filter((t) => t.customerRef.startsWith("c-")).map((t) => ticketText(t));
  const heroBg = hero.tickets.filter((t) => t.customerRef.startsWith("b")).map((t) => ticketText(t));
  const vf = await embedder.embed(heroFail);
  const vb = await embedder.embed(heroBg);
  const pairs = (vs: Float32Array[]) => vs.flatMap((a, i) => vs.slice(i + 1).map((b) => cosine(a, b)));
  const within = pairs(vf);
  const across = vf.flatMap((a) => vb.map((b) => cosine(a, b)));
  console.log(
    `\nhero failures pairwise: mean ${f(within.reduce((x, y) => x + y) / within.length)} min ${f(Math.min(...within))}; ` +
      `failure vs background: mean ${f(across.reduce((x, y) => x + y) / across.length)} max ${f(Math.max(...across))}`,
  );
}

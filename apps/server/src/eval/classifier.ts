/**
 * The classifier evaluation: the built-in classifier (embedding prototypes)
 * against Laya on labeled tickets, then detection end to end with each.
 *
 * - Ticket type: is it a failure report? Precision, recall, F1, accuracy.
 * - Product area: accuracy where the label is clear.
 * - Laya's probabilities: Brier score and expected calibration error.
 * - What the engine actually uses: Laya above the policy's thresholds, the
 *   built-in answer below them or when Laya doesn't answer.
 * - Detection: the eval's held-out test runs, with and without Laya.
 *
 * Laya runs when a server answers at LAYA_URL (default http://localhost:8000;
 * `pnpm laya` starts one). Otherwise the report covers the built-in
 * classifier and says Laya wasn't run. Writes docs/eval-classifier.md.
 *
 *   pnpm eval:classifier
 */
import { CachedEmbedder, LayaClassifier } from "@crisiscrew/adapters";
import type { Surface, Ticket, TicketType } from "@crisiscrew/contracts";
import { PatternEngine, type ClassifierVerdict } from "@crisiscrew/core";
import { writeFileSync } from "node:fs";
import { DEFAULT_EMBEDDING_MODEL } from "../config";
import { loadPools } from "../corpus";
import { CLASSIFIER_EVAL_DOC, EMBEDDING_CACHE_DIR } from "../paths";
import { loadPolicy, scenarioTickets } from "../scenarios";
import { generateRuns, type EvalRun } from "./generate";
import { score, toOutcome, type Opened, type Score } from "./metrics";

const embedder = new CachedEmbedder({ modelId: DEFAULT_EMBEDDING_MODEL, dir: EMBEDDING_CACHE_DIR, inner: null });
const policy = loadPolicy();
const LAYA_URL = (process.env.LAYA_URL || "http://localhost:8000").replace(/\/+$/, "");
const T0 = Date.UTC(2026, 8, 25, 14, 0, 0);

type Labeled = { text: string; failure: boolean; surface: Surface | null; pool: string };

/** Labels come from the pool a sentence was written for. Background traffic is questions and requests of every area, so its area isn't scored. */
const POOL_LABELS: Record<string, { failure: boolean; surface: Surface | null }> = {
  "incident-checkout-release": { failure: true, surface: "checkout_payments" },
  "incident-upi-outage": { failure: true, surface: "checkout_payments" },
  "incident-login-otp": { failure: true, surface: "login_account" },
  "lookalike-questions": { failure: false, surface: "checkout_payments" },
  "scattered-account": { failure: true, surface: null },
  "scattered-app": { failure: true, surface: "app_performance" },
  "scattered-delivery": { failure: true, surface: "delivery_orders" },
  "scattered-orders": { failure: true, surface: "delivery_orders" },
  "scattered-refunds": { failure: true, surface: "refunds_billing" },
  "stress-delivery-mix": { failure: true, surface: "delivery_orders" },
  background: { failure: false, surface: null },
};

type Answer = { failure: boolean; surface: Surface; pFailure?: number; type?: TicketType; latencyMs?: number };

const pct = (x: number | null) => (x === null ? "n/a" : `${(x * 100).toFixed(0)}%`);
const f2 = (x: number | null) => (x === null ? "n/a" : x.toFixed(2));

function metrics(items: Labeled[], answers: Answer[]) {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  let areaRight = 0;
  let areaTotal = 0;
  items.forEach((item, i) => {
    const a = answers[i]!;
    if (a.failure && item.failure) tp++;
    else if (a.failure && !item.failure) fp++;
    else if (!a.failure && item.failure) fn++;
    else tn++;
    if (item.surface) {
      areaTotal++;
      if (a.surface === item.surface) areaRight++;
    }
  });
  const precision = tp + fp ? tp / (tp + fp) : null;
  const recall = tp + fn ? tp / (tp + fn) : null;
  const f1 = precision !== null && recall !== null && precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : null;
  return { precision, recall, f1, accuracy: (tp + tn) / items.length, area: areaTotal ? areaRight / areaTotal : null, areaTotal, fp, fn };
}

/** Brier score and expected calibration error (10 bins) of P(failure). */
function calibration(items: Labeled[], answers: Answer[]) {
  const pairs = items.map((item, i) => ({ p: answers[i]!.pFailure ?? 0, y: item.failure ? 1 : 0 }));
  const brier = pairs.reduce((s, x) => s + (x.p - x.y) ** 2, 0) / pairs.length;
  let ece = 0;
  for (let b = 0; b < 10; b++) {
    const bin = pairs.filter((x) => x.p >= b / 10 && (b === 9 ? x.p <= 1 : x.p < (b + 1) / 10));
    if (bin.length === 0) continue;
    const conf = bin.reduce((s, x) => s + x.p, 0) / bin.length;
    const acc = bin.reduce((s, x) => s + x.y, 0) / bin.length;
    ece += (bin.length / pairs.length) * Math.abs(conf - acc);
  }
  return { brier, ece };
}

const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))]! : null;
};

async function builtIn(items: Labeled[]): Promise<Answer[]> {
  const engine = new PatternEngine(embedder, policy.correlation);
  await engine.init();
  const answers: Answer[] = [];
  for (const [i, item] of items.entries()) {
    const signal = await engine.read({ id: `L-${i}`, customerRef: "x", customerName: "x", channel: "chat", body: item.text, source: "sandbox", receivedAt: T0 + i * 3_600_000 });
    answers.push({ failure: signal.isFailure, surface: signal.surface, ...(signal.ticketType ? { type: signal.ticketType } : {}) });
  }
  return answers;
}

/** Laya's answers, one call per distinct sentence. */
async function askLaya(texts: string[]): Promise<Map<string, ClassifierVerdict> | null> {
  const laya = new LayaClassifier({ baseUrl: LAYA_URL, timeoutMs: 20_000 });
  try {
    await laya.classify("warm-up");
  } catch {
    return null;
  }
  const answers = new Map<string, ClassifierVerdict>();
  for (const text of new Set(texts)) answers.set(text, await laya.classify(text));
  return answers;
}

/** What the engine does with Laya switched on: Laya's labels at or above the thresholds, the built-in ones below. */
async function combined(items: Labeled[], laya: Map<string, ClassifierVerdict>): Promise<Answer[]> {
  const engine = new PatternEngine(embedder, policy.correlation);
  await engine.init();
  const answers: Answer[] = [];
  for (const [i, item] of items.entries()) {
    const ticket: Ticket = { id: `C-${i}`, customerRef: "x", customerName: "x", channel: "chat", body: item.text, source: "sandbox", receivedAt: T0 + i * 3_600_000 };
    await engine.read(ticket);
    const s = engine.applyVerdict(ticket.id, laya.get(item.text)!, policy.classifier);
    answers.push({ failure: s.isFailure, surface: s.surface });
  }
  return answers;
}

/** Detection on the eval's held-out test runs, with an optional classifier verdict per ticket. */
async function detection(runs: EvalRun[], laya: Map<string, ClassifierVerdict> | null): Promise<Score> {
  const outcomes = [];
  for (const run of runs) {
    const engine = new PatternEngine(embedder, policy.correlation, { baselinePerHour: run.scenario.world.baselinePerHour });
    await engine.init();
    const tickets = scenarioTickets(run.scenario, T0);
    const opened: Opened[] = [];
    for (const t of tickets) {
      const verdict = laya?.get(t.body);
      const r = await engine.ingest(t, verdict, policy.classifier);
      if (r.fires && r.candidate) {
        engine.attachIncident(`I${opened.length}`, r.candidate.reportTicketIds);
        opened.push({ members: new Set(r.candidate.reportTicketIds), openedAt: t.receivedAt });
      } else if (r.joinIncidentId) {
        opened[Number(r.joinIncidentId.slice(1))]!.members.add(t.id);
      }
    }
    outcomes.push(toOutcome(run, tickets, new Set(run.labeled.map((i) => tickets[i]!.id)), opened));
  }
  return score(outcomes);
}

async function main() {
  const pools = loadPools();
  const items: Labeled[] = Object.entries(pools).flatMap(([pool, texts]) => (POOL_LABELS[pool] ? texts.map((text) => ({ text, pool, ...POOL_LABELS[pool]! })) : []));
  const base = await builtIn(items);
  const baseM = metrics(items, base);

  const testRuns = generateRuns(pools, 60).filter((r) => r.split === "test");
  const runTexts = testRuns.flatMap((r) => r.scenario.tickets.map((t) => t.body));
  const started = Date.now();
  const laya = await askLaya([...items.map((i) => i.text), ...runTexts]);
  const layaSeconds = (Date.now() - started) / 1000;

  const baseDetection = await detection(testRuns, null);
  let layaSection = `**Laya was not run:** no server answered at ${LAYA_URL}. Start one with \`pnpm laya\` and run \`pnpm eval:classifier\` again.`;
  let summary = "laya: not run";
  if (laya) {
    const layaAnswers: Answer[] = items.map((item) => {
      const v = laya.get(item.text)!;
      return { failure: v.ticketType.label === "failure", surface: v.surface.label, pFailure: v.ticketType.probabilities.failure ?? 0, type: v.ticketType.label, latencyMs: v.latencyMs };
    });
    const layaM = metrics(items, layaAnswers);
    const cal = calibration(items, layaAnswers);
    const both = metrics(items, await combined(items, laya));
    const layaDetection = await detection(testRuns, laya);
    const latencies = [...laya.values()].map((v) => v.latencyMs);
    const models = [...new Set([...laya.values()].map((v) => v.model ?? "routed"))].join(", ");
    const unsure = [...laya.values()].filter((v) => v.ticketType.confidence < policy.classifier.failureMin).length;
    const disagreements = items
      .map((item, i) => ({ item, base: base[i]!, laya: layaAnswers[i]! }))
      .filter((d) => d.base.failure !== d.laya.failure)
      .slice(0, 12);
    summary = `laya: failure F1 ${f2(layaM.f1)} area ${pct(layaM.area)} brier ${f2(cal.brier)} ece ${f2(cal.ece)}; combined F1 ${f2(both.f1)} area ${pct(both.area)}; detection F1 ${f2(layaDetection.f1)}`;
    layaSection = `Laya ran on this machine (\`laya-serve\`, the ${models} checkpoint): ${laya.size} distinct sentences in ${layaSeconds.toFixed(0)} s, median ${quantile(latencies, 0.5)} ms and p95 ${quantile(latencies, 0.95)} ms per ticket. ${unsure} of ${laya.size} answers were below the ${policy.classifier.failureMin} threshold, so the built-in answer stood for them.

### Ticket type and product area

| Classifier | Failure precision | Failure recall | Failure F1 | Accuracy | Product area |
|---|---|---|---|---|---|
| Built in (embedding prototypes) | ${pct(baseM.precision)} | ${pct(baseM.recall)} | ${f2(baseM.f1)} | ${pct(baseM.accuracy)} | ${pct(baseM.area)} |
| Laya alone, zero-shot | ${pct(layaM.precision)} | ${pct(layaM.recall)} | ${f2(layaM.f1)} | ${pct(layaM.accuracy)} | ${pct(layaM.area)} |
| **What the engine uses:** Laya above ${policy.classifier.failureMin} / ${policy.classifier.surfaceMin}, else built in | ${pct(both.precision)} | ${pct(both.recall)} | ${f2(both.f1)} | ${pct(both.accuracy)} | ${pct(both.area)} |

### Laya's probabilities

| Measure | Result |
|---|---|
| Brier score of P(failure) | ${f2(cal.brier)} (0 is perfect; always answering 0.5 scores 0.25) |
| Expected calibration error, 10 bins | ${f2(cal.ece)} |

Laya's own server warns that this checkpoint ships temperatures outside its valid range, and its authors advise refitting temperatures on your own labels before trusting confidences. So the thresholds in \`config/policy.json\` are the safety margin, not a calibrated cut-off.

### Detection end to end (held-out test runs)

| Classifier | Precision | Recall | F1 | Linking recall | Median latency |
|---|---|---|---|---|---|
| Built in | ${pct(baseDetection.precision)} | ${pct(baseDetection.recall)} | ${f2(baseDetection.f1)} | ${pct(baseDetection.linkRecall)} | ${baseDetection.medianLatencyTickets ?? "n/a"} complaints |
| With Laya | ${pct(layaDetection.precision)} | ${pct(layaDetection.recall)} | ${f2(layaDetection.f1)} | ${pct(layaDetection.linkRecall)} | ${layaDetection.medianLatencyTickets ?? "n/a"} complaints |

Similarity still comes from the embeddings, so the gates stay calibrated either way; Laya changes only the labels.

${disagreements.length ? `### Where the two disagree on "is it a failure?"\n\n| Sentence | Label | Built in | Laya (P failure) |\n|---|---|---|---|\n${disagreements.map((d) => `| ${d.item.text.replace(/\|/g, "/")} | ${d.item.failure ? "failure" : "not a failure"} | ${d.base.failure ? "failure" : "not"} | ${d.laya.failure ? "failure" : d.laya.type} (${f2(d.laya.pFailure ?? 0)}) |`).join("\n")}` : ""}`;
  }

  const date = new Date().toISOString().slice(0, 10);
  const doc = `# Classifier evaluation

Generated by \`pnpm eval:classifier\` on ${date}. ${items.length} labeled sentences from \`scenarios/pools/\`: ${items.filter((i) => i.failure).length} failure reports and ${items.filter((i) => !i.failure).length} questions or requests, ${items.filter((i) => i.surface).length} of them with a clear product area. Labels come from the pool each sentence was written for.

A classifier makes two bounded decisions per ticket: is it a failure report, a question or a request, and which product area is it about. The detection gates, not the classifier, decide whether an incident opens. Nothing a classifier says can call a tool.

## Built-in classifier

| Measure | Result |
|---|---|
| Failure precision | ${pct(baseM.precision)} |
| Failure recall | ${pct(baseM.recall)} |
| Failure F1 | ${f2(baseM.f1)} |
| Product area accuracy | ${pct(baseM.area)} of ${baseM.areaTotal} |
| Detection on the held-out test runs | precision ${pct(baseDetection.precision)}, recall ${pct(baseDetection.recall)} |

## Laya

${layaSection}

## Limits

- **Synthetic, hand-written sentences:** the pools were written for this project, and the built-in classifier's prototypes were tuned on similar sentences, so its numbers here are optimistic. Laya is zero-shot: it has never seen these labels.
- **English only:** Laya's multilingual checkpoint (\`LAYA_MODELS=multilingual\`) is the route for Hindi and Hinglish tickets; it isn't evaluated here.
`;
  writeFileSync(CLASSIFIER_EVAL_DOC, doc);
  console.log(`built-in: failure F1 ${f2(baseM.f1)} (P ${pct(baseM.precision)} R ${pct(baseM.recall)}), area ${pct(baseM.area)}; detection F1 ${f2(baseDetection.f1)}`);
  console.log(summary);
  console.log(`wrote ${CLASSIFIER_EVAL_DOC.pathname}`);
}

await main();

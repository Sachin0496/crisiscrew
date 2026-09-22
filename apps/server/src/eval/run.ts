/**
 * The evaluation: generated runs with labeled incidents, scored for
 * precision, recall, linking, latency and root-cause accuracy. Writes
 * docs/eval.md. Deterministic; loads no model (cached embeddings only).
 *
 *   pnpm eval
 */
import { CachedEmbedder, createSandboxPorts } from "@crisiscrew/adapters";
import type { CorrelationConfig, Policy, Ticket } from "@crisiscrew/contracts";
import { CrisisEngine, EventBus, ManualClock, PatternEngine } from "@crisiscrew/core";
import { writeFileSync } from "node:fs";
import { DEFAULT_EMBEDDING_MODEL } from "../config";
import { loadPools } from "../corpus";
import { EMBEDDING_CACHE_DIR, EVAL_DOC } from "../paths";
import { loadPolicy, scenarioTickets } from "../scenarios";
import { generateRuns, generateStressRuns, RUN_KINDS, type EvalRun, type RunKind } from "./generate";
import { score, type Outcome, type Score } from "./metrics";

const T0 = Date.UTC(2026, 8, 25, 14, 0, 0);
const THRESHOLDS = [0.45, 0.5, 0.55, 0.6, 0.65, 0.7];
const RUN_COUNT = 60;
const STRESS_COUNT = 20;

const embedder = new CachedEmbedder({ modelId: DEFAULT_EMBEDDING_MODEL, dir: EMBEDDING_CACHE_DIR, inner: null });

type Opened = { members: Set<string>; openedAt: number; rootCorrect?: boolean };

function toOutcome(run: EvalRun, tickets: Ticket[], labeledIds: Set<string>, opened: Opened[]): Outcome {
  const overlap = (o: Opened) => [...o.members].filter((id) => labeledIds.has(id)).length;
  const best = [...opened].sort((a, b) => overlap(b) - overlap(a))[0];
  const labeledTimes = tickets.filter((t) => labeledIds.has(t.id)).map((t) => t.receivedAt);
  return {
    kind: run.kind,
    expectedIncident: run.scenario.expected.incident,
    fired: Boolean(best),
    linkedLabeled: best ? overlap(best) : 0,
    linkedTotal: best ? best.members.size : 0,
    labeledTotal: labeledIds.size,
    ...(best && labeledTimes.length
      ? {
          latencyTickets: labeledTimes.filter((at) => at <= best.openedAt).length,
          latencySec: (best.openedAt - Math.min(...labeledTimes)) / 1000,
        }
      : {}),
    ...(best?.rootCorrect !== undefined ? { rootCorrect: best.rootCorrect } : {}),
    extraIncidents: Math.max(0, opened.length - 1),
  };
}

/** Detection only (the Pattern Agent), for sweeping thresholds quickly. */
async function detect(run: EvalRun, cfg: CorrelationConfig): Promise<Outcome> {
  const engine = new PatternEngine(embedder, cfg, { baselinePerHour: run.scenario.world.baselinePerHour });
  await engine.init();
  const tickets = scenarioTickets(run.scenario, T0);
  const opened: Opened[] = [];
  for (const t of tickets) {
    const r = await engine.ingest(t);
    if (r.fires && r.candidate) {
      engine.attachIncident(`I${opened.length}`, r.candidate.memberTicketIds);
      opened.push({ members: new Set(r.candidate.memberTicketIds), openedAt: t.receivedAt });
    } else if (r.joinIncidentId) {
      opened[Number(r.joinIncidentId.slice(1))]!.members.add(t.id);
    }
  }
  return toOutcome(run, tickets, new Set(run.labeled.map((i) => tickets[i]!.id)), opened);
}

/** The whole engine: every agent, the policy gate and root-cause scoring. */
async function lifecycle(run: EvalRun, policy: Policy): Promise<Outcome> {
  const clock = new ManualClock(T0);
  const engine = new CrisisEngine({
    ports: createSandboxPorts(run.scenario, { t0: T0, clock, latencyMs: 0 }),
    embedder,
    clock,
    policy,
    bus: new EventBus(),
    baselinePerHour: run.scenario.world.baselinePerHour,
    session: { sessionId: run.id, mode: "replay", scenarioId: run.id, speed: 1 },
  });
  await engine.init();
  const tickets = scenarioTickets(run.scenario, T0);
  for (const t of tickets) {
    clock.set(t.receivedAt);
    await engine.ingest({ customerRef: t.customerRef, customerName: t.customerName, channel: t.channel, body: t.body, receivedAt: t.receivedAt });
    await engine.whenIdle();
  }
  const state = engine.snapshot();
  // The engine numbers tickets T-1001, T-1002, … in arrival order.
  const engineTickets = tickets.map((t, i) => ({ ...t, id: `T-${1001 + i}` }));
  const opened = state.incidentOrder.map((id) => {
    const incident = state.incidents[id]!;
    return {
      members: new Set([...incident.ticketIds, ...incident.linkedTicketIds]),
      openedAt: incident.openedAt,
      rootCorrect: incident.rootCause?.hypothesisId === run.scenario.expected.rootCause,
    };
  });
  return toOutcome(run, engineTickets, new Set(run.labeled.map((i) => `T-${1001 + i}`)), opened);
}

const pct = (x: number | null) => (x === null ? "n/a" : `${(x * 100).toFixed(0)}%`);
const f2 = (x: number | null) => (x === null ? "n/a" : x.toFixed(2));

const KIND_LABELS: Record<RunKind, string> = {
  checkout_release: "Checkout release bug",
  upi_outage: "UPI provider outage",
  login_otp: "Login OTP outage",
  quiet: "Quiet hour",
  lookalike: "Look-alike questions",
  scattered: "Scattered failures",
  stress_delivery_mix: "Different delivery problems",
};

async function main() {
  const policy = loadPolicy();
  const pools = loadPools();
  const runs = generateRuns(pools, RUN_COUNT);
  const tune = runs.filter((r) => r.split === "tune");
  const test = runs.filter((r) => r.split === "test");

  const sweep: { threshold: number; tune: Score; test: Score }[] = [];
  for (const threshold of THRESHOLDS) {
    const cfg = { ...policy.correlation, cohesionMin: threshold };
    const t = await Promise.all(tune.map((r) => detect(r, cfg)));
    const s = await Promise.all(test.map((r) => detect(r, cfg)));
    sweep.push({ threshold, tune: score(t), test: score(s) });
  }
  const configured = policy.correlation.cohesionMin;
  const bestTune = [...sweep].sort(
    (a, b) => (b.tune.f1 ?? -1) - (a.tune.f1 ?? -1) || Math.abs(a.threshold - configured) - Math.abs(b.threshold - configured),
  )[0]!;

  const outcomes: Outcome[] = [];
  for (const run of test) outcomes.push(await lifecycle(run, policy));
  const headline = score(outcomes);

  const stress = generateStressRuns(pools, STRESS_COUNT);
  const stressOutcomes = await Promise.all(stress.map((r) => detect(r, policy.correlation)));
  const stressFired = stressOutcomes.filter((o) => o.fired).length;
  const stressPool = pools["stress-delivery-mix"] ?? [];
  const stressBySize = [4, 5, 6].map((n) => {
    const at = stress.flatMap((r, i) => (r.scenario.tickets.filter((t) => stressPool.includes(t.body)).length === n ? [i] : []));
    return { n, runs: at.length, fired: at.filter((i) => stressOutcomes[i]!.fired).length };
  });

  const byKind = RUN_KINDS.map((kind) => {
    const os = outcomes.filter((o) => o.kind === kind);
    const s = score(os);
    return { kind, runs: os.length, expected: os[0]?.expectedIncident ?? false, fired: os.filter((o) => o.fired).length, caught: s.tp, rootCorrect: os.filter((o) => o.rootCorrect).length };
  });

  const date = new Date().toISOString().slice(0, 10);
  const doc = `# Evaluation

Generated by \`pnpm eval\` on ${date}, with \`${DEFAULT_EMBEDDING_MODEL}\` and the thresholds in \`config/policy.json\`. The runs are seeded, so the same command gives the same numbers. No model is loaded: every text is read from the committed embedding cache.

## What was tested

- **${RUN_COUNT} generated runs**, ${RUN_COUNT / RUN_KINDS.length} of each kind below. Each is an hour of ordinary support traffic (12 questions and requests at random times) plus one of:
  - **checkout release bug:** 4 to 7 checkout failure reports within 1 to 3 minutes, after a faulty checkout release
  - **UPI provider outage:** 4 to 7 UPI failure reports, with the payment provider degraded and no recent release
  - **login OTP outage:** 4 to 7 login failures, after a faulty release of the auth service
  - **quiet hour:** just the ordinary traffic plus 2 unrelated failures
  - **look-alike questions:** 5 or 6 questions about paying at checkout within 8 minutes
  - **scattered failures:** 5 real failures within 10 minutes, each about a different product area
- **Labels:** the first three kinds contain one labeled incident; the other three contain none. A run counts as caught when an incident opens covering at least half of the labeled complaints. An incident opened on the wrong tickets counts as both a false alarm and a miss, and every extra incident counts as a false alarm.
- **Held-out split:** every paraphrase pool is split in half by sentence. Tuning runs draw from one half and test runs from the other, so no sentence used to tune appears in the test. Every kind has five runs in each split. (The stress test below tunes nothing, so it draws from its whole pool.)
- **Honest scope:** the ${Object.values(pools).reduce((n, p) => n + p.length, 0)} sentences in \`scenarios/pools/\` are hand-written, synthetic support tickets, not production traffic.

## Headline: test split, full engine, configured thresholds

Every agent runs, through the policy gate, with root-cause scoring.

| Measure | Result |
|---|---|
| Incident precision | ${pct(headline.precision)} (${headline.tp} of ${headline.tp + headline.fp} incidents opened were real) |
| Incident recall | ${pct(headline.recall)} (${headline.tp} of ${headline.tp + headline.fn} real incidents caught) |
| Linking precision | ${pct(headline.linkPrecision)} of tickets in a caught incident were labeled complaints |
| Linking recall | ${pct(headline.linkRecall)} of labeled complaints ended up in the incident |
| Median detection latency | ${headline.medianLatencyTickets ?? "n/a"} complaints, ${headline.medianLatencySec === null ? "n/a" : `${Math.round(headline.medianLatencySec)} seconds`} after the first |
| Root cause correct | ${pct(headline.rootAccuracy)} of caught incidents named the true cause |

## By kind (test split)

| Kind | Runs | Should open an incident | Opened one | Caught | Root cause correct |
|---|---|---|---|---|---|
${byKind.map((k) => `| ${KIND_LABELS[k.kind]} | ${k.runs} | ${k.expected ? "yes" : "no"} | ${k.fired} | ${k.expected ? k.caught : "–"} | ${k.expected ? k.rootCorrect : "–"} |`).join("\n")}

## Similarity threshold sweep (detection only)

The cohesion gate's threshold is swept on both splits; the other gates stay as configured.

| Threshold | Tune precision | Tune recall | Tune F1 | Test precision | Test recall | Test F1 |
|---|---|---|---|---|---|---|
${sweep.map((s) => `| ${s.threshold.toFixed(2)}${s.threshold === configured ? " (configured)" : ""} | ${pct(s.tune.precision)} | ${pct(s.tune.recall)} | ${f2(s.tune.f1)} | ${pct(s.test.precision)} | ${pct(s.test.recall)} | ${f2(s.test.f1)} |`).join("\n")}

The tuning split's best threshold is ${bestTune.threshold.toFixed(2)} (F1 ${f2(bestTune.tune.f1)}); on the held-out test split that threshold scores F1 ${f2(bestTune.test.f1)}. The configured threshold is ${configured.toFixed(2)}.${
    bestTune.threshold === configured ? " They agree, so the configuration stands." : " The configuration was not changed automatically; this table is the evidence for choosing."
  }

## Stress test: different delivery problems in one area

A known hard case, reported separately because its label is debatable: ${STRESS_COUNT} runs, each with 4 to 6 *different* delivery complaints within 10 minutes, drawn from ${stressPool.length} distinct problems (marked delivered but missing, days late, sent to the wrong address, arrived opened, a failed return pickup and so on). Because product area counts for half of similarity, complaints about the same area look alike even when the problems differ.

**Result:** an incident opened in ${stressFired} of ${STRESS_COUNT} runs.${stressFired > 0 ? " When several different problems hit one area at once, the Pattern Agent can treat them as one incident. That's defensible for a delivery-partner outage, and a false alarm otherwise. The fix on the roadmap is learning thresholds per product area from confirmed and rejected incidents." : ""}

| Complaints in the run | Runs | Incident opened |
|---|---|---|
${stressBySize.map((b) => `| ${b.n} | ${b.runs} | ${b.fired} |`).join("\n")}

## Limits

- **Synthetic data:** the numbers show the method works on clear, hand-written cases; real traffic is messier.
- **Small scale:** ${RUN_COUNT} runs, so one miss moves a percentage by several points.
- **English only:** the embedding model is English-only. Hindi and Hinglish complaints are future work (with Sarvam translation).
- **Uncalibrated root cause:** root-cause confidence comes from the uncalibrated priors and likelihood ratios in \`config/policy.json\`. Accuracy here means the top-ranked cause was the true one, not that its percentage is calibrated.
`;
  writeFileSync(EVAL_DOC, doc);

  console.log(`headline (test, full engine): precision ${pct(headline.precision)} recall ${pct(headline.recall)} link P ${pct(headline.linkPrecision)} R ${pct(headline.linkRecall)} latency ${headline.medianLatencyTickets} tickets / ${headline.medianLatencySec}s root ${pct(headline.rootAccuracy)}`);
  for (const k of byKind) console.log(`  ${k.kind.padEnd(18)} runs ${k.runs} fired ${k.fired} caught ${k.caught} root ${k.rootCorrect}`);
  for (const s of sweep) console.log(`  t=${s.threshold.toFixed(2)} tune F1 ${f2(s.tune.f1)} (P ${pct(s.tune.precision)} R ${pct(s.tune.recall)})  test F1 ${f2(s.test.f1)} (P ${pct(s.test.precision)} R ${pct(s.test.recall)})`);
  console.log(`stress: fired ${stressFired}/${STRESS_COUNT} (${stressBySize.map((b) => `${b.n} complaints ${b.fired}/${b.runs}`).join(", ")})`);
  console.log(`wrote ${EVAL_DOC.pathname}`);
}

await main();
